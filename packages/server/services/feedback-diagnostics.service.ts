import { deploymentType } from '../utils/deployment';
import { release } from "node:os";
import { getAppConfig } from "../utils/runtime-config";
import type { RequestAccessMode } from "../utils/access-mode";
import { getAboutSummary } from "./system.service";
import { getOcrStatus } from "./ocr-runtime.service";
import { getAiTaskSettings } from "./ai-settings.service";
import { diagnosticFeatures } from "./feedback-diagnostics-summary";

export function getFeedbackDiagnostics(accessMode: RequestAccessMode) {
  const about = getAboutSummary(accessMode);
  const config = getAppConfig();
  const deployment = deploymentType(config.authMode);
  let ocr: ReturnType<typeof getOcrStatus> | null = null;
  let ai: Parameters<typeof diagnosticFeatures>[1] = null;
  // A broken optional service must not prevent users from reporting its failure.
  try { ocr = getOcrStatus(); } catch { /* returned as unavailable */ }
  try { ai = getAiTaskSettings('report_extraction'); } catch { /* returned as unavailable */ }
  return {
    appVersion: about.appVersion,
    accessMode,
    runtime: { node: about.runtime.node, platform: about.runtime.platform, arch: about.runtime.arch },
    database: { appliedSchemaVersion: about.database.appliedSchemaVersion },
    deployment: ({ Development: '开发环境', Unknown: '未获取' } as Record<string,string>)[deployment] || deployment,
    kernelVersion: release(),
    ...diagnosticFeatures(ocr, ai)
  };
}
