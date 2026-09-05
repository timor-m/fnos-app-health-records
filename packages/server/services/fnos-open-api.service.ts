import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createError } from "h3";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { getAppConfig } from "../utils/runtime-config";

const defaultSocketPath = "/var/run/trim_open_gateway_apiscope.socket";
const maxResponseBytes = 1024 * 1024;

type OpenApiResponse<T> = {
  reqId?: unknown;
  code?: unknown;
  msg?: unknown;
  data?: T;
};

export type FnosUserAcl = {
  path: string;
  readable: boolean;
  writable: boolean;
  deletable: boolean;
};

function socketPath() {
  return process.env.TRIM_OPEN_API_SOCKET || defaultSocketPath;
}

function fnosUid(user: RequestUser) {
  if (user.provider !== "fnos_gateway" || !user.authenticated || !/^\d+$/.test(user.id)) {
    throw createError({ statusCode: 403, statusMessage: "当前请求缺少可信的飞牛用户身份" });
  }
  return Number(user.id);
}

export function isFnosUserFileApiConfigured() {
  return getAppConfig().authMode === "fnos"
    && Boolean(String(process.env.TRIM_API_TOKEN || "").trim())
    && existsSync(socketPath());
}

async function callFnosOpenApi<T>(requestName: string, data: Record<string, unknown>) {
  if (getAppConfig().authMode !== "fnos") {
    throw createError({ statusCode: 400, statusMessage: "当前部署环境不支持飞牛文件授权" });
  }
  const token = String(process.env.TRIM_API_TOKEN || "").trim();
  if (!token || !existsSync(socketPath())) {
    throw createError({
      statusCode: 503,
      statusMessage: "当前飞牛系统尚未提供用户文件授权 API，请升级系统后重试"
    });
  }

  const payload = JSON.stringify({
    reqId: createId("fnos_api"),
    req: requestName,
    appName: getAppConfig().appName,
    data
  });

  return new Promise<T>((resolve, reject) => {
    const request = httpRequest({
      socketPath: socketPath(),
      path: "/api/v1/trimapp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        authorization: `Bearer ${token}`
      },
      timeout: 10_000
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          request.destroy(new Error("飞牛开放 API 响应超过安全限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (size > maxResponseBytes) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OpenApiResponse<T>;
          const code = Number(parsed.code);
          if ((response.statusCode || 500) >= 400 || code !== 0) {
            reject(createError({
              statusCode: response.statusCode === 401 || response.statusCode === 403 || code === 403 ? 403 : 503,
              statusMessage: typeof parsed.msg === "string" && parsed.msg.trim()
                ? `飞牛文件授权接口返回错误：${parsed.msg.trim()}`
                : "飞牛文件授权接口暂不可用"
            }));
            return;
          }
          resolve(parsed.data as T);
        } catch {
          reject(createError({ statusCode: 503, statusMessage: "飞牛文件授权接口返回了无法识别的数据" }));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("飞牛开放 API 请求超时")));
    request.on("error", (error) => {
      reject(createError({ statusCode: 503, statusMessage: `无法连接飞牛文件授权接口：${error.message}` }));
    });
    request.end(payload);
  });
}

export async function getFnosUserAccessibleFolders(user: RequestUser) {
  const data = await callFnosOpenApi<{ paths?: unknown }>("trim.file.getUserAccessibleFolders", {
    uid: fnosUid(user)
  });
  if (!Array.isArray(data?.paths)) return [];
  return data.paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.trim())
    .filter(Boolean);
}

export async function checkFnosUserAcl(user: RequestUser, paths: string[]) {
  if (!paths.length) return [];
  const result: FnosUserAcl[] = [];
  for (let offset = 0; offset < paths.length; offset += 100) {
    const chunk = paths.slice(offset, offset + 100);
    const data = await callFnosOpenApi<unknown>("trim.file.checkUserACL", {
      uid: fnosUid(user),
      path: chunk.length === 1 ? chunk[0] : chunk
    });
    if (!Array.isArray(data)) {
      throw createError({ statusCode: 503, statusMessage: "飞牛文件权限检查返回了无法识别的数据" });
    }
    result.push(...data.flatMap((item): FnosUserAcl[] => {
      if (!item || typeof item !== "object") return [];
      const path = Reflect.get(item, "path");
      if (typeof path !== "string") return [];
      return [{
        path,
        readable: Reflect.get(item, "readable") === true,
        writable: Reflect.get(item, "writable") === true,
        deletable: Reflect.get(item, "deletable") === true
      }];
    }));
  }
  return result;
}

export async function requireFnosUserReadable(user: RequestUser, paths: string[]) {
  const uniquePaths = [...new Set(paths)];
  const permissions = await checkFnosUserAcl(user, uniquePaths);
  const readable = new Set(permissions.filter((item) => item.readable).map((item) => item.path));
  const denied = uniquePaths.find((path) => !readable.has(path));
  if (denied) {
    throw createError({ statusCode: 403, statusMessage: "当前飞牛用户没有读取所选文件或目录的权限" });
  }
}
