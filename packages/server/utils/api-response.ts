import { fallbackErrorCode } from './api-error';
import { isApiErrorCode } from '../../shared/api-error';

export function ok<T>(data: T, meta?: Record<string, unknown>) {
  return { ok: true, data, ...(meta ? { meta } : {}) };
}

// Preserve error.message and meta for older clients while sharing the canonical fields.
export function fail(message: string, meta?: Record<string, unknown>) {
  const status = typeof meta?.status === 'number' ? meta.status : 400;
  const code = isApiErrorCode(meta?.code) ? meta.code : fallbackErrorCode(status);
  return { ok: false, status, code, message, error: { message, code }, ...(meta ? { meta } : {}) };
}
