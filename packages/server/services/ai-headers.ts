import { createError } from "h3";

export type AiHeaderInput = { name: string; value?: string };
const transportHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "proxy-authorization", "proxy-connection"]);

/** Omitted list preserves saved values; an explicit list replaces it, blank saved values stay unchanged. */
export function resolveAiHeaders(input: unknown, saved: Record<string, string> = {}): Record<string, string> {
  const fail = (message: string): never => { throw createError({statusCode:400,data:{code:"AI_CONFIG_INVALID"},statusMessage:message}); };
  if (input === undefined) return {...saved};
  if (!Array.isArray(input) || input.length > 32) return fail("自定义 Header 必须为列表，最多 32 项");
  const headers: Record<string, string> = Object.create(null);
  let size = 0;
  for (const row of input) {
    if (!row || typeof row !== "object" || typeof row.name !== "string" || (row.value !== undefined && typeof row.value !== "string")) return fail("自定义 Header 格式无效");
    const name = row.name.trim().toLowerCase();
    if (!name || name.length > 128 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) return fail("Header 名称只能包含有效的 HTTP 字符");
    if (transportHeaders.has(name)) return fail("不能自定义连接或传输控制 Header");
    if (Object.hasOwn(headers, name)) return fail("Header 名称不能重复（不区分大小写）");
    const value = row.value || saved[name] || "";
    if (!value) return fail("请填写新 Header 的值；已有值可留空保持不变");
    if (value.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/.test(value)) return fail("Header 值包含无效字符或超过长度限制");
    size += name.length + value.length;
    if (size > 16384) return fail("自定义 Header 总长度不能超过 16 KiB");
    headers[name] = value;
  }
  return headers;
}
