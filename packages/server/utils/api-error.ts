import { createError, HTTPError } from 'h3';
import { isApiErrorCode, type ApiErrorCode, type ApiErrorPayload } from '../../shared/api-error';
export type { ApiErrorCode, ApiErrorPayload } from '../../shared/api-error';

export const internalErrorMessage = '系统处理异常，请稍后重试；如反复出现，请将错误码反馈给开发者';

export function apiError(status: number, code: ApiErrorCode, message: string, meta?: Record<string, unknown>) {
  // H3 v2 的 statusText 会过滤中文；message 才是可可靠传输的用户提示。
  return createError({ statusCode: status, message, data: { code, ...(meta ? { meta } : {}) } });
}

export function fallbackErrorCode(status: number): ApiErrorCode {
  return ({ 400: 'REQUEST_INVALID', 401: 'AUTH_REQUIRED', 403: 'PERMISSION_DENIED',
    404: 'RESOURCE_NOT_FOUND', 409: 'RESOURCE_CONFLICT', 410: 'RESOURCE_NOT_FOUND',
    413: 'FILE_TOO_LARGE', 415: 'FILE_FORMAT_UNSUPPORTED', 422: 'REQUEST_INVALID',
    429: 'RATE_LIMITED' } as Record<number, ApiErrorCode>)[status] || 'INTERNAL_ERROR';
}

export function unwrapHttpError(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 10 && HTTPError.isError(current) && current.unhandled; depth++) {
    // H3 v2 stores constructor details in cause, including the actual cause.
    const cause = current.cause;
    current = HTTPError.isError(cause) ? cause : cause && typeof cause === 'object' && 'cause' in cause ? cause.cause : cause;
  }
  return HTTPError.isError(current) && !current.unhandled ? current : null;
}

const storageMessages: Record<string, string> = {
  ENOSPC: '存储空间不足，无法完成当前操作', EDQUOT: '存储空间不足，无法完成当前操作',
  EACCES: '档案存储目录当前不可写，请检查存储目录权限或挂载状态',
  EPERM: '档案存储目录当前不可写，请检查存储目录权限或挂载状态',
  EROFS: '档案存储目录当前不可写，请检查存储目录权限或挂载状态',
  EIO: '存储设备读写异常，请检查存储状态后重试',
  EMFILE: '系统当前无法继续打开文件，请稍后重试', ENFILE: '系统当前无法继续打开文件，请稍后重试'
};
const databaseMessages: Record<number, string> = {
  5: '档案数据库当前繁忙，请稍后重试', 6: '档案数据库当前繁忙，请稍后重试',
  8: '档案数据库当前不可写，请检查存储状态', 10: '档案数据库读写异常，请检查存储状态后重试',
  11: '档案数据库状态异常，请检查系统运行状态', 13: '存储空间不足，无法保存数据'
};
const sqliteCodes: Record<string, number> = { SQLITE_BUSY: 5, SQLITE_LOCKED: 6, SQLITE_READONLY: 8, SQLITE_IOERR: 10, SQLITE_CORRUPT: 11, SQLITE_FULL: 13 };
const decodeMessages: Record<string, string> = {
  PDF_DECODE_FAILED: 'PDF 文件无法读取，可能已损坏或格式异常',
  IMAGE_DECODE_FAILED: '图片内容无法读取，可能已损坏或格式异常',
  INPUT_FORMAT_MISMATCH: '文件内容与实际格式不匹配'
};
const ocrServiceCodes = new Set(['OCR_WORKER_UNAVAILABLE', 'OCR_WORKER_EXITED', 'OCR_WORKER_HARD_TIMEOUT',
  'OCR_WORKER_PROTOCOL_ERROR', 'OCR_WORKER_RECYCLE_FAILED', 'OCR_WORKER_RECYCLE_TIMEOUT',
  'OCR_WORKER_STARTUP_TIMEOUT', 'OCR_WORKER_START_FAILED', 'OCR_WORKER_STOPPED', 'OCR_WORKER_WRITE_FAILED',
  'OCR_WORKER_OUTPUT_FILE_INVALID', 'OCR_WORKER_OUTPUT_FILE_TOO_LARGE', 'OCR_WORKER_OUTPUT_TOO_LARGE', 'OCR_WORKER_RESPONSE_LIMIT_EXCEEDED']);

