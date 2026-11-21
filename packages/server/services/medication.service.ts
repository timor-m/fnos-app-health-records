import { parseMedicationFormula } from '../../shared/medication-formula';
import {associateMedicationSelections} from './health-record-association.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { dateInput, enumInput, hasInput, localToday, textInput } from './health-event-input';
import { medicationActions, type HistoricalMedication, type MedicationAction, type MedicationContext,
  type MedicationCourse, type MedicationDocument, type MedicationFields, type MedicationIntake, type MedicationOverview,
  type MedicationSource, type MedicationStatus } from '../../shared/medications';

type Input = Record<string, unknown>;
const courseColumns = `id,member_id AS memberId,medication_name AS medicationName,specification,dosage_form AS dosageForm,dose,dose_unit AS doseUnit,
  frequency,route,instructions,status,started_at AS startedAt,last_changed_at AS lastChangedAt,
  stopped_at AS stoppedAt,revision,source_report_id AS sourceReportId,source_snapshot_json AS sourceJson`;
const intakeColumns = `id,member_id AS memberId,course_id AS courseId,medication_name AS medicationName,
  specification,dosage_form AS dosageForm,route,taken_at AS takenAt,amount,amount_unit AS amountUnit,note,revision,history_json AS historyJson,source_report_id AS sourceReportId,source_medication_id AS sourceMedicationId,source_snapshot_json AS sourceJson`;
type CourseRow = Omit<MedicationCourse, 'changes' | 'source' | keyof MedicationContext> & { sourceJson: string | null };
type IntakeRow = Omit<MedicationIntake, keyof MedicationContext | 'history' | 'source'> & { historyJson: string; sourceReportId: string|null; sourceMedicationId: string|null; sourceJson: string|null };

function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }); }
function requiredText(value: unknown, label: string, max = 200) { return textInput(value, label, max, true)!; }
function memberInput(input: Input) { return requiredText(input.memberId, '成员', 200); }
function actualDate(value: unknown, label: string) {
  const date = dateInput(value, label);
  if (!date) fail(400, `${label}不能为空`);
  if (date.length === 10 ? date > localToday() : Date.parse(date) > Date.now()) fail(400, `${label}不能是未来时间`);
  return date;
}
function medicationTimestamp(value: string) {
  // Date-only medication facts use the same local day as actualDate/localToday.
  return Date.parse(value.length === 10 ? `${value}T00:00:00` : value);
}
function revisionInput(value: unknown, expected: number) {
  if (!Number.isInteger(value) || value !== expected) fail(409, '记录已经更新，请刷新后重试');
}
function fields(input: Input, previous?: MedicationFields): MedicationFields {
  return {
    medicationName: hasInput(input, 'medicationName') ? requiredText(input.medicationName, '药品名称')
      : previous?.medicationName || requiredText(undefined, '药品名称'),
    ...Object.fromEntries((['specification', 'dosageForm', 'dose', 'doseUnit', 'frequency', 'route', 'instructions'] as const).map(key =>
      [key, hasInput(input, key) ? textInput(input[key], '用法', key === 'instructions' ? 2000 : 200) : previous?.[key] ?? null]))
  } as MedicationFields;
}
function courseRow(id: string) {
  const row = getDatabase().prepare(`SELECT ${courseColumns} FROM medication_courses WHERE id=? AND deleted_at IS NULL`).get(id) as CourseRow | undefined;
  return row || fail(404, '用药过程不存在');
}
function intakeRow(id: string) {
  const row = getDatabase().prepare(`SELECT ${intakeColumns} FROM medication_intakes WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM medication_courses c WHERE c.id=medication_intakes.course_id AND c.deleted_at IS NOT NULL)`).get(id) as IntakeRow | undefined;
  return row || fail(404, '服药记录不存在');
}
function audit(user: RequestUser, action: string, id: string, revision: number) {
  getDatabase().prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json)
    VALUES(?,?,?,'medication',?,?)`).run(createId('audit'), user.id, action, id, JSON.stringify({ revision }));
}

function describeCourse(row: CourseRow): MedicationCourse {
  const { sourceJson, ...course } = row;
  const db = getDatabase();
  const sourceAccessible = course.sourceReportId && db.prepare(`SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed' AND deleted_at IS NULL`)
    .get(course.sourceReportId, course.memberId);
  return { ...course, sourceReportId: sourceAccessible ? course.sourceReportId : null,
    source: sourceJson ? JSON.parse(sourceJson) as MedicationSource : null,
    changes: db.prepare(`SELECT id,action,occurred_at AS occurredAt,note,revision,snapshot_json AS snapshotJson
      FROM medication_course_changes WHERE course_id=? ORDER BY revision`).all(course.id).map(row => {
        const { snapshotJson, ...change } = row;
        return { ...change, snapshot: JSON.parse(String(snapshotJson)) };
      }) as MedicationCourse['changes']
  };
}
function describeIntake(row: IntakeRow): MedicationIntake {
  const { historyJson, sourceJson, sourceMedicationId, ...value } = row;
  const reportId=value.sourceReportId;
  const snapshot=sourceJson;
  const accessible = reportId && getDatabase().prepare(`SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed' AND deleted_at IS NULL`).get(reportId,value.memberId);
  return { ...value, sourceReportId:accessible ? reportId : null,source:snapshot ? JSON.parse(snapshot) as MedicationSource : null,
    history: JSON.parse(historyJson) };
}
export function getMedicationCourse(user: RequestUser, id: string) {
  const row = courseRow(id); assertMemberAccess(user, row.memberId); return describeCourse(row);
}
export function listMedications(user: RequestUser, input: Input): MedicationOverview {
  const memberId = memberInput(input); assertMemberAccess(user, memberId);
  const db = getDatabase();
  const courses = (db.prepare(`SELECT ${courseColumns} FROM medication_courses WHERE member_id=? AND deleted_at IS NULL ORDER BY started_at DESC,id`)
    .all(memberId) as CourseRow[]).map(describeCourse);
  return {courses,intakes:(db.prepare(`SELECT ${intakeColumns} FROM medication_intakes
    WHERE member_id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM medication_courses c WHERE c.id=medication_intakes.course_id AND c.deleted_at IS NOT NULL) ORDER BY taken_at DESC,created_at DESC,id`).all(memberId) as IntakeRow[]).map(describeIntake)};
}

