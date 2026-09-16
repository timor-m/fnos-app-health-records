import { getDatabase } from "../database/client.ts";
import { isAiExtractionConfigured } from "./ai-extraction.service.ts";
import { getOcrStatus } from "./ocr-runtime.service.ts";

const guideDismissedSettingKey = "setup.guide_dismissed";

function readGuideDismissed() {
  const row = getDatabase()
    .prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?")
    .get(guideDismissedSettingKey) as { valueJson: string } | undefined;
  if (!row) return false;
  try {
    return JSON.parse(row.valueJson) === true;
  } catch {
    return false;
  }
}

/* 首次使用引导状态：OCR 与 AI 缺一不可，两者就绪或管理员明确完成后向导不再出现 */
export function getSetupGuideStatus() {
  const ocr = getOcrStatus();
  return {
    ocrInstalled: ocr.available,
    ocrInstalling: ocr.installing,
    aiConfigured: isAiExtractionConfigured(),
    guideDismissed: readGuideDismissed()
  };
}

export function dismissSetupGuide() {
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(guideDismissedSettingKey, JSON.stringify(true));
  return getSetupGuideStatus();
}
