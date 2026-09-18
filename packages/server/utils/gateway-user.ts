import type { H3Event } from "h3";

export type GatewayUser = {
  authenticated: boolean;
  uid: string | null;
  username: string | null;
  isAdmin: boolean;
};

// The fnOS gateway writes the raw UTF-8 bytes of the NAS account name into the
// X-Trim-Username header, while Node.js decodes header values as latin1 (one
// byte per character), turning Chinese names into mojibake. Convert the bytes
// back to UTF-8. Pure ASCII values and values that are not valid UTF-8 are
// returned unchanged.
export function decodeGatewayHeaderValue(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? value : decoded;
}

export function getGatewayUser(event: H3Event): GatewayUser {
  const request = event.node!.req!;
  const accessMode = (request as typeof request & { healthAccessMode?: string }).healthAccessMode;
  // The launcher marks Unix Socket requests in-process. TCP clients cannot forge this property.
  if (accessMode !== "gateway") {
    return {
      authenticated: false,
      uid: null,
      username: null,
      isAdmin: false
    };
  }

  const rawUid = request.headers["x-trim-userid"];
  const rawUsername = request.headers["x-trim-username"];
  const uid = typeof rawUid === "string" ? rawUid : null;
  const username = typeof rawUsername === "string" ? decodeGatewayHeaderValue(rawUsername) : null;

  return {
    authenticated: Boolean(uid),
    uid,
    username,
    isAdmin: String(request.headers["x-trim-isadmin"] || "").toLowerCase() === "true"
  };
}
