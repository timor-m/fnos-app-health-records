import {isTemperatureMeasurement} from '../../shared/symptom-measurements';
import { mutateStandaloneTrash } from './health-record-trash.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { activeHealthEpisode, auditHealthEpisode, getHealthEpisode, type HealthEpisodeRow } from './health-episode.service';
import { assertOccurredDate, dateInput, enumInput, hasInput, textInput } from './health-event-input';
import { localSymptomMoment, symptomDateBefore, symptomDetails, symptomSeverity, type SymptomDetails } from './health-symptom-input';
import { assertMemberManage } from './member.service';
import { healthSymptomChanges, type HealthSymptomChange } from '../../shared/health-events';

export type ProcessSymptomUpdate = {
  id: string; symptomId: string; recordedAt: string; change: HealthSymptomChange | null;
  severity: number | null; measurementValue: string | null; measurementUnit: string | null; temperatureValue?: string | null;
  description: string | null; version: number; deletedAt: string | null; createdAt: string;
};
export type ProcessSymptom = SymptomDetails & {
  id: string; episodeId: string; name: string; startedAt: string | null;
  status: 'active' | 'resolved' | 'unknown'; endedAt: string | null;
  currentSeverity: number | null; version: number; updates: ProcessSymptomUpdate[];
};
const symptomColumns = `id,episode_id AS episodeId,name,started_at AS startedAt,body_area AS bodyArea,severity,frequency,description,
  trigger_text AS triggerText,relieving_text AS relievingText,associated_symptoms_text AS associatedSymptomsText,version`;
const updateColumns = `id,symptom_id AS symptomId,recorded_at AS recordedAt,change,severity,
  measurement_value AS measurementValue,measurement_unit AS measurementUnit,temperature_value AS temperatureValue,description,version,deleted_at AS deletedAt,created_at AS createdAt`;

export function readProcessSymptoms(episodeId: string, symptomId?: string): ProcessSymptom[] {
  const db = getDatabase();
  const rows = db.prepare(`SELECT ${symptomColumns} FROM health_process_symptoms
    WHERE episode_id=? AND deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY created_at,rowid`).all(episodeId,symptomId??null,symptomId??null) as unknown as ProcessSymptom[];
  return rows.map(row => {
    const updates = db.prepare(`SELECT ${updateColumns} FROM health_process_symptom_updates
      WHERE symptom_id=? ORDER BY julianday(recorded_at),created_at,rowid`).all(row.id) as unknown as ProcessSymptomUpdate[];
    const live = updates.filter(update => !update.deletedAt);
    const lastChange = live.filter(update => update.change !== null).at(-1);
    const status = lastChange ? (lastChange.change === 'resolved' ? 'resolved' : 'active') : 'active';
    return { ...row, status,
      endedAt: status === 'resolved' ? lastChange?.recordedAt ?? null : null,
      currentSeverity: live.filter(update => update.severity !== null).at(-1)?.severity ?? row.severity, updates };
  });
}