/** Only intakes for the courses in the current process, without loading other courses/history. */
export function listCourseIntakes(user:RequestUser,memberId:string,courseIds:string[]):MedicationIntake[] {
  assertMemberAccess(user,memberId);if(!courseIds.length)return [];
  return (getDatabase().prepare(`SELECT ${intakeColumns} FROM medication_intakes
    WHERE member_id=? AND deleted_at IS NULL AND course_id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS(SELECT 1 FROM medication_courses c WHERE c.id=medication_intakes.course_id AND c.deleted_at IS NOT NULL)
    ORDER BY taken_at,created_at,id`).all(memberId,JSON.stringify(courseIds)) as IntakeRow[]).map(describeIntake);
}

export function listMedicationDocuments(user: RequestUser, input: Input): MedicationDocument[] {
  const memberId = memberInput(input); assertMemberAccess(user, memberId);
  const db = getDatabase();
  const visibleReports = `r.member_id=? AND r.report_type='prescription' AND r.status<>'trashed' AND r.deleted_at IS NULL`;
  const documents = (db.prepare(`SELECT r.id,r.member_id AS memberId,r.title,r.report_type AS reportType,r.status,
    COALESCE(NULLIF(r.report_issued_at,''),NULLIF(r.reviewed_at,''),NULLIF(r.received_at,''),
      NULLIF(r.examined_at,''),NULLIF(r.sampled_at,''),NULLIF(r.ordered_at,'')) AS date
    FROM reports r WHERE ${visibleReports} ORDER BY date DESC,r.id`)
    .all(memberId) as unknown as Array<Omit<MedicationDocument, keyof MedicationContext | 'medicationCount' | 'medicationNames'>>)
    .map(row => ({ ...row, medicationCount: 0, medicationNames: [] as string[] }));
  const byId = new Map(documents.map(document => [document.id, document]));
  const medications = db.prepare(`SELECT m.report_id AS reportId,m.medication_name AS medicationName,m.formula_json AS formulaJson
    FROM report_medications m JOIN reports r ON r.id=m.report_id
    WHERE ${visibleReports} AND m.is_deleted=0 ORDER BY m.id`).all(memberId) as Array<{reportId: string; medicationName: string; formulaJson: string | null}>;
  for (const medication of medications) {
    const document = byId.get(medication.reportId);
    if (!document) continue;
    document.medicationCount++;
    if (medication.formulaJson != null) document.formulaCount = (document.formulaCount || 0) + 1;
    if (medication.medicationName.trim() && !document.medicationNames.includes(medication.medicationName))
      document.medicationNames.push(medication.medicationName);
    for (const name of formulaIngredientNames(medication.formulaJson)) {
      const names = document.ingredientNames ?? (document.ingredientNames = []);
      if (!names.includes(name)) names.push(name);
    }
  }
  return documents;
}

