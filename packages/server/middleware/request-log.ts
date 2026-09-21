import { defineEventHandler } from "h3";
import { writeLog } from "../utils/logger";

export function requestLogLevel(statusCode: number) {
  if (statusCode >= 500) return "error" as const;
  if (statusCode >= 400) return "warn" as const;
  return null;
}

export default defineEventHandler((event) => {
  const startedAt = Date.now();
  const response = event.node!.res!;

  response.on("finish", () => {
    if (event.context.skipRequestLog) return;
    const level = requestLogLevel(response.statusCode);
    if (!level) return;
    void writeLog(level, "request", {
      method: event.method,
      route: event.context.matchedRoute?.route || "unmatched",
      errorId: event.context.errorId,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
});