export function classifySystemError(error: unknown): ApiErrorPayload | null {
  let current = error;
  const seen = new Set<unknown>();
  const result = (status: number, code: ApiErrorCode, message: string): ApiErrorPayload => ({ error: true, status, code, message });
  for (let depth = 0; current && typeof current === 'object' && depth < 10 && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { code?: string; errcode?: number; message?: string; cause?: unknown; upstreamStatus?: number };
    const code = typeof item.code === 'string' ? item.code : '';
    if (code === 'ERR_SQLITE_ERROR' && item.message === 'PAGE_APPEND_BUSY') return result(409, 'UPLOAD_CONFLICT', '补充报告页尚未结束，请先完成或放弃该批次');
    // node:sqlite uses ERR_SQLITE_ERROR + numeric errcode, including extended result codes.
    const sqlite = sqliteCodes[code.replace(/^(SQLITE_[A-Z]+)_.+$/, '$1')]
      || (code === 'ERR_SQLITE_ERROR' && typeof item.errcode === 'number' ? item.errcode & 255 : 0)
      || (item.message === 'database is locked' ? 5 : 0);
    if (databaseMessages[sqlite]) return result(503, sqlite === 13 ? 'STORAGE_UNAVAILABLE' : 'DATABASE_UNAVAILABLE', databaseMessages[sqlite]);
    if (storageMessages[code]) return result(503, 'STORAGE_UNAVAILABLE', storageMessages[code]);
    if (decodeMessages[code]) return result(422, 'FILE_DECODE_FAILED', decodeMessages[code]);
    if (ocrServiceCodes.has(code)) return result(503, 'OCR_UNAVAILABLE', 'OCR 识别服务暂不可用，请稍后重试或检查 OCR 运行状态');
    if (['OCR_WORKER_INPUT_INVALID', 'OCR_WORKER_INPUT_EMPTY'].includes(code)) return result(422, 'FILE_DECODE_FAILED', '输入文件无法读取，请检查文件后重试');
    if (code === 'OCR_WORKER_INPUT_TOO_LARGE') return result(413, 'FILE_TOO_LARGE', '输入文件超过安全限制');
    if (code === 'AI_NOT_CONFIGURED') return result(400, 'AI_CONFIG_INVALID', '请先配置 AI 服务和模型');
    if (/^AI_HTTP_\d{3}$/.test(code) || ['AI_REQUEST_TIMEOUT', 'AI_NETWORK_ERROR', 'AI_CONNECTION_TEST_TIMEOUT', 'AI_CONNECTION_TEST_NETWORK_ERROR', 'AI_MODELS_TIMEOUT', 'AI_MODELS_NETWORK_ERROR'].includes(code)) {
      return result(502, 'AI_UPSTREAM_ERROR', (item.upstreamStatus === 429 || code === 'AI_HTTP_429') ? 'AI 服务请求受限，请检查调用频率、额度或余额' : 'AI 服务暂不可用，请检查配置和网络后重试');
    }
    current = item.cause;
  }
  return null;
}

export function toApiErrorPayload(error: unknown): ApiErrorPayload {
  const business = unwrapHttpError(error);
  if (business) {
    const data = business.data as { code?: unknown; meta?: Record<string, unknown>; errorId?: string } | undefined;
    return { error: true, status: business.status,
      code: isApiErrorCode(data?.code) ? data.code : fallbackErrorCode(business.status),
      message: /[\u3400-\u9fff]/.test(business.message) ? business.message : business.status >= 500 ? internalErrorMessage : '请求未能完成，请检查输入或访问权限后重试',
      ...(data?.meta ? { meta: data.meta } : {}) };
  }
  return classifySystemError(error) || { error: true, status: 500, code: 'INTERNAL_ERROR', message: internalErrorMessage };
}
