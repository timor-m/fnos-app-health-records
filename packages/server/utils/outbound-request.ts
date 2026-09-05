import { Agent, type Dispatcher } from "undici";

type TimeoutFetchOptions = {
  timeoutMs: number;
  timeoutCode: string;
  timeoutMessage: string;
  networkCode: string;
  networkMessage: string;
};

const timeoutDispatchers = new Map<number, Dispatcher>();
const undiciTimeoutCodes = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT"
]);

function dispatcherForTimeout(timeoutMs: number) {
  // Node's built-in fetch uses Undici, whose parser otherwise gives up after
  // 300 seconds even when AbortSignal allows a longer AI request. Keep the
  // transport slightly above the application deadline so one timeout governs
  // the request and produces the expected application error code.
  const transportTimeoutMs = Math.max(10_000, timeoutMs + 5_000);
  let dispatcher = timeoutDispatchers.get(transportTimeoutMs);
  if (!dispatcher) {
    dispatcher = new Agent({
      headersTimeout: transportTimeoutMs,
      bodyTimeout: transportTimeoutMs
    });
    timeoutDispatchers.set(transportTimeoutMs, dispatcher);
  }
  return dispatcher;
}

function isTimeoutCause(cause: unknown, depth = 0): boolean {
  if (!cause || depth > 4) return false;
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) return true;
  if (typeof cause !== "object") return false;
  const code = Reflect.get(cause, "code");
  if (typeof code === "string" && undiciTimeoutCodes.has(code)) return true;
  return isTimeoutCause(Reflect.get(cause, "cause"), depth + 1);
}

export function configuredRequestTimeout(name: string, fallbackMs: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.min(10 * 60_000, Math.max(5_000, Math.round(value)));
}

export async function fetchWithTimeout(url: string | URL, init: RequestInit, options: TimeoutFetchOptions) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
      dispatcher: dispatcherForTimeout(options.timeoutMs)
    } as RequestInit);
  } catch (cause) {
    const timedOut = isTimeoutCause(cause);
    throw Object.assign(
      new Error(timedOut ? options.timeoutMessage : options.networkMessage),
      { code: timedOut ? options.timeoutCode : options.networkCode, cause }
    );
  }
}
