export const apiErrorCodes = [
  'MEMBER_ACCESS_DENIED', 'MEMBER_MANAGE_REQUIRED', 'MEMBER_SHARE_REQUIRED',
  'MEMBER_LAST_MANAGER', 'MEMBER_PERMISSION_CONFLICT', 'RESTORE_PLAN_EXPIRED',
  'REQUEST_INVALID', 'REQUEST_BLOCKED', 'AUTH_REQUIRED', 'AUTH_INPUT_INVALID',
  'PERMISSION_DENIED', 'RATE_LIMITED', 'RESOURCE_NOT_FOUND', 'RESOURCE_CONFLICT',
  'UPLOAD_INVALID', 'UPLOAD_CONFLICT', 'FILE_TOO_LARGE', 'FILE_FORMAT_UNSUPPORTED',
  'FILE_DECODE_FAILED', 'STORAGE_UNAVAILABLE', 'DATABASE_UNAVAILABLE',
  'PROCESSING_NOT_READY', 'OCR_UNAVAILABLE', 'AI_CONFIG_INVALID', 'AI_UPSTREAM_ERROR',
  'REMOTE_SERVICE_ERROR', 'PLATFORM_UNAVAILABLE', 'INTERNAL_ERROR'
] as const;
export type ApiErrorCode = typeof apiErrorCodes[number];
export type ApiErrorPayload = {
  error: true;
  status: number;
  code: ApiErrorCode;
  message: string;
  errorId?: string;
  meta?: Record<string, unknown>;
};
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (apiErrorCodes as readonly string[]).includes(value);
}
