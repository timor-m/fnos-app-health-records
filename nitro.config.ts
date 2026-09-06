import templateConfig from "./template.config.json" with { type: "json" };
import { defineNitroConfig } from "nitro/config";

const configuredPrefix = process.env.GATEWAY_PREFIX ?? templateConfig.gatewayPrefix;
const gatewayPrefix = configuredPrefix === "/"
  ? ""
  : `/${configuredPrefix.replace(/^\/+|\/+$/g, "")}`;

export default defineNitroConfig({
  preset: "node-middleware",
  baseURL: gatewayPrefix ? `${gatewayPrefix}/` : "/",
  serverDir: "packages/server",
  errorHandler: "packages/server/error-handler.ts",
  /* 关闭 nitro 内建静态服务（它插队在所有中间件之前，会绕过维护模式拦截）。
     静态资源由 routes/[...path].ts 统一分发，publicAssets 仍负责构建期拷贝到 output/public */
  serveStatic: false,
  output: {
    dir: ".server-dist"
  },
  /* 压缩服务端产物，减小 fnOS 安装包体积 */
  minify: true,
  publicAssets: [
    {
      dir: ".ui-dist",
      maxAge: 0
    }
  ],
  runtimeConfig: {
    appName: templateConfig.appName,
    appTitle: templateConfig.appTitle,
    appPort: templateConfig.localDevPort,
    logLevel: templateConfig.logLevel,
    logDir: `/var/apps/${templateConfig.appName}/var/log`,
    storageDir: `/var/apps/${templateConfig.appName}/var/data`,
    directPort: templateConfig.localDevPort
  },
  routeRules: {
    "/": {
      prerender: false
    },
    "/healthz": {
      headers: {
        "cache-control": "no-store"
      }
    }
  }
});
