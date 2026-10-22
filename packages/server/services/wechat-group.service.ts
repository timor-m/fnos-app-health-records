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

export function parseWechatGroupResult(value: unknown, now = new Date()): WechatGroupResult {
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
    || !isWechatGroupQrContent(group.qrContent) || expiresAt === null || expiresAt <= serverTime) return unavailable;
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

export async function getWechatGroup(dependencies: {
  request?: typeof sendFeedbackRequest;
  now?: () => Date;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
} = {}): Promise<WechatGroupResult> {
  const now = dependencies.now ?? (() => new Date());
  try {
    const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(5000);
    const value = await (dependencies.request ?? sendFeedbackRequest)('/wechat-group', { signal });
    if (!signal.aborted) return parseWechatGroupResult(value, now());
  } catch { /* Optional About content must not surface remote failures or log payloads. */ }
  return { group: null, serverTime: now().toISOString() };
}
