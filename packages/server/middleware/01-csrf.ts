import { createError, defineEventHandler } from "h3";
import { getAppConfig } from "../utils/runtime-config";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function assertLocalRequestOrigin(input: {
  method: string;
  origin?: string;
  host?: string;
  forwardedHost?: string;
  fetchSite?: string;
  trustProxy: boolean;
}) {
  if (safeMethods.has(input.method.toUpperCase())) return;
  if (input.fetchSite === "cross-site") {
    throw createError({ statusCode: 403, data: { code: "REQUEST_BLOCKED" }, statusMessage: "跨站请求已拒绝" });
  }
  if (!input.origin) return;
  let originHost = "";
  try {
    originHost = new URL(input.origin).host.toLowerCase();
  } catch {
    throw createError({ statusCode: 403, data: { code: "REQUEST_BLOCKED" }, statusMessage: "请求来源无效" });
  }
  const expectedHost = String(
    input.trustProxy && input.forwardedHost ? input.forwardedHost.split(",", 1)[0] : input.host || ""
  ).trim().toLowerCase();
  if (!expectedHost || originHost !== expectedHost) {
    throw createError({ statusCode: 403, data: { code: "REQUEST_BLOCKED" }, statusMessage: "请求来源与当前服务不一致" });
  }
}

export default defineEventHandler((event) => {
  const config = getAppConfig();
  if (config.authMode !== "local") return;
  const headers = event.node!.req!.headers;
  assertLocalRequestOrigin({
    method: event.method,
    origin: typeof headers.origin === "string" ? headers.origin : undefined,
    host: typeof headers.host === "string" ? headers.host : undefined,
    forwardedHost: typeof headers["x-forwarded-host"] === "string" ? headers["x-forwarded-host"] : undefined,
    fetchSite: typeof headers["sec-fetch-site"] === "string" ? headers["sec-fetch-site"] : undefined,
    trustProxy: config.trustProxy
  });
});
