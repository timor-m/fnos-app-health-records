#!/usr/bin/env node

import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { handleUpgrade, middleware } from "../.server-dist/server/index.mjs";
import templateConfig from "../template.config.json" with { type: "json" };

const socketPath = process.env.FNOS_SOCKET_PATH || "";
const port = Number(process.env.PORT || process.env.NITRO_PORT || templateConfig.localDevPort);
const host = process.env.HOST || process.env.NITRO_HOST || "127.0.0.1";
if (process.env.AUTH_MODE?.trim().toLowerCase() === "fnos" && !socketPath) {
  console.error("FNOS_SOCKET_PATH is required for fnOS gateway authentication.");
  process.exit(1);
}
const server = createServer((request, response) => {
  if (socketPath) request.healthAccessMode = "gateway";
  middleware(request, response);
});

if (!socketPath && !process.env.AUTH_MODE && process.env.NODE_ENV !== "development") {
  console.error("AUTH_MODE is required for direct HTTP deployment; set AUTH_MODE=local for Docker.");
  process.exit(1);
}

if (handleUpgrade) {
  server.on("upgrade", handleUpgrade);
}

function cleanupSocket() {
  if (socketPath) {
    rmSync(socketPath, { force: true });
  }
}

function shutdown() {
  server.close(() => {
    cleanupSocket();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

if (socketPath) {
  cleanupSocket();
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o660);
    console.log(`fnOS gateway socket listening at ${socketPath}`);
  });
} else {
  server.listen(port, host, () => {
    const configuredPrefix = process.env.GATEWAY_PREFIX ?? templateConfig.gatewayPrefix;
    const path = configuredPrefix === "/" ? "/" : `/${configuredPrefix.replace(/^\/+|\/+$/g, "")}/`;
    console.log(`Nitro listening at http://${host}:${port}${path}`);
  });
}
