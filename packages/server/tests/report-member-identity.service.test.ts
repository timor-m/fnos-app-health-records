import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  assessReportMemberIdentity,
  assignReportMember,
  dismissReportMemberIdentity,
  patientAgeFromOcrText,
  patientBirthDateFromOcrText,
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
  /* 成员年龄与报告年龄一致时不提醒 */
  await withDatabase(
    ({ reportId }) => {
      const db = getDatabase();
      db.exec(
        "UPDATE reports SET sampled_at = '2026-07-23 18:17:00' WHERE id = 'report'",
      );
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    {
      memberSex: null,
      memberBirthDate: "2026-01-20",
      ocrLines: childReportOcr,
    },
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

test("stays silent when member profile matches or lacks identity fields", async () => {
  await withDatabase(
    ({ reportId }) => {
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    { memberSex: "male", memberBirthDate: "1985-03-12" },
  );
  await withDatabase(
    ({ reportId }) => {
      assert.equal(assessReportMemberIdentity(manager, reportId), null);
    },
    { memberSex: null, memberBirthDate: null },
  );
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
