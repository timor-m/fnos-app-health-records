import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getAppConfig } from '../utils/runtime-config';
import { atomicStorageJson } from '../utils/storage-migration-state';
import { sendFeedbackRequest } from './feedback-remote.service';

export interface WechatGroup {
  id: number;
  name: string;
  description: string;
  qrContent: string;
  expiresAt: string;
  revision: number;
}

export interface WechatGroupResult {
  group: WechatGroup | null;
  serverTime: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Accept the original uploaded raster image without decoding or validating any QR content.
export function isWechatGroupQrContent(value: unknown): value is string {
  const maxImageBytes = 5 * 1024 * 1024;
  if (typeof value !== 'string' || value.length > Math.ceil(maxImageBytes / 3) * 4 + 23) return false;
  const prefix = /^data:image\/(?:jpeg|png|webp);base64,/.exec(value);
  if (!prefix) return false;
  const encoded = value.slice(prefix[0].length);
  if (!encoded.length || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) return false;
  return encoded.length * 3 / 4 - padding <= maxImageBytes;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (Number(year) < 1000 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1
    || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function parseGroupResult(value: unknown, now: Date, keepExpired: boolean): WechatGroupResult {
  const unavailable: WechatGroupResult = { group: null, serverTime: now.toISOString() };
  if (!isRecord(value)) return unavailable;
  const serverTime = timestamp(value.serverTime);
  if (serverTime === null) return unavailable;
  if (value.group === null) return { group: null, serverTime: value.serverTime as string };
  const group = value.group;
  if (!isRecord(group)) return unavailable;
  const expiresAt = timestamp(group.expiresAt);
  if (!Number.isSafeInteger(group.id) || (group.id as number) <= 0
    || !Number.isSafeInteger(group.revision) || (group.revision as number) <= 0
    || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 120
    || typeof group.description !== 'string' || group.description.length > 1000
    || !isWechatGroupQrContent(group.qrContent) || expiresAt === null || (!keepExpired && expiresAt <= serverTime)) return unavailable;
  return {
    group: {
      id: group.id as number,
      name: group.name,
      description: group.description,
      qrContent: group.qrContent,
      expiresAt: group.expiresAt as string,
      revision: group.revision as number,
    },
    serverTime: value.serverTime as string,
  };
}

export function parseWechatGroupResult(value: unknown, now = new Date()): WechatGroupResult {
  return parseGroupResult(value, now, false);
}

const retryInterval = 60 * 60 * 1000;
const maxCacheBytes = Math.ceil(5 * 1024 * 1024 / 3) * 4 + 64 * 1024;
interface WechatGroupCache {
  version: 1;
  requestedAt: number;
  nextCheckAt: number;
  result: WechatGroupResult;
}
interface WechatGroupDependencies {
  request?: typeof sendFeedbackRequest;
  now?: () => Date;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  // null bypasses persistence for isolated remote/validation tests.
  cachePath?: string | null;
}
const pending = new Map<string, Promise<WechatGroupResult>>();

async function readCache(path: string, now: Date): Promise<WechatGroupCache | null> {
  try {
    if ((await stat(path)).size > maxCacheBytes) return null;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || value.version !== 1
      || !Number.isSafeInteger(value.requestedAt) || (value.requestedAt as number) < 0
      || (value.requestedAt as number) > now.getTime()
      || !Number.isSafeInteger(value.nextCheckAt) || (value.nextCheckAt as number) < (value.requestedAt as number)
      || !isRecord(value.result) || timestamp(value.result.serverTime) === null) return null;
    const result = parseGroupResult(value.result, now, true);
    if (value.result.group !== null && result.group === null) return null;
    return { version: 1, requestedAt: value.requestedAt as number, nextCheckAt: value.nextCheckAt as number, result };
  } catch { return null; }
}

function cachedResult(cache: WechatGroupCache, now: Date): WechatGroupResult {
  // Advance upstream time by local elapsed time; returning the saved time would renew
  // the browser's countdown on every refresh. Absolute NAS clock skew is harmless.
  const serverTime = Date.parse(cache.result.serverTime) + now.getTime() - cache.requestedAt;
  if (!Number.isFinite(serverTime) || Math.abs(serverTime) > 8.64e15) return { group: null, serverTime: now.toISOString() };
  return parseWechatGroupResult({ ...cache.result, serverTime: new Date(serverTime).toISOString() }, now);
}

async function loadGroup(path: string | null, dependencies: WechatGroupDependencies): Promise<WechatGroupResult> {
  const now = dependencies.now ?? (() => new Date());
  const cached = path ? await readCache(path, now()) : null;
  if (cached && now().getTime() < cached.nextCheckAt) return cachedResult(cached, now());
  const requestedAt = now().getTime();
  let result: WechatGroupResult | null = null;
  try {
    const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(5000);
    const value = await (dependencies.request ?? sendFeedbackRequest)('/wechat-group', { signal });
    if (!signal.aborted) result = parseGroupResult(value, now(), true);
  } catch { /* Optional About content must not surface remote failures or log payloads. */ }
  const receivedAt = now().getTime();
  const validUntil = result?.group
    ? requestedAt + Date.parse(result.group.expiresAt) - Date.parse(result.serverTime) : 0;
  // Keep the last image even when the gateway no longer returns it. Expired images
  // remain on disk only; responses always filter them out before reaching the UI.
  const cache: WechatGroupCache = !result?.group && cached ? { ...cached, nextCheckAt: receivedAt + retryInterval } : {
    version: 1,
    // Anchor at request start so network time cannot extend the image's lifetime.
    requestedAt,
    nextCheckAt: validUntil > receivedAt ? validUntil : receivedAt + retryInterval,
    result: result ?? { group: null, serverTime: new Date(receivedAt).toISOString() },
  };
  if (path) {
    try { atomicStorageJson(path, cache); } catch { /* Cache storage must not break optional About content. */ }
  }
  return cachedResult(cache, now());
}

export async function getWechatGroup(dependencies: WechatGroupDependencies = {}): Promise<WechatGroupResult> {
  const path = dependencies.cachePath === undefined
    ? join(getAppConfig().runtimeDir, 'cache', 'wechat-group.json') : dependencies.cachePath;
  if (path === null) return loadGroup(null, dependencies);
  const existing = pending.get(path);
  if (existing) return existing;
  const request = loadGroup(path, dependencies);
  pending.set(path, request);
  try { return await request; } finally { pending.delete(path); }
}