function managedEpisode(user: RequestUser, episodeId: string) {
  const episode = activeHealthEpisode(episodeId);
  assertMemberManage(user, episode.memberId);
  return episode;
}
function managedSymptom(user: RequestUser, episodeId: string, symptomId: string) {
  const episode = managedEpisode(user, episodeId);
  const symptom = readProcessSymptoms(episodeId).find(item => item.id === symptomId);
  if (!symptom) throw createError({ statusCode: 404, statusMessage: '症状条目不存在' });
  return { episode, symptom };
}
function validateStart(startedAt: string | null) {assertOccurredDate(startedAt,'症状开始时间');}
function recordRevision(db: DatabaseSync, user: RequestUser, episodeId: string, type: 'symptom' | 'update', id: string, operation: 'correct' | 'retract') {
  const table = type === 'symptom' ? 'health_process_symptoms' : 'health_process_symptom_updates';
  const snapshot = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  db.prepare(`INSERT INTO health_process_symptom_revisions(id,episode_id,target_type,target_id,operation,snapshot_json,created_by)
    VALUES(?,?,?,?,?,?,?)`).run(createId('symptom_revision'),episodeId,type,id,operation,JSON.stringify(snapshot),user.id);
}
function assertVersion(input: Record<string, unknown>, version: number) {
  if (!Number.isInteger(input.version) || input.version !== version)
    throw createError({ statusCode: 409, statusMessage: '记录已变化，请刷新后重新核对' });
}
function touch(user: RequestUser, episodeId: string, action: string, detail: Record<string, unknown>) {
  getDatabase().prepare('UPDATE health_episodes SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(episodeId);
  auditHealthEpisode(user, action, episodeId, detail);
}

/** Called inside the caller's transaction when creating a process and its first symptom. */
export function insertProcessSymptom(user: RequestUser, episode: HealthEpisodeRow, input: Record<string, unknown>) {
  const name = textInput(input.name, '症状名称', 120, true)!;
  const startedAt = dateInput(input.startedAt, '症状开始时间');
  validateStart(startedAt);
  const fields = symptomDetails(input);
  const id = createId('process_symptom');
  getDatabase().prepare(`INSERT INTO health_process_symptoms(id,episode_id,name,started_at,body_area,severity,frequency,description,
    trigger_text,relieving_text,associated_symptoms_text,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,episode.id,name,startedAt,fields.bodyArea,fields.severity,fields.frequency,fields.description,
      fields.triggerText,fields.relievingText,fields.associatedSymptomsText,user.id);
  touch(user, episode.id, 'episode.symptom.create', { symptomId: id });
  return id;
}
export function createProcessSymptom(user: RequestUser, episodeId: string, input: Record<string, unknown>) {
  const episode = managedEpisode(user, episodeId);
  return runHealthWorkflowRequest(user, episode.memberId, 'symptom.create', {...input,episodeId}, () => {
  runInTransaction(getDatabase(), () => {insertProcessSymptom(user,episode,input);});
  return getHealthEpisode(user, episodeId);
  }, saved => getHealthEpisode(user, saved.id));
}
export function updateProcessSymptom(user: RequestUser, episodeId: string, symptomId: string, input: Record<string, unknown>) {
  const { episode, symptom } = managedSymptom(user,episodeId,symptomId);
  assertVersion(input,symptom.version);
  const name = hasInput(input,'name') ? textInput(input.name,'症状名称',120,true)! : symptom.name;
  const startedAt = hasInput(input,'startedAt') ? dateInput(input.startedAt,'症状开始时间') : symptom.startedAt;
  validateStart(startedAt);
  if (startedAt && symptom.updates.some(update => !update.deletedAt && symptomDateBefore(update.recordedAt, startedAt)))
    throw createError({ statusCode: 400, statusMessage: '开始时间不能晚于已有变化记录' });
  const fields = symptomDetails(input,symptom);
  const db = getDatabase();
  runInTransaction(db, () => {
    recordRevision(db,user,episodeId,'symptom',symptomId,'correct');
    db.prepare(`UPDATE health_process_symptoms SET name=?,started_at=?,body_area=?,severity=?,frequency=?,description=?,
      trigger_text=?,relieving_text=?,associated_symptoms_text=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name,startedAt,fields.bodyArea,fields.severity,fields.frequency,fields.description,fields.triggerText,
        fields.relievingText,fields.associatedSymptomsText,symptomId);
    touch(user,episodeId,'episode.symptom.correct',{symptomId});
  });
  return getHealthEpisode(user,episodeId);
}
export function retractProcessSymptom(user: RequestUser, episodeId: string, symptomId: string, input: Record<string, unknown>) {
  const { symptom } = managedSymptom(user,episodeId,symptomId);
  assertVersion(input,symptom.version);
  mutateStandaloneTrash(user,'symptom',symptomId,{revision:symptom.version},'trash');
  return getHealthEpisode(user,episodeId);
}
function updateFields(input: Record<string, unknown>, symptom: ProcessSymptom, episode: HealthEpisodeRow, existing?: ProcessSymptomUpdate) {
  const recordedAt = hasInput(input,'recordedAt') ? dateInput(input.recordedAt,'记录时间') || localSymptomMoment() : existing?.recordedAt ?? localSymptomMoment();
  assertOccurredDate(recordedAt,'症状记录时间');
  const minimum = symptom.startedAt;
  if (minimum && symptomDateBefore(recordedAt, minimum))
    throw createError({ statusCode: 400, statusMessage: '记录时间不能早于症状开始时间' });
  const change = hasInput(input,'change') ? (input.change === null || input.change === '' ? null : enumInput(input.change,healthSymptomChanges,'症状变化')) : existing?.change ?? null;
  const severity = hasInput(input,'severity') ? symptomSeverity(input.severity) : existing?.severity ?? null;
  const measurementValue = hasInput(input,'measurementValue') ? textInput(input.measurementValue,'测量值',100) : existing?.measurementValue ?? null;
  const measurementUnit = hasInput(input,'measurementUnit') ? textInput(input.measurementUnit,'测量单位',50) : existing?.measurementUnit ?? null;
  if (Boolean(measurementValue) !== Boolean(measurementUnit)) throw createError({ statusCode: 400, statusMessage: '测量值与单位请一起填写' });
  const temperatureValue=hasInput(input,'temperatureValue')?textInput(input.temperatureValue,'附带体温',100):existing?.temperatureValue??null;
  if(temperatureValue&&!isTemperatureMeasurement(temperatureValue,'℃'))throw createError({statusCode:400,statusMessage:'请填写有效的摄氏体温数值'});
  const description = hasInput(input,'description') ? textInput(input.description,'变化描述',2000) : existing?.description ?? null;
  if (!change && severity === null && !measurementValue && !temperatureValue && !description)
    throw createError({ statusCode: 400, statusMessage: '请填写变化、程度、测量值或描述' });
  return { recordedAt,change,severity,measurementValue,measurementUnit,temperatureValue,description };
}
export function createProcessSymptomUpdate(user: RequestUser, episodeId: string, symptomId: string, input: Record<string, unknown>) {
  const { episode,symptom } = managedSymptom(user,episodeId,symptomId);
  return runHealthWorkflowRequest(user, episode.memberId, 'symptom.update.create', {...input,episodeId,symptomId}, () => {
  const f = updateFields(input,symptom,episode);
  const id = createId('symptom_update');
  const db = getDatabase();
  runInTransaction(db, () => {
    db.prepare(`INSERT INTO health_process_symptom_updates(id,symptom_id,recorded_at,change,severity,measurement_value,measurement_unit,temperature_value,description,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,symptomId,f.recordedAt,f.change,f.severity,f.measurementValue,f.measurementUnit,f.temperatureValue,f.description,user.id);
    touch(user,episodeId,'episode.symptom.record',{symptomId,updateId:id,change:f.change});
  });
  return getHealthEpisode(user,episodeId);
  }, saved => getHealthEpisode(user, saved.id));
}
export function correctProcessSymptomUpdate(user: RequestUser, episodeId: string, symptomId: string, updateId: string, input: Record<string, unknown>) {
  const { episode,symptom } = managedSymptom(user,episodeId,symptomId);
  const old = symptom.updates.find(update => update.id===updateId && !update.deletedAt);
  if (!old) throw createError({ statusCode: 404, statusMessage: '变化记录不存在' });
  assertVersion(input,old.version);
  const f = updateFields(input,symptom,episode,old);
  const db = getDatabase();
  runInTransaction(db, () => {
    recordRevision(db,user,episodeId,'update',updateId,'correct');
    db.prepare(`UPDATE health_process_symptom_updates SET recorded_at=?,change=?,severity=?,measurement_value=?,measurement_unit=?,temperature_value=?,description=?,
      version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(f.recordedAt,f.change,f.severity,f.measurementValue,f.measurementUnit,f.temperatureValue,f.description,updateId);
    touch(user,episodeId,'episode.symptom.record.correct',{symptomId,updateId});
  });
  return getHealthEpisode(user,episodeId);
}
export function retractProcessSymptomUpdate(user: RequestUser, episodeId: string, symptomId: string, updateId: string, input: Record<string, unknown>) {
  const { symptom } = managedSymptom(user,episodeId,symptomId);
  const old = symptom.updates.find(update => update.id===updateId && !update.deletedAt);
  if (!old) throw createError({ statusCode: 404, statusMessage: '变化记录不存在' });
  assertVersion(input,old.version);
  const db = getDatabase();
  runInTransaction(db, () => {
    recordRevision(db,user,episodeId,'update',updateId,'retract');
    db.prepare('UPDATE health_process_symptom_updates SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?').run(updateId);
    touch(user,episodeId,'episode.symptom.record.retract',{symptomId,updateId});
  });
  return getHealthEpisode(user,episodeId);
}
