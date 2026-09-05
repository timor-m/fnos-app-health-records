#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const packageDir = join(rootDir, ".fnos-build", "package");
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const errors = [];

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(relativePath) {
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function pngDimensions(relativePath) {
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (!existsSync(filePath)) {
    return null;
  }

  const buffer = readFileSync(filePath);
  const isPng = buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG";
  check(isPng, `${relativePath} must be a PNG file`);
  if (!isPng) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

for (const relativePath of [
  "manifest",
  "config/privilege",
  "config/resource",
  "app",
  "cmd",
  "wizard",
  "app/ui/config",
  "app/server/serve.mjs",
  "app/ocr-worker/worker.py",
  "app/tools/write-runtime-config.mjs",
  "wizard/install",
  "wizard/config"
]) {
  check(existsSync(join(packageDir, relativePath)), `Missing ${relativePath}`);
}

const manifestPath = join(packageDir, "manifest");
const manifest = {};
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) {
      manifest[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
}

check(manifest.appname === template.appName, "manifest.appname does not match template config");
check(manifest.version === packageJson.version, "manifest.version does not match package.json");
check(manifest.sub_version === `${packageJson.version}.0`, "manifest.sub_version does not match package.json");
check(manifest.display_name === template.displayName, "manifest.display_name does not match template config");
check(manifest.desc === template.appDescription, "manifest.desc does not match template config");
check(manifest.changelog === template.releaseNotes?.summary, "manifest.changelog does not match releaseNotes.summary");
check(manifest.source === "thirdparty", "manifest.source must be thirdparty");
check(manifest.os_min_version === template.osMinVersion, "manifest.os_min_version is missing or stale");
check(manifest.ctl_stop === "true", "service applications must expose lifecycle controls");
check(manifest.disable_authorization_path === "false", "NAS file import requires fnOS authorized paths");
check(!("service_port" in manifest), "gateway applications must not declare service_port");
check(manifest.desktop_applaunchname === template.desktopLaunchName, "desktop entry ID mismatch");

const privilege = readJson("config/privilege");
check(privilege?.defaults?.["run-as"] === "package", "config/privilege must use run-as=package");

const resource = readJson("config/resource");
check(
  JSON.stringify(resource?.["api-scope"]) === JSON.stringify(["trim.file.userAccess", "trim.file.userAcl"]),
  "fnOS user file API scopes mismatch"
);

const uiConfig = readJson("app/ui/config");
const uiEntry = uiConfig?.[".url"]?.[template.desktopLaunchName];
check(uiEntry?.gatewayPrefix === template.gatewayPrefix, "gatewayPrefix mismatch");
check(uiEntry?.gatewaySocket === template.gatewaySocket, "gatewaySocket mismatch");
check(uiEntry?.url === template.gatewayPrefix, "gateway URL mismatch");
check(uiEntry?.port === undefined, "gateway entry must not declare port");
check(manifest.micro_app === "true", "fnOS user file picker requires micro_app=true");

const iconRoot = pngDimensions("ICON.PNG");
const icon256 = pngDimensions("ICON_256.PNG");
const icon512 = pngDimensions("ICON_512.PNG");
check(iconRoot?.width === 512 && iconRoot?.height === 512, "ICON.PNG must be 512 x 512");
check(icon256?.width === 256 && icon256?.height === 256, "ICON_256.PNG must be 256 x 256");
check(icon512?.width === 512 && icon512?.height === 512, "ICON_512.PNG must be 512 x 512");

for (const iconSize of [64, 256, 512]) {
  const dimensions = pngDimensions(`app/ui/images/icon_${iconSize}.png`);
  check(
    dimensions?.width === iconSize && dimensions?.height === iconSize,
    `app/ui/images/icon_${iconSize}.png has incorrect dimensions`
  );
}

for (const scriptName of [
  "main",
  "install_init",
  "install_callback",
  "upgrade_init",
  "upgrade_callback",
  "uninstall_init",
  "uninstall_callback",
  "config_init",
  "config_callback"
]) {
  const relativePath = `cmd/${scriptName}`;
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (existsSync(filePath)) {
    check((statSync(filePath).mode & 0o111) !== 0, `${relativePath} must be executable`);
  }
}

if (existsSync(join(packageDir, "cmd/main"))) {
  const mainScript = readFileSync(join(packageDir, "cmd/main"), "utf8");
  check(mainScript.includes("fnos-authorized-paths"), "cmd/main must persist fnOS authorized paths");
  check(mainScript.includes("TRIM_DATA_ACCESSIBLE_PATHS"), "cmd/main must consume fnOS authorized paths");
  check(mainScript.includes("TRIM_API_TOKEN"), "cmd/main must pass the fnOS Open API token to the service");
}

check(!existsSync(join(packageDir, "app/ui/index.cgi")), "gateway template must not include index.cgi");
const installWizard = readJson("wizard/install");
const configWizard = readJson("wizard/config");
const wizardFields = (wizard) => Array.isArray(wizard)
  ? wizard.flatMap((step) => Array.isArray(step.items) ? step.items.map((item) => item.field).filter(Boolean) : [])
  : [];
check(JSON.stringify(wizardFields(installWizard)) === JSON.stringify(["wizard_service_port"]), "install wizard must only configure service port");
check(JSON.stringify(wizardFields(configWizard)) === JSON.stringify(["wizard_service_port"]), "config wizard must only configure service port");

const appArchivePath = join(rootDir, "dist", "app.tgz");
check(existsSync(appArchivePath), "Missing dist/app.tgz");
if (existsSync(appArchivePath) && manifest.checksum) {
  const checksum = createHash("md5").update(readFileSync(appArchivePath)).digest("hex");
  check(manifest.checksum === checksum, "manifest checksum does not match dist/app.tgz");
}

if (errors.length > 0) {
  console.error("fnOS package validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("fnOS package validation passed.");
