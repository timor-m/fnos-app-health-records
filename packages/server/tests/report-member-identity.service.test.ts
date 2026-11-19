import {linkProcessRecords,recordProcesses,getRecordProcess} from '../services/health-record-process.service';
import { createVaccination,getVaccination } from '../services/vaccination.service';
import { createHealthEpisode } from '../services/health-episode.service';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { patientSexFromOcrText } from "../services/ai-input-planner.service.ts";
import {
  assessReportMemberIdentity,
  assignReportMember,
  dismissReportMemberIdentity,
  patientAgeFromOcrText,
  patientBirthDateFromOcrText,
  patientNameFromOcrText,
} from "../services/report-member-identity.service.ts";

const manager: RequestUser = {
  id: "identity-manager",
  displayName: "管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

function ocrLinesJson(lines: string[]) {
  return JSON.stringify(lines.map((text, index) => ({ id: `line_${index}`, text })));
}

async function withDatabase(
  run: (context: { reportId: string }) => Promise<void> | void,
  options: {
    memberSex?: string | null;
    memberBirthDate?: string | null;
    ocrLines?: string[];
  } = {},
) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-member-identity-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    const memberSex =
      options.memberSex === undefined ? "female" : options.memberSex;
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('identity-manager', '管理员');
      INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
      VALUES ('member-self', '本人', 'self', ${memberSex ? `'${memberSex}'` : "NULL"}, ${
        options.memberBirthDate ? `'${options.memberBirthDate}'` : "NULL"
      }, 'identity-manager');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member-self', 'identity-manager', 'manager', 'identity-manager');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member-self', 'identity-manager', 'checkup', '体检报告', 'needs_review');
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, mime_type, storage_path, file_size, sha256
      ) VALUES ('page-1', 'report', 1, '1.png', 'image/png', 'reports/1.png', 1, 'hash-1');
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES ('ocr-job', 'report', 'page-1', 'ocr', 'completed', 'unit-test', 'ocr-key');
    `);
    db.prepare(
      `
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json, text_length)
      VALUES ('ocr-1', 'ocr-job', 'page-1', 'test', 'test-v1', ?, ?)
    `,
    ).run(
      ocrLinesJson(
        options.ocrLines ?? [
          "某健康体检中心",
          "姓名：张三 性别：男 年龄：40岁",
          "出生日期：1985-03-12",
        ],
      ),
      128,
    );
    await run({ reportId: "report" });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("extracts birth date only next to an explicit label", () => {
  assert.equal(
    patientBirthDateFromOcrText([ocrLinesJson(["出生日期：1985-03-12"])]),
    "1985-03-12",
  );
  assert.equal(
    patientBirthDateFromOcrText([ocrLinesJson(["出生日期 1985年3月12日"])]),
    "1985-03-12",
  );
  /* 独立出现的日期不猜（可能是检查日期或报告日期） */
  assert.equal(
    patientBirthDateFromOcrText([ocrLinesJson(["检查日期：2025-07-12"])]),
    null,
  );
  assert.equal(
    patientBirthDateFromOcrText([ocrLinesJson(["2025-07-12 报告"])]),
    null,
  );
});

test("extracts patient age only next to an explicit label", () => {
  assert.deepEqual(patientAgeFromOcrText([ocrLinesJson(["年龄：6个月"])]), {
    months: 6,
    toleranceMonths: 2,
    text: "6个月",
  });
  assert.deepEqual(patientAgeFromOcrText([ocrLinesJson(["年龄：40岁"])]), {
    months: 480,
    toleranceMonths: 13,
    text: "40岁",
  });
  /* OCR 丢字后的“龄：6个月”同样采信 */
  assert.deepEqual(patientAgeFromOcrText([ocrLinesJson(["龄：6个月"])]), {
    months: 6,
    toleranceMonths: 2,
    text: "6个月",
  });
  /* 没有年龄标签的叙述不猜 */
  assert.equal(patientAgeFromOcrText([ocrLinesJson(["建议3个月后复查"])]), null);
  assert.equal(patientAgeFromOcrText([ocrLinesJson(["工龄：5年"])]), null);
});

test("flags age mismatch for age-only reports and suggests age-matched members", async () => {
  const childReportOcr = [
    "济南千麦医学检验实验室检验报告单",
    "姓名：杨璟宸",
    "龄：6个月",
  ];
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(`
        UPDATE reports SET sampled_at = '2026-07-23 18:17:00' WHERE id = 'report';
        INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
        VALUES ('member-baby', '宝宝', 'child', NULL, '2026-01-10', 'identity-manager');
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('member-baby', 'identity-manager', 'manager', 'identity-manager');
      `);
      const assessment = assessReportMemberIdentity(manager, reportId);
      assert.ok(assessment);
      assert.deepEqual(assessment.mismatchedFields, ["birthDate"]);
      assert.equal(assessment.patientAgeText, "6个月");
      /* 采样日期 2026-07-23 倒退 6 个月，近似出生日期带入创建表单 */
      assert.equal(assessment.patientApproxBirthDate, "2026-01-23");
      assert.deepEqual(
        assessment.candidates.map((candidate) => candidate.displayName),
        ["宝宝"],
      );
    },
    {
      memberSex: null,
      memberBirthDate: "1990-01-01",
      ocrLines: childReportOcr,
    },
  );
  /* 年龄一致不能抹掉姓名差异（成员可能使用昵称）。 */
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(
        "UPDATE reports SET sampled_at = '2026-07-23 18:17:00' WHERE id = 'report'",
      );
      assert.deepEqual(assessReportMemberIdentity(manager, reportId)?.mismatchedFields, ["name"]);
    },
    {
      memberSex: null,
      memberBirthDate: "2026-01-20",
      ocrLines: childReportOcr,
    },
  );
});

test("extracts patient name only next to an explicit label", () => {
  assert.equal(
    patientNameFromOcrText([ocrLinesJson(["姓名：杨璟宸"])]),
    "杨璟宸",
  );
  /* 空值、OCR 噪声、无标签提及都不采信 */
  assert.equal(patientNameFromOcrText([ocrLinesJson(["姓名："])]), null);
  assert.equal(patientNameFromOcrText([ocrLinesJson(["姓名：张3"])]), null);
  assert.equal(patientNameFromOcrText([ocrLinesJson(["患者姓名一栏"])]), null);
  for (const lines of [["用药人：李小明"], ["患 者 姓 名：李小明"], ["姓 名：李小明"], ["姓名：", "李小明"]]) {
    assert.equal(patientNameFromOcrText([ocrLinesJson(lines)]), "李小明");
  }
  for (const lines of [["姓名：", "性别：男"], ["医生：李小明"], ["医生姓名：李小明"], ["药师姓名：李小明"], ["联系人姓名：李小明"], ["李小明"], ["姓名：", "处方医师"]]) {
    assert.equal(patientNameFromOcrText([ocrLinesJson(lines)]), null);
  }
});

test("split identity labels are joined locally only within one OCR field", () => {
  const raw = [
    {text:'姓',box:[10,10,30,30]}, {text:'名：李小明',box:[70,10,190,30]},
    {text:'性',box:[10,50,30,70]}, {text:'别：女',box:[70,50,130,70]},
  ];
  for (const sideways of [false,true]) {
    const lines=raw.map(line=>({...line,box:sideways
      ? [line.box[1],220-line.box[2],line.box[3],220-line.box[0]] : line.box}));
    const original=JSON.stringify(lines);
    assert.equal(patientNameFromOcrText([original]),'李小明');
    assert.equal(patientSexFromOcrText([original]),'female');
    assert.equal(JSON.stringify(lines),original,'identity reading must not rewrite source OCR');
  }
  assert.equal(patientNameFromOcrText([ocrLinesJson(['姓','名：李小明'])]),'李小明');
  assert.equal(patientSexFromOcrText([ocrLinesJson(['性','别：','女'])]),'female');
  assert.equal(patientSexFromOcrText([ocrLinesJson(['性 别：女'])]),'female');
  for (const replacement of [{text:'名：李小明',box:[70,110,190,130]}, {text:'名：李小明',box:[1000,10,1120,30]}]) {
    assert.equal(patientNameFromOcrText([JSON.stringify([raw[0],replacement])]),null);
  }
  for (const role of ['医生','药师','发药人','调剂人','联系人','家属','监护人']) {
    assert.equal(patientNameFromOcrText([ocrLinesJson([role,'姓','名：李小明'])]),null);
  }
  assert.equal(patientNameFromOcrText([ocrLinesJson(['姓','科室：内科','名：李小明'])]),null);
  assert.equal(patientNameFromOcrText([ocrLinesJson(['姓名：','','李小明'])]),null);
});

test("split identity labels participate in member assessment without rerunning extraction",async()=>{
  await withDatabase(({reportId})=>{
    const assessment=assessReportMemberIdentity(manager,reportId);
    assert.equal(assessment?.patientName,'李小明');
    assert.equal(assessment?.patientSex,'female');
    assert.deepEqual(assessment?.mismatchedFields,['name']);
    assert.equal(assessment?.verificationIncomplete,false);
  },{memberSex:null,memberBirthDate:null,ocrLines:['姓','名：李小明','性','别：女','龄：35岁']});
});

test("manual reassignment rejects targets with viewer permission or no access",async()=>{
  await withDatabase(({reportId})=>{
    const db=getDatabase();
    db.exec(`INSERT INTO health_members(id,display_name,created_by) VALUES('target','合成成员','identity-manager');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('target','identity-manager','viewer','identity-manager');`);
    assert.throws(()=>assignReportMember(manager,reportId,{memberId:'target'}),{statusCode:403});
    db.prepare("DELETE FROM member_permissions WHERE member_id='target'").run();
    assert.throws(()=>assignReportMember(manager,reportId,{memberId:'target'}),{statusCode:403});
    assert.equal(db.prepare('SELECT member_id FROM reports WHERE id=?').get(reportId)?.member_id,'member-self');
  });
});

test("suggests members whose display name matches the patient name", async () => {
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(`
        INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
        VALUES ('member-namesake', '张三', 'child', NULL, NULL, 'identity-manager');
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('member-namesake', 'identity-manager', 'manager', 'identity-manager');
      `);
      const assessment = assessReportMemberIdentity(manager, reportId);
      assert.ok(assessment);
      assert.equal(assessment.patientName, "张三");
      assert.deepEqual(
        assessment.candidates.map((candidate) => candidate.displayName),
        ["张三"],
      );
    },
    { memberSex: "female" },
  );
});

/*
 * 报告按身份证登记、成员档案的出生日期/性别可能凭记忆填写：
 * 患者姓名与当前成员档案名一致时视为同一人，不再提醒。
 */
test("stays silent when the patient name matches the current member", async () => {
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec("UPDATE health_members SET display_name = '张三' WHERE id = 'member-self'");
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    { memberSex: "female", memberBirthDate: "1990-01-01" },
  );
  /* 姓名一致时性别冲突同样豁免（档案性别可能填错或 OCR 误读） */
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec("UPDATE health_members SET display_name = '张三' WHERE id = 'member-self'");
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    { memberSex: "female", memberBirthDate: null },
  );
});

test("flags sex mismatch without birth date candidates", async () => {
  await withDatabase(
    ({ reportId }) => {
      const assessment = assessReportMemberIdentity(manager, reportId);
      assert.ok(assessment);
      assert.deepEqual(assessment.mismatchedFields, ["sex", "birthDate"]);
      assert.equal(assessment.patientSex, "male");
      assert.equal(assessment.patientBirthDate, "1985-03-12");
      /* 有精确出生日期时不给近似值，避免两个日期并存造成困惑 */
      assert.equal(assessment.patientApproxBirthDate, null);
      assert.equal(assessment.candidates.length, 0);
    },
    { memberSex: "female", memberBirthDate: "1990-01-01" },
  );
});

test("suggests members whose birth date matches the patient exactly", async () => {
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(`
        INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
        VALUES ('member-spouse', '配偶', 'spouse', 'male', '1985-03-12', 'identity-manager');
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('member-spouse', 'identity-manager', 'manager', 'identity-manager');
        INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
        VALUES ('member-other', '其他', 'other', 'male', '1980-05-06', 'identity-manager');
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('member-other', 'identity-manager', 'manager', 'identity-manager');
      `);
      const assessment = assessReportMemberIdentity(manager, reportId);
      assert.ok(assessment);
      assert.equal(assessment.candidates.length, 1);
      assert.equal(assessment.candidates[0]?.displayName, "配偶");
    },
    { memberSex: "female", memberBirthDate: null },
  );
});

test("name differences request confirmation even with matching or missing demographic fields", async () => {
  await withDatabase(
    ({ reportId }) => {
      assert.deepEqual(assessReportMemberIdentity(manager, reportId)?.mismatchedFields, ["name"]);
    },
    { memberSex: "male", memberBirthDate: "1985-03-12" },
  );
  await withDatabase(
    ({ reportId }) => {
      const assessment = assessReportMemberIdentity(manager, reportId);
      assert.deepEqual(assessment?.mismatchedFields, ["name"]);
      assert.equal(assessment?.verificationIncomplete, false);
    },
    { memberSex: null, memberBirthDate: null },
  );
});

test("missing OCR name and incomplete member profile request verification without claiming a conflict", async () => {
  await withDatabase(({ reportId }) => {
    getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id=?").run(reportId);
    const assessment=assessReportMemberIdentity(manager,reportId);
    assert.ok(assessment);
    assert.equal(assessment.patientName,null);
    assert.equal(assessment.verificationIncomplete,true);
    assert.deepEqual(assessment.mismatchedFields,[]);
    dismissReportMemberIdentity(manager,reportId);
    assert.equal(assessReportMemberIdentity(manager,reportId),null);
  },{memberSex:null,memberBirthDate:null,ocrLines:["药材调剂单（代煎）","龄：35岁"]});
  await withDatabase(({ reportId }) => {
    assert.equal(assessReportMemberIdentity(manager,reportId),null);
  },{memberSex:null,memberBirthDate:null,ocrLines:["药材调剂单（代煎）","合成药材 8g"]});
  await withDatabase(({ reportId }) => {
    assert.equal(assessReportMemberIdentity(manager,reportId),null);
  },{memberSex:"female",memberBirthDate:null,ocrLines:["性别：女","年龄：35岁"]});
});

test("name-only dispensing identity works without member demographics and can be confirmed", async () => {
  await withDatabase(({reportId})=>{
    const assessment=assessReportMemberIdentity(manager,reportId);
    assert.equal(assessment?.patientName,"李小明");
    assert.deepEqual(assessment?.mismatchedFields,["name"]);
    assert.equal(assessment?.verificationIncomplete,false);
    dismissReportMemberIdentity(manager,reportId);
    assert.equal(assessReportMemberIdentity(manager,reportId),null);
  },{memberSex:null,memberBirthDate:null,ocrLines:["用药人：李小明"]});
});

test("member verification uses the latest OCR for each source page", async () => {
  await withDatabase(({reportId})=>{
    const db=getDatabase();
    db.prepare("UPDATE health_members SET display_name='李小明' WHERE id='member-self'").run();
    db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES('ocr-new',?,'page-1','ocr','completed','unit-test','ocr-new')").run(reportId);
    db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,text_length) VALUES('new','ocr-new','page-1','test','test',?,10)")
      .run(ocrLinesJson(["用药人：李小明"]));
    assert.equal(assessReportMemberIdentity(manager,reportId),null);
  },{memberSex:null,memberBirthDate:null});
});

test("dismissal hides the assessment until the report is reassigned", async () => {
  await withDatabase(
    ({ reportId }) => {
      dismissReportMemberIdentity(manager, reportId);
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    { memberSex: "female" },
  );
});

test("assigns the report to another member and clears stale blood type source", async () => {
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(`
        INSERT INTO health_members (id, display_name, relationship, sex, birth_date, created_by)
        VALUES ('member-target', '父亲', 'parent', 'male', '1985-03-12', 'identity-manager');
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('member-target', 'identity-manager', 'manager', 'identity-manager');
        UPDATE health_members SET blood_type_abo = 'A', blood_type_rh = 'positive',
          blood_type_source_report_id = 'report' WHERE id = 'member-self';
        INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
        VALUES ('notice-1', 'member-self', 'report', 'report_failed', 't', 'm', 'warning');
      `);
      const result = assignReportMember(manager, reportId, { memberId: "member-target" });
      assert.equal(result.memberId, "member-target");
      assert.equal(
        (db.prepare("SELECT member_id AS m FROM reports WHERE id = 'report'").get() as { m: string }).m,
        "member-target",
      );
      const oldMember = db
        .prepare(
          "SELECT blood_type_abo AS abo, blood_type_source_report_id AS source FROM health_members WHERE id = 'member-self'",
        )
        .get() as { abo: string | null; source: string | null };
      assert.equal(oldMember.abo, null);
      assert.equal(oldMember.source, null);
      assert.equal(
        (db.prepare("SELECT member_id AS m FROM app_notifications WHERE id = 'notice-1'").get() as { m: string }).m,
        "member-target",
      );
      // A relationship label still needs explicit confirmation after reassignment.
      assert.deepEqual(assessReportMemberIdentity(manager, reportId)?.mismatchedFields, ["name"]);
      dismissReportMemberIdentity(manager, reportId);
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
      assert.throws(
        () => assignReportMember(manager, reportId, { memberId: "member-target" }),
        /已归属该成员/,
      );
    },
    { memberSex: "female" },
  );
});

test("creates a new member and assigns the report in one step", async () => {
  await withDatabase(
    ({ reportId }) => {
      const result = assignReportMember(manager, reportId, {
        newMember: {
          displayName: "父亲",
          relationship: "parent",
          sex: "male",
          birthDate: "1985-03-12",
        },
      });
      const db = getDatabase();
      const member = db
        .prepare(
          "SELECT display_name AS name, sex, birth_date AS birthDate FROM health_members WHERE id = ?",
        )
        .get(result.memberId) as { name: string; sex: string; birthDate: string };
      assert.deepEqual(
        { ...member },
        { name: "父亲", sex: "male", birthDate: "1985-03-12" },
      );
      assert.equal(
        (db.prepare("SELECT member_id AS m FROM reports WHERE id = 'report'").get() as { m: string }).m,
        result.memberId,
      );
    },
    { memberSex: "female" },
  );
});

test('member reassignment detaches old clinical context while preserving confirmed medication and manual reminders', async () => {
  await withDatabase(({reportId})=>{
    const db=getDatabase();
    db.exec(`
      INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('member-target','Synthetic','parent','identity-manager');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member-target','identity-manager','manager','identity-manager');
      INSERT INTO health_events(id,member_id,event_type,title,created_by) VALUES('old-event','member-self','outpatient','Synthetic','identity-manager');
      INSERT INTO health_event_resources(id,event_id,resource_type,resource_id,relation_type,created_by) VALUES('old-link','old-event','report','report','primary','identity-manager');
      INSERT INTO health_upload_items(report_id,context_json,state,event_id) VALUES('report','{}','archived','old-event');
      INSERT INTO medication_courses(id,member_id,medication_name,status,started_at,last_changed_at,source_report_id,source_medication_id,source_snapshot_json,created_by)
        VALUES('course','member-self','Synthetic','active','2026-10-01','2026-10-01','report','source-medication','{"medicationName":"Synthetic"}','identity-manager');
      INSERT INTO reminders(id,member_id,report_id,title,due_at,status,source,created_by) VALUES
        ('suggested','member-self','report','Synthetic','2026-11-01','completed','report_suggestion','identity-manager'),
        ('manual','member-self','report','Synthetic','2026-11-01','pending','manual','identity-manager');
    `);
    const process=createHealthEpisode(manager,{memberId:'member-self',episodeType:'other',title:'合成原过程'});
    const vaccination=createVaccination(manager,{memberId:'member-self',vaccineName:'合成原接种',administeredAt:'2026-01-01',sourceReportId:reportId,episodeId:process.id});
    linkProcessRecords(manager,{kind:'report',id:reportId},[{kind:'vaccination',id:vaccination.id}]);
    const result=assignReportMember(manager,reportId,{memberId:'member-target'});
    assert.equal(getVaccination(manager,vaccination.id).memberId,'member-self');
    assert.equal(getVaccination(manager,vaccination.id).sourceReportId,null);
    assert.equal(getVaccination(manager,vaccination.id).vaccineName,'合成原接种');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_record_links').get()?.n,0);
    assert.equal(result.memberId,'member-target');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_event_resources WHERE resource_id='report'").get()!.n,0);
    assert.equal(db.prepare("SELECT member_id FROM health_events WHERE id='old-event'").get()!.member_id,'member-self');
    assert.deepEqual({...db.prepare("SELECT state,context_json,event_id FROM health_upload_items WHERE report_id='report'").get()}, {state:'pending',context_json:'{}',event_id:null});
    assert.deepEqual({...db.prepare("SELECT member_id,source_report_id,source_medication_id,source_snapshot_json,status FROM medication_courses WHERE id='course'").get()},
      {member_id:'member-self',source_report_id:null,source_medication_id:null,source_snapshot_json:'{"medicationName":"Synthetic"}',status:'active'});
    assert.deepEqual({...db.prepare("SELECT member_id,report_id,status FROM reminders WHERE id='suggested'").get()}, {member_id:'member-target',report_id:'report',status:'completed'});
    assert.deepEqual({...db.prepare("SELECT member_id,report_id,status FROM reminders WHERE id='manual'").get()}, {member_id:'member-self',report_id:null,status:'pending'});
    const audit=JSON.parse(String(db.prepare("SELECT detail_json FROM audit_logs WHERE action='report.member.assign'").get()!.detail_json));
    assert.deepEqual(audit.detachedMedicationCourseIds,['course']);assert.deepEqual(audit.movedReminderIds,['suggested']);
  });
});

test('new-member assignment rolls back the new member, permissions, audit and detached links on failure', async () => {
  await withDatabase(({reportId})=>{
    const db=getDatabase();
    db.exec(`
      INSERT INTO health_events(id,member_id,event_type,created_by) VALUES('rollback-event','member-self','outpatient','identity-manager');
      INSERT INTO health_event_resources(id,event_id,resource_type,resource_id,relation_type,created_by) VALUES('rollback-link','rollback-event','report','report','primary','identity-manager');
      CREATE TEMP TRIGGER fail_member_assignment BEFORE UPDATE OF member_id ON reports BEGIN SELECT RAISE(ABORT,'synthetic assignment failure'); END;
    `);
    const count=(table:string)=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
    const before=[count('health_members'),count('member_permissions'),count('audit_logs')];
    assert.throws(()=>assignReportMember(manager,reportId,{newMember:{displayName:'Synthetic',relationship:'parent'}}),/synthetic assignment failure/);
    assert.deepEqual([count('health_members'),count('member_permissions'),count('audit_logs')],before);
    assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report'").get()!.member_id,'member-self');
    assert.equal(db.prepare("SELECT event_id FROM health_event_resources WHERE id='rollback-link'").get()!.event_id,'rollback-event');
  });
});
