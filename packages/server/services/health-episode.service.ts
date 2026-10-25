import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { healthEpisodeOutcomes, healthEpisodeStatuses, healthEpisodeTypes,
  type HealthEpisodeType } from '../../shared/health-events';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { assertDateOrder, dateInput, enumInput, hasInput, localToday, textInput } from './health-event-input';
import { insertProcessSymptom, readProcessSymptoms } from './symptom-episode.service';

export type HealthEpisodeRow = {
  id: string; memberId: string; episodeType: HealthEpisodeType; title: string;
  startedAt: string | null; endedAt: string | null;
  status: typeof healthEpisodeStatuses[number];
  outcome: typeof healthEpisodeOutcomes[number] | null;
  description: string | null; createdBy: string | null;
  createdAt: string; updatedAt: string;
};

const columns = `id, member_id AS memberId, episode_type AS episodeType, title,
  started_at AS startedAt, ended_at AS endedAt, status, outcome, description,
  created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`;

export function activeHealthEpisode(id: string): HealthEpisodeRow {
  const row = getDatabase().prepare(`SELECT ${columns} FROM health_episodes WHERE id=? AND deleted_at IS NULL`)
    .get(id) as HealthEpisodeRow | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: '健康历程不存在' });
  return row;
}

export function auditHealthEpisode(user: RequestUser, action: string, id: string, detail: Record<string, unknown> = {}) {
  getDatabase().prepare(`INSERT INTO audit_logs(id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES(?, ?, ?, 'health_episode', ?, ?)`).run(createId('audit'), user.id, action, id, JSON.stringify(detail));
}

function episodeFields(input: Record<string, unknown>, existing?: HealthEpisodeRow) {
  const title = hasInput(input, 'title') ? textInput(input.title, '标题', 120, true)! : existing?.title;
  if (!title) throw createError({ statusCode: 400, statusMessage: '标题不能为空' });
  const startedAt = hasInput(input, 'startedAt') ? dateInput(input.startedAt, '开始时间') : existing?.startedAt ?? null;
  const status = hasInput(input, 'status')
    ? enumInput(input.status, healthEpisodeStatuses, '状态') : existing?.status ?? 'active';
  let endedAt = hasInput(input, 'endedAt') ? dateInput(input.endedAt, '结束时间') : existing?.endedAt ?? null;
  if (status === 'ended' && !endedAt) endedAt = localToday();
  if (status !== 'ended' && endedAt) throw createError({ statusCode: 400, statusMessage: '未结束的健康历程不能填写结束时间' });
  assertDateOrder(startedAt, endedAt);
  const outcome = hasInput(input, 'outcome')
    ? (input.outcome === null || input.outcome === '' ? null : enumInput(input.outcome, healthEpisodeOutcomes, '结果'))
    : existing?.outcome ?? null;
  return { title, startedAt, endedAt, status, outcome,
    description: hasInput(input, 'description')
      ? textInput(input.description, '描述', 2000) : existing?.description ?? null };
}

export function getHealthEpisode(user: RequestUser, id: string) {
  const episode = activeHealthEpisode(id);
  assertMemberAccess(user, episode.memberId);
  const symptoms = readProcessSymptoms(id);
  return {...episode,symptoms};
}

export function createHealthEpisode(user: RequestUser, input: Record<string, unknown>) {
  const memberId = textInput(input.memberId, '成员', 100, true)!;
  assertMemberManage(user, memberId);
  return runHealthWorkflowRequest(user, memberId, 'episode.create', input, () => {
  const episodeType = enumInput(input.episodeType, healthEpisodeTypes, '健康历程类型');
  const fields = episodeFields(input);
  const symptomInput = input.symptom;
  if (symptomInput !== undefined && (!symptomInput || typeof symptomInput !== 'object' || Array.isArray(symptomInput)))
    throw createError({ statusCode: 400, statusMessage: '症状详情无效' });
  const symptom = episodeType === 'symptom' || symptomInput !== undefined
    ? (symptomInput || {}) as Record<string, unknown> : null;
  const id = createId('episode');
  const db = getDatabase();
  runInTransaction(db, () => {
    db.prepare(`INSERT INTO health_episodes(id, member_id, episode_type, title, started_at,
      ended_at, status, outcome, description, created_by) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, memberId, episodeType, fields.title, fields.startedAt, fields.endedAt,
        fields.status, fields.outcome, fields.description, user.id);
    if (symptom) insertProcessSymptom(user, activeHealthEpisode(id), {
      ...symptom, name: symptom.name ?? fields.title, startedAt: symptom.startedAt ?? fields.startedAt
    });
  });
  return getHealthEpisode(user, id);
  }, saved => getHealthEpisode(user, saved.id));
}