function formulaIngredientNames(formulaJson: string | null): string[] {
  if (!formulaJson) return [];
  try { return parseMedicationFormula(JSON.parse(formulaJson))?.ingredients.map(item => item.name).filter(Boolean) ?? []; }
  catch { return []; }
}

const sourceSelect = `m.id AS medicationId,m.report_id AS reportId,r.title AS reportTitle,r.report_issued_at AS reportIssuedAt,
  m.formula_json AS formulaJson,m.medication_name AS medicationName,m.dose,m.dose_unit AS doseUnit,m.frequency,m.route,m.instructions,m.specification,m.dosage_form AS dosageForm,m.duration`;
function sourceMedication(id: string, memberId: string): MedicationSource {
  const row = getDatabase().prepare(`SELECT ${sourceSelect} FROM report_medications m JOIN reports r ON r.id=m.report_id
    WHERE m.id=? AND m.is_deleted=0 AND r.status<>'trashed' AND r.deleted_at IS NULL AND r.member_id=?`).get(id, memberId) as MedicationSource | undefined;
  if (!row) return fail(400, '来源用药已变化或不属于当前成员，请重新查看报告');
  const { formulaJson, ...source } = row as MedicationSource & { formulaJson: string | null };
  return { ...source, formula: formulaJson ? parseMedicationFormula(JSON.parse(formulaJson)) : null };
}
export function listHistoricalMedications(user: RequestUser, memberId: string): HistoricalMedication[] {
  assertMemberAccess(user, memberId);
  const db = getDatabase();
  return (db.prepare(`SELECT ${sourceSelect} FROM report_medications m JOIN reports r ON r.id=m.report_id
    WHERE r.member_id=? AND r.status<>'trashed' AND m.is_deleted=0
    ORDER BY COALESCE(r.report_issued_at,r.created_at) DESC,r.id,m.id`).all(memberId) as MedicationSource[])
    .map(row => {
      const { formulaJson, ...source } = row as MedicationSource & { formulaJson: string | null };
      return { ...source, formula: formulaJson ? parseMedicationFormula(JSON.parse(formulaJson)) : null, confirmedCourseIds: (db.prepare(`SELECT id FROM medication_courses
        WHERE member_id=? AND source_medication_id=? AND deleted_at IS NULL`).all(memberId, source.medicationId) as Array<{id: string}>).map(r => r.id) };
    });
}

