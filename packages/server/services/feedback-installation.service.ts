import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database/client';

const key = 'x-client-id';
/** Unified apps gateway id; distinct from body/storage key `health-records`. */
export const FEEDBACK_APP_ID = 'fnos-app-health-records';
const deviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+:-]{7,127}$/;

export function isValidDeviceId(value: string): boolean {
  return deviceIdPattern.test(value) && !/^(.)\1+$/.test(value);
}

/** Prefer TRIM_SYS_MACHINE_ID. Invalid or placeholder values are ignored. */
export function readFnOSMachineId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TRIM_SYS_MACHINE_ID?.trim();
  return value && isValidDeviceId(value) ? value : null;
}

export type FeedbackAppsIdentity = {
  headers: Record<string, string>;
  /** Stable local key for sync/notification hashing; prefers legacy client when present. */
  localKey: string;
  clientId: string | null;
  deviceId: string | null;
};

export function readFeedbackInstallation(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE setting_key=?').get(key) as {value_json:string}|undefined;
  if (!row) return null;
  let value: unknown;
  try { value = JSON.parse(row.value_json); } catch { throw new Error('反馈安装标识损坏，请保留数据并联系维护人员'); }
  if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('反馈安装标识损坏，请保留数据并联系维护人员');
  return value;
}

export function getFeedbackInstallation(db: DatabaseSync = getDatabase()): string {
  const existing = readFeedbackInstallation(db);
  if(existing) return existing;
  // The primary key arbitrates concurrent processes; read the persisted winner.
  db.prepare('INSERT OR IGNORE INTO app_settings(setting_key,value_json) VALUES (?,?)').run(key,JSON.stringify(randomBytes(32).toString('base64url')));
  return readFeedbackInstallation(db)!;
}

/**
 * Resolve /apps/v1 identity headers.
 * fnOS with a valid machine id: x-device-id; dual-pass legacy x-client-id when present; never create a new client id.
 * Docker / missing machine id: ensure and send only x-client-id.
 */
export function resolveFeedbackAppsIdentity(
  db: DatabaseSync = getDatabase(),
  dependencies: { machineId?: string | null } = {},
): FeedbackAppsIdentity {
  const headers: Record<string, string> = { 'x-app-id': FEEDBACK_APP_ID };
  const machineId = dependencies.machineId !== undefined ? dependencies.machineId : readFnOSMachineId();
  const legacyClientId = readFeedbackInstallation(db);
  if (machineId && isValidDeviceId(machineId)) {
    headers['x-device-id'] = machineId;
    if (legacyClientId) headers['x-client-id'] = legacyClientId;
    return {
      headers,
      localKey: legacyClientId || machineId,
      clientId: legacyClientId,
      deviceId: machineId,
    };
  }
  const clientId = getFeedbackInstallation(db);
  headers['x-client-id'] = clientId;
  return { headers, localKey: clientId, clientId, deviceId: null };
}

export function preserveFeedbackInstallation(restored: DatabaseSync, current: DatabaseSync) {
  if(readFeedbackInstallation(restored)) return;
  const existing=readFeedbackInstallation(current);
  if(existing) restored.prepare('INSERT OR IGNORE INTO app_settings(setting_key,value_json) VALUES (?,?)').run(key,JSON.stringify(existing));
}
