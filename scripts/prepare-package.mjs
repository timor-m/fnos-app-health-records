#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const rootDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const packageDir = join(rootDir, ".fnos-build", "package");
const distDir = join(rootDir, "dist");
const outputDir = join(rootDir, ".server-dist");
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const version = packageJson.version || "0.1.0";
const subVersion = `${version}.0`;

function assertConfig(condition, message) {
  if (!condition) {
    throw new Error(`Invalid template.config.json: ${message}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

assertConfig(/^[A-Za-z][A-Za-z0-9_-]*$/.test(template.appName), "appName must be URL and shell safe");
assertConfig(
  template.gatewayPrefix === `/app/${template.appName}`
    || template.gatewayPrefix.startsWith(`/app/${template.appName}/`),
  "gatewayPrefix must use /app/{appName}"
);
assertConfig(/^[A-Za-z0-9_-]+\.sock$/.test(template.gatewaySocket), "gatewaySocket must be a socket filename");
assertConfig(template.source === "thirdparty", "third-party applications must use source=thirdparty");
assertConfig(template.runAs === "package", "the template must use the least-privileged package user");

if (!existsSync(outputDir)) {
  throw new Error("Missing .server-dist directory. Run `npm run build` first.");
}

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

const appRoot = join(packageDir, "app");
const appServer = join(appRoot, "server");
const appUi = join(appRoot, "ui");
const appUiImages = join(appUi, "images");
const appOcrWorker = join(appRoot, "ocr-worker");
const appTools = join(appRoot, "tools");
const cmdDir = join(packageDir, "cmd");
const configDir = join(packageDir, "config");
const wizardDir = join(packageDir, "wizard");

for (const dir of [appServer, appUiImages, appOcrWorker, appTools, cmdDir, configDir, wizardDir]) {
  mkdirSync(dir, { recursive: true });
}

cpSync(outputDir, appServer, { recursive: true });
cpSync(join(rootDir, "packages", "ocr-worker"), appOcrWorker, { recursive: true });
copyFileSync(join(rootDir, "scripts", "write-runtime-config.mjs"), join(appTools, "write-runtime-config.mjs"));
chmodSync(join(appOcrWorker, "worker.py"), 0o755);
chmodSync(join(appOcrWorker, "setup-runtime.sh"), 0o755);
chmodSync(join(appTools, "write-runtime-config.mjs"), 0o755);

const iconsDir = join(rootDir, "packages", "assets", "icons");
const generatedIconsDir = join(iconsDir, "generated");
const packageIcon512Root = join(iconsDir, "ICON.PNG");
const packageIcon256 = join(iconsDir, "ICON_256.PNG");
const packageIcon512 = join(generatedIconsDir, "icon_512.png");
const uiIconSizes = [32, 48, 64, 72, 96, 128, 256, 512];

if (!existsSync(packageIcon512Root) || !existsSync(packageIcon256) || !existsSync(packageIcon512)) {
  throw new Error("Missing required 512px root, 256px or generated 512px package icon.");
}

copyFileSync(packageIcon512Root, join(packageDir, "ICON.PNG"));
copyFileSync(packageIcon256, join(packageDir, "ICON_256.PNG"));
copyFileSync(packageIcon512, join(packageDir, "ICON_512.PNG"));

for (const size of uiIconSizes) {
  const generatedIcon = join(generatedIconsDir, `icon_${size}.png`);
  if (!existsSync(generatedIcon)) {
    throw new Error(`Missing UI icon: packages/assets/icons/generated/icon_${size}.png`);
  }
  copyFileSync(generatedIcon, join(appUiImages, `icon_${size}.png`));
}

const licensePath = join(rootDir, "LICENSE");
if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(packageDir, "LICENSE"));
}

const privilege = {
  defaults: {
    "run-as": template.runAs
  },
  username: template.appName,
  groupname: template.appName
};

// Keep the existing administrator-shared path flow and add current-user file authorization.
const resource = {
  "api-scope": [
    "trim.file.userAccess",
    "trim.file.userAcl"
  ]
};

const manifest = `appname=${template.appName}
version=${version}
sub_version=${subVersion}
display_name=${template.displayName}
desc=${template.appDescription}
changelog=${template.releaseNotes.summary}
source=${template.source}
platform=${template.platform}
maintainer=${template.maintainer}
maintainer_url=${template.maintainerUrl}
distributor=${template.distributor}
distributor_url=${template.distributorUrl}
os_min_version=${template.osMinVersion}
desktop_uidir=ui
desktop_applaunchname=${template.desktopLaunchName}
micro_app=true
install_dep_apps=${template.runtimeDependency}
ctl_stop=true
disable_authorization_path=false
checksum=__APP_TGZ_MD5__
`;

const uiConfig = {
  ".url": {
    [template.desktopLaunchName]: {
      title: template.appTitle,
      icon: "images/icon_{0}.png",
      type: "iframe",
      protocol: "",
      gatewayPrefix: template.gatewayPrefix,
      gatewaySocket: template.gatewaySocket,
      url: template.gatewayPrefix,
      allUsers: template.uiAllUsers,
      control: {
        accessPerm: template.uiAllUsers ? "editable" : "readonly"
      }
    }
  }
};

const serverLauncher = `#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { handleUpgrade, middleware } from "./server/index.mjs";

const socketPath = process.env.FNOS_SOCKET_PATH || "";
const storageDir = process.env.STORAGE_DIR || ".";
const runtimePath = join(storageDir, "config", "runtime.json");
const runtime = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, "utf8")) : {};
const servicePort = Number(runtime.servicePort || runtime.directPort || process.env.SERVICE_PORT || ${template.localDevPort});
const gatewayPrefix = process.env.GATEWAY_PREFIX || ${JSON.stringify(template.gatewayPrefix)};
const servers = [];

function handler(accessMode) {
  return (request, response) => {
    request.healthAccessMode = accessMode;
    if (accessMode === "port" && request.url === "/") {
      response.writeHead(302, { location: gatewayPrefix });
      response.end();
      return;
    }
    middleware(request, response);
  };
}

function cleanupSocket() {
  if (socketPath) rmSync(socketPath, { force: true });
}

function shutdown() {
  let remaining = servers.length;
  if (!remaining) process.exit(0);
  for (const server of servers) {
    server.close(() => {
      remaining -= 1;
      if (remaining === 0) {
        cleanupSocket();
        process.exit(0);
      }
    });
  }
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (socketPath) {
  cleanupSocket();
  const gatewayServer = createServer(handler("gateway"));
  if (handleUpgrade) gatewayServer.on("upgrade", handleUpgrade);
  gatewayServer.on("error", (error) => { console.error(error); process.exitCode = 1; });
  gatewayServer.listen(socketPath, () => {
    chmodSync(socketPath, 0o660);
    console.log(\`fnOS gateway socket listening at \${socketPath}\`);
  });
  servers.push(gatewayServer);
}

const portServer = createServer(handler("port"));
if (handleUpgrade) portServer.on("upgrade", handleUpgrade);
portServer.on("error", (error) => { console.error(error); process.exitCode = 1; });
portServer.listen(servicePort, "0.0.0.0", () => {
  console.log(\`HTTP service listening at http://0.0.0.0:\${servicePort}\`);
});
servers.push(portServer);
`;

const appNameShell = shellQuote(template.appName);
const appTitleShell = shellQuote(template.appTitle);
const gatewayPrefixShell = shellQuote(template.gatewayPrefix);
const runtimeBinShell = shellQuote(`/var/apps/${template.runtimeDependency}/target/bin`);

const cmdMain = `#!/bin/bash

LOG_FILE="\${TRIM_PKGVAR}/info.log"
PID_FILE="\${TRIM_PKGVAR}/app.pid"
AUTHORIZED_PATHS_FILE="\${TRIM_PKGVAR}/data/config/fnos-authorized-paths"
APP_DIR="\${TRIM_APPDEST}/server"
SERVER_ENTRY="\${APP_DIR}/serve.mjs"
SOCKET_PATH="\${TRIM_APPDEST}/${template.gatewaySocket}"
OCR_WORKER_SCRIPT="\${TRIM_APPDEST}/ocr-worker/worker.py"
OCR_SETUP_SCRIPT="\${TRIM_APPDEST}/ocr-worker/setup-runtime.sh"
OCR_PYTHON_BIN="\${TRIM_PKGVAR}/data/ocr-venv/bin/python"

export PATH=${runtimeBinShell}:"\${PATH:-}"

log_msg() {
    mkdir -p "\${TRIM_PKGVAR}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "\${LOG_FILE}"
}

report_error() {
    log_msg "$1"
    if [ -n "\${TRIM_TEMP_LOGFILE:-}" ]; then
        printf "%s\\n" "$1" > "\${TRIM_TEMP_LOGFILE}"
    fi
}

sync_authorized_paths() {
    # fnOS supplies this value to lifecycle scripts. Persist it so the running
    # service can observe authorization changes without relying on stale process env.
    if [ "\${TRIM_DATA_ACCESSIBLE_PATHS+x}" != "x" ]; then
        return 0
    fi
    mkdir -p "$(dirname "\${AUTHORIZED_PATHS_FILE}")"
    umask 077
    temp_file="\${AUTHORIZED_PATHS_FILE}.$$"
    if printf "%s" "\${TRIM_DATA_ACCESSIBLE_PATHS}" > "\${temp_file}"; then
        mv -f "\${temp_file}" "\${AUTHORIZED_PATHS_FILE}"
    else
        rm -f "\${temp_file}"
        return 1
    fi
}

sync_authorized_paths || log_msg "Unable to persist fnOS authorized paths"

read_pid() {
    [ -r "\${PID_FILE}" ] || return 1
    pid="$(head -n 1 "\${PID_FILE}" | tr -d '[:space:]')"
    case "\${pid}" in
        ""|*[!0-9]*) return 1 ;;
    esac
    printf "%s" "\${pid}"
}

is_running() {
    pid="$(read_pid)" || return 1
    kill -0 "\${pid}" 2>/dev/null
}

status_app() {
    if is_running; then
        return 0
    fi
    rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
    return 1
}

start_app() {
    if status_app; then
        return 0
    fi

    if ! command -v node >/dev/null 2>&1; then
        report_error "Node.js runtime is unavailable. Reinstall the required ${template.runtimeDependency} dependency."
        return 1
    fi

    if [ ! -f "\${SERVER_ENTRY}" ]; then
        report_error "Application server entry is missing."
        return 1
    fi

    mkdir -p "\${TRIM_PKGVAR}/data" "\${TRIM_PKGVAR}/log"
    rm -f "\${SOCKET_PATH}"
    log_msg "Starting ${template.appName}"

    APP_NAME=${appNameShell} \\
    APP_TITLE=${appTitleShell} \\
    AUTH_MODE=fnos \\
    GATEWAY_PREFIX=${gatewayPrefixShell} \\
    FNOS_SOCKET_PATH="\${SOCKET_PATH}" \\
    LOG_DIR="\${TRIM_PKGVAR}/log" \\
    STORAGE_DIR="\${TRIM_PKGVAR}/data" \\
    TRIM_PKGVAR="\${TRIM_PKGVAR}" \\
    TRIM_APPDEST="\${TRIM_APPDEST}" \\
    TRIM_API_TOKEN="\${TRIM_API_TOKEN:-}" \\
    TRIM_DATA_ACCESSIBLE_PATHS="\${TRIM_DATA_ACCESSIBLE_PATHS:-}" \\
    OCR_WORKER_SCRIPT="\${OCR_WORKER_SCRIPT}" \\
    OCR_SETUP_SCRIPT="\${OCR_SETUP_SCRIPT}" \\
    OCR_PYTHON_BIN="\${OCR_PYTHON_BIN}" \\
    node "\${SERVER_ENTRY}" >> "\${LOG_FILE}" 2>&1 &

    printf "%s" "$!" > "\${PID_FILE}"
    sleep 1

    if ! status_app || [ ! -S "\${SOCKET_PATH}" ]; then
        report_error "Application failed to start. Check \${LOG_FILE}."
        return 1
    fi
}

stop_app() {
    if ! is_running; then
        rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
        return 0
    fi

    pid="$(read_pid)"
    log_msg "Stopping ${template.appName}"
    kill -TERM "\${pid}" 2>> "\${LOG_FILE}" || true

    count=0
    while kill -0 "\${pid}" 2>/dev/null && [ "\${count}" -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    if kill -0 "\${pid}" 2>/dev/null; then
        kill -KILL "\${pid}" 2>> "\${LOG_FILE}" || true
    fi

    rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
}

case "\${1:-}" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    status)
        if status_app; then
            exit 0
        fi
        exit 3
        ;;
    *)
        report_error "Unknown application command: \${1:-<empty>}"
        exit 1
        ;;
esac
`;

const uninstallWizard = [
  {
    stepTitle: "确认卸载",
    items: [
      {
        type: "tips",
        helpText: "您即将卸载此应用。请选择是否删除应用数据与日志。"
      },
      {
        type: "radio",
        field: "wizard_data_action",
        label: "数据处理",
        initValue: "keep",
        options: [
          { label: "保留数据", value: "keep" },
          { label: "删除数据", value: "delete" }
        ],
        rules: [
          {
            required: true,
            message: "请选择数据处理方式"
          }
        ]
      }
    ]
  }
];

const serviceSettingsItems = [
  {
    type: "text",
    field: "wizard_service_port",
    label: "服务端口",
    initValue: String(template.localDevPort),
    rules: [
      { required: true, message: "请输入服务端口" },
      { pattern: "^[0-9]+$", message: "服务端口只能包含数字" }
    ]
  }
];

const installWizard = [
  {
    stepTitle: "服务设置",
    items: serviceSettingsItems
  }
];

const configWizard = [{ stepTitle: "服务设置", items: serviceSettingsItems }];

const runtimeConfigCallback = (mode) => `#!/bin/bash
set -u

export PATH=${runtimeBinShell}:"\${PATH}"

ERROR_LOG="\${TRIM_TEMP_LOGFILE:-\${TRIM_PKGVAR:-/tmp}/health-records-${mode}-error.log}"
DETAIL_LOG="\${ERROR_LOG}.detail"

mkdir -p "$(dirname "\${ERROR_LOG}")"

if [ "\${TRIM_DATA_ACCESSIBLE_PATHS+x}" = "x" ]; then
    AUTHORIZED_PATHS_FILE="\${TRIM_PKGVAR}/data/config/fnos-authorized-paths"
    mkdir -p "$(dirname "\${AUTHORIZED_PATHS_FILE}")"
    umask 077
    AUTHORIZED_PATHS_TEMP="\${AUTHORIZED_PATHS_FILE}.$$"
    if printf "%s" "\${TRIM_DATA_ACCESSIBLE_PATHS}" > "\${AUTHORIZED_PATHS_TEMP}"; then
        mv -f "\${AUTHORIZED_PATHS_TEMP}" "\${AUTHORIZED_PATHS_FILE}"
    else
        rm -f "\${AUTHORIZED_PATHS_TEMP}"
    fi
fi

node "\${TRIM_APPDEST}/tools/write-runtime-config.mjs" "\${TRIM_PKGVAR}/data" ${mode} > "\${DETAIL_LOG}" 2>&1
status=$?
if [ "\${status}" -ne 0 ]; then
    {
        echo "健康档案${mode === "install" ? "安装" : "配置"}失败：服务端口配置未保存。"
        echo "请确认端口未被占用，并确认 nodejs_v22 运行环境可用。"
        cat "\${DETAIL_LOG}"
    } > "\${ERROR_LOG}"
    exit "\${status}"
fi

cat "\${DETAIL_LOG}"
exit 0
`;

const callbackScripts = {
  install_init: "#!/bin/bash\nexit 0\n",
  install_callback: runtimeConfigCallback("install"),
  upgrade_init: "#!/bin/bash\nexit 0\n",
  upgrade_callback: "#!/bin/bash\nexit 0\n",
  uninstall_init: "#!/bin/bash\nexit 0\n",
  uninstall_callback: `#!/bin/bash

if [ "\${wizard_data_action:-keep}" = "delete" ]; then
    rm -rf "\${TRIM_PKGVAR:?}/data" "\${TRIM_PKGVAR:?}/log"
fi

exit 0
	`,
  config_init: "#!/bin/bash\nexit 0\n",
  config_callback: runtimeConfigCallback("config")
};

writeFileSync(join(packageDir, "manifest"), manifest, "utf8");
writeFileSync(join(configDir, "privilege"), `${JSON.stringify(privilege, null, 2)}\n`, "utf8");
writeFileSync(join(configDir, "resource"), `${JSON.stringify(resource, null, 2)}\n`, "utf8");
writeFileSync(join(appUi, "config"), `${JSON.stringify(uiConfig, null, 2)}\n`, "utf8");
writeFileSync(join(appServer, "serve.mjs"), serverLauncher, "utf8");
writeFileSync(join(cmdDir, "main"), cmdMain, "utf8");

for (const [name, content] of Object.entries(callbackScripts)) {
  writeFileSync(join(cmdDir, name), content, "utf8");
}

writeFileSync(join(wizardDir, "uninstall"), `${JSON.stringify(uninstallWizard, null, 2)}\n`, "utf8");
writeFileSync(join(wizardDir, "install"), `${JSON.stringify(installWizard, null, 2)}\n`, "utf8");
writeFileSync(join(wizardDir, "config"), `${JSON.stringify(configWizard, null, 2)}\n`, "utf8");

for (const path of [
  join(cmdDir, "main"),
  ...Object.keys(callbackScripts).map((name) => join(cmdDir, name))
]) {
  chmodSync(path, 0o755);
}

console.log(`Prepared fnOS package directory: ${packageDir}`);