function insertChange(user: RequestUser, courseId: string, action: MedicationAction, occurredAt: string,
  revision: number, snapshot: MedicationFields & { status: MedicationStatus }, note: string | null) {
  getDatabase().prepare(`INSERT INTO medication_course_changes(id,course_id,action,occurred_at,revision,snapshot_json,note,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).run(createId('medication-change'), courseId, action, occurredAt, revision, JSON.stringify(snapshot), note, user.id);
}
export function createMedicationCourse(user: RequestUser, input: Input) {
  return runHealthWorkflowRequest(user,memberInput(input),'medication.course.create',input,()=>createCourse(user,input),saved=>getMedicationCourse(user,saved.id));
}
function createCourse(user: RequestUser, input: Input) {
  const memberId = memberInput(input); assertMemberManage(user, memberId);
  if (input.confirmed !== true) fail(400, '请确认实际开始使用后再建立用药过程');
  const source = input.sourceMedicationId ? sourceMedication(requiredText(input.sourceMedicationId, '来源用药'), memberId) : null;
  const current = fields(input, source || undefined);
  const startedAt = actualDate(input.startedAt, '开始时间');
  const note = textInput(input.note, '说明', 2000);
  const id = createId('medication-course'); const db = getDatabase();
  runInTransaction(db, () => {
    db.prepare(`INSERT INTO medication_courses(id,member_id,medication_name,specification,dosage_form,dose,dose_unit,frequency,route,instructions,
      status,started_at,last_changed_at,source_report_id,source_medication_id,source_snapshot_json,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?)`).run(id, memberId, current.medicationName,current.specification,current.dosageForm,current.dose,current.doseUnit,
        current.frequency,current.route,current.instructions,startedAt,startedAt,source?.reportId || null,
        source?.medicationId || null,source ? JSON.stringify(source) : null,user.id);
    insertChange(user,id,'start',startedAt,1,{ ...current,status:'active' },note);
    associateMedicationSelections(user,{kind:'medication',id},input.relatedRecords,input.processId,source?[{kind:'report',id:source.reportId}]:[]); audit(user,'medication.start',id,1);
  });
  return getMedicationCourse(user, id);
}
export function changeMedicationCourse(user: RequestUser, id: string, input: Input) {
  const row = courseRow(id); assertMemberManage(user,row.memberId); revisionInput(input.revision,row.revision);
  const action = enumInput(input.action, medicationActions, '用药操作');
  if (action === 'start' || row.status === 'stopped' || (action === 'pause' && row.status !== 'active')
    || (action === 'resume' && row.status !== 'paused')) fail(409,'当前用药状态不能执行此操作');
  const occurredAt = actualDate(input.occurredAt,'变更时间');
  if (medicationTimestamp(occurredAt) < medicationTimestamp(row.lastChangedAt)) fail(400,'变更时间不能早于上次变更');
  const status: MedicationStatus = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : action === 'resume' ? 'active' : row.status;
  const current = action === 'adjust' ? fields(input,row) : fields({},row);
  const note = textInput(input.note,'说明',2000); const revision = row.revision + 1; const db = getDatabase();
  runInTransaction(db,() => {
    const changed = db.prepare(`UPDATE medication_courses SET medication_name=?,specification=?,dosage_form=?,dose=?,dose_unit=?,frequency=?,route=?,instructions=?,
      status=?,last_changed_at=?,stopped_at=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?`)
      .run(current.medicationName,current.specification,current.dosageForm,current.dose,current.doseUnit,current.frequency,current.route,current.instructions,
        status,occurredAt,status === 'stopped' ? occurredAt : null,revision,id,row.revision);
    if (!changed.changes) fail(409,'记录已经更新，请刷新后重试');
    insertChange(user,id,action,occurredAt,revision,{ ...current,status },note);
    associateMedicationSelections(user,{kind:'medication',id},input.relatedRecords,input.processId); audit(user,`medication.${action}`,id,revision);
  });
  return getMedicationCourse(user,id);
}

function intakeFields(input: Input, memberId: string, previous?: IntakeRow) {
  const courseId = hasInput(input,'courseId') ? textInput(input.courseId,'用药过程',200) : previous?.courseId || null;
  const course = courseId ? courseRow(courseId) : null;
  if (course && course.memberId !== memberId) fail(400,'用药过程不属于当前成员');
  return { courseId,
    medicationName: hasInput(input,'medicationName') ? requiredText(input.medicationName,'药品名称')
      : previous?.medicationName || course?.medicationName || requiredText(undefined,'药品名称'),
    specification: hasInput(input,'specification') ? textInput(input.specification,'规格',200) : previous ? previous.specification : course?.specification ?? null,
    dosageForm: hasInput(input,'dosageForm') ? textInput(input.dosageForm,'剂型',200) : previous ? previous.dosageForm : course?.dosageForm ?? null,
    route: hasInput(input,'route') ? textInput(input.route,'途径',200) : previous ? previous.route : course?.route ?? null,
    takenAt: actualDate(hasInput(input,'takenAt') ? input.takenAt : previous?.takenAt,'实际服药时间'),
    amount: requiredText(hasInput(input,'amount') ? input.amount : previous?.amount,'实际用量',100),
    amountUnit: hasInput(input,'amountUnit') ? textInput(input.amountUnit,'单位',100) : previous?.amountUnit || null,
    note: hasInput(input,'note') ? textInput(input.note,'说明',2000) : previous?.note || null
  };
}
/** Resolve a concrete source; never infer provenance from a matching drug name. */
function intakeOrigin(user:RequestUser,input:Input,memberId:string) {
  if(input.sourceMedicationId&&input.sourceIntakeId)fail(400,'请只选择一条服药来源');
  const previousId=input.sourceIntakeId?requiredText(input.sourceIntakeId,'来源服药记录'):null;
  const previous=previousId?getMedicationIntake(user,previousId):null;
  const previousRow=previousId?intakeRow(previousId):null;
  if(previous&&(previous.memberId!==memberId))fail(400,'来源服药记录无效或不属于当前成员');
  const courseId=hasInput(input,'courseId')?textInput(input.courseId,'用药过程',200):previous?.courseId||null;
  const parent=courseId?courseRow(courseId):null;
  if(parent&&parent.memberId!==memberId)fail(400,'用药过程不属于当前成员');
  const course=parent?describeCourse(parent):null;
  if(previous&&courseId!==previous.courseId)fail(400,'来源服药记录与所选用药不一致');
  const explicit=input.sourceMedicationId?sourceMedication(requiredText(input.sourceMedicationId,'来源用药'),memberId):null;
  if(explicit&&course?.source&&explicit.medicationId!==course.source.medicationId)fail(400,'来源用药单与所选用药不一致');
  const source=explicit||previous?.source||course?.source||null;
  const originalReportId=explicit?.reportId||(previousRow ? previousRow.sourceReportId : parent?.sourceReportId)||null;
  const report=originalReportId?getDatabase().prepare('SELECT id,status,deleted_at AS deletedAt FROM reports WHERE id=? AND member_id=?').get(originalReportId,memberId):null;
  const reportId=report?String(report.id):null;
  const refs:import('../../shared/health-record-associations').HealthRecordRef[]=[];
  if(course)refs.push({kind:'medication',id:course.id});
  if(previous)refs.push({kind:'intake',id:previous.id});
  if(reportId&&report?.status!=='trashed'&&!report?.deletedAt)refs.push({kind:'report',id:reportId});
  const snapshot=previous||explicit;
  const defaults=snapshot?{medicationName:snapshot.medicationName,specification:snapshot.specification,dosageForm:snapshot.dosageForm,route:snapshot.route}:{};
  return {courseId,source,reportId,refs,defaults};
}
export function createMedicationIntake(user: RequestUser,input: Input) {
  return runHealthWorkflowRequest(user,memberInput(input),'medication.intake.create',input,()=>createIntake(user,input),saved=>getMedicationIntake(user,saved.id));
}
export function getMedicationIntake(user: RequestUser,id: string) {
  const row=intakeRow(id);assertMemberAccess(user,row.memberId);return describeIntake(row);
}
function createIntake(user: RequestUser,input: Input) {
  const memberId = memberInput(input); assertMemberManage(user,memberId);
  const origin=intakeOrigin(user,input,memberId);
  const value = intakeFields({...origin.defaults,...input,courseId:origin.courseId},memberId);
  const id = createId('medication-intake'); const db = getDatabase();
  runInTransaction(db,() => {
    db.prepare(`INSERT INTO medication_intakes(id,member_id,course_id,medication_name,specification,dosage_form,route,taken_at,amount,amount_unit,note,created_by,source_report_id,source_medication_id,source_snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,memberId,value.courseId,value.medicationName,value.specification,value.dosageForm,value.route,
        value.takenAt,value.amount,value.amountUnit,value.note,user.id,origin.reportId,origin.source?.medicationId||null,origin.source?JSON.stringify(origin.source):null);
    associateMedicationSelections(user,{kind:'intake',id},input.relatedRecords,input.processId,origin.refs); audit(user,'medication.intake.create',id,1);
  });
  return describeIntake(intakeRow(id));
}
export function updateMedicationIntake(user: RequestUser,id: string,input: Input) {
  const row = intakeRow(id); assertMemberManage(user,row.memberId); revisionInput(input.revision,row.revision);
  const value = intakeFields(input,row.memberId,row);
  const changedOrigin=value.courseId!==row.courseId||hasInput(input,'sourceMedicationId')||hasInput(input,'sourceIntakeId');
  const origin=changedOrigin?intakeOrigin(user,{...input,courseId:value.courseId},row.memberId):null;
  const source=origin?origin.source:row.sourceJson?JSON.parse(row.sourceJson) as MedicationSource:null;
  const db = getDatabase();
  runInTransaction(db,() => {
    const before = describeIntake(row); const { history, ...snapshot } = before;
    const historyJson = JSON.stringify([...history,{operation:'edit',recordedAt:new Date().toISOString(),snapshot}]);
    const result = db.prepare(`UPDATE medication_intakes SET course_id=?,medication_name=?,specification=?,dosage_form=?,route=?,taken_at=?,amount=?,amount_unit=?,note=?,history_json=?,source_report_id=?,source_medication_id=?,source_snapshot_json=?,
      revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?`)
      .run(value.courseId,value.medicationName,value.specification,value.dosageForm,value.route,value.takenAt,value.amount,value.amountUnit,value.note,historyJson,origin?origin.reportId:row.sourceReportId,origin?source?.medicationId||null:row.sourceMedicationId,source?JSON.stringify(source):null,id,row.revision);
    if (!result.changes) fail(409,'记录已经更新，请刷新后重试');
    associateMedicationSelections(user,{kind:'intake',id},input.relatedRecords,input.processId,origin?.refs||[]); audit(user,'medication.intake.edit',id,row.revision+1);
  });
  return describeIntake(intakeRow(id));
}
