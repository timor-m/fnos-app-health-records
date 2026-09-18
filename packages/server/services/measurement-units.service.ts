import { getDatabase } from "../database/client";
import { ensureCoreDictionaryMaterialized } from "./indicator-dictionary.service";

/*
 * 通用测量单位兜底列表：覆盖常见医学报告单位，字典未覆盖时仍能识别。
 * 与 indicator_catalog 中的 default_unit / allowed_units_json 合并后生成最终匹配模式。
 */
const fallbackUnits = [
  "10\\^?\\d+\\/[L1]",
  /* OCR 常丢斜杠（mmolL、mgdL）：mol 族和质量/体积族放行斜杠可选。
     g/L、U/L 保持严格——gl、ul 会误伤 globulin、result 等英文单词。
     单位尾的字母 l/I 常被误读为数字 1（fL→f1、mg/dL→mg/d1、IU/L→1U/L），统一放行 [L1]/[I1l]。 */
  "mmol\\/?[L1]",
  "μmol\\/?[L1]",
  "umol\\/?[L1]",
  "nmol\\/?[L1]",
  "pmol\\/?[L1]",
  "mg\\/?d[L1]",
  "mg\\/?[L1]",
  "ng\\/?m[L1]",
  "μg\\/?[L1]",
  "g\\/[L1]",
  "L\\/[L1]",
  "m[I1l]U\\/[L1]",
  "μIU\\/m[L1]",
  "[I1l]U\\/[L1]",
  "U\\/m[L1]",
  "U\\/[L1]",
  "Cell\\/HP",
  "Cast\\/LP",
  "cells?\\/HPF",
  "\\/HPF",
  "\\/LPF",
  "MPa\\.s",
  "cm\\/s",
  "mm\\/hr",
  "m\\/s",
  "mmH[g9]",
  "bpm",
  "kg\\s*\\/\\s*m(?:2|²|㎡)",
  "kg",
  "cm",
  "mm",
  "m[L1]",
  "mV",
  "ms",
  "Angle",
  "p[g9]",
  /* OCR 形近误读：fL 常识别为 f1（数字 1 代替字母 l） */
  "f[L1]",
  "%",
  "℃"
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUnit(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, "");
}

function dictionaryUnits() {
  ensureCoreDictionaryMaterialized();
  const rows = getDatabase().prepare(`
    SELECT default_unit AS defaultUnit, allowed_units_json AS allowedUnitsJson
    FROM indicator_catalog
    WHERE default_unit IS NOT NULL OR allowed_units_json <> '[]'
  `).all() as Array<{ defaultUnit: string | null; allowedUnitsJson: string }>;
  const units = new Set<string>();
  for (const row of rows) {
    if (row.defaultUnit) units.add(normalizeUnit(row.defaultUnit));
    try {
      const parsed = JSON.parse(row.allowedUnitsJson || "[]") as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) units.add(normalizeUnit(item));
        }
      }
    } catch { /* 字典单位损坏时忽略，由通用列表兜底 */ }
  }
  return [...units].filter(Boolean).sort();
}

let cachedPattern: RegExp | null = null;
let cachedUnitsKey = "";

export function measurementUnitPattern() {
  const dynamic = dictionaryUnits();
  const key = dynamic.join("|");
  if (cachedPattern && cachedUnitsKey === key) return cachedPattern;
  const dynamicPatterns = dynamic.map(escapeRegExp);
  /* 长单位必须优先于短单位，否则 m 会提前截断 ms、mg/L、mmHg 等。 */
  const combined = [...new Set([...dynamicPatterns, ...fallbackUnits])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  cachedPattern = new RegExp(`(?:${combined.join("|")})`, "i");
  cachedUnitsKey = key;
  return cachedPattern;
}

export function measurementUnitStripPattern() {
  return new RegExp(measurementUnitPattern().source, "gi");
}

/*
 * OCR 变体单位：折叠形态（去斜杠、小写、μ→u）→ 规范写法。
 * 只收无歧义单位；U/L 与 μL 折叠后无法区分，不在此列。
 * f1 是 fL 的形近误读（数字 1 代替字母 l），不存在真实单位 f1。
 */
const foldedSlashlessUnits: Record<string, string> = {
  mmoll: "mmol/L",
  umoll: "umol/L",
  nmoll: "nmol/L",
  pmoll: "pmol/L",
  mgdl: "mg/dL",
  mgl: "mg/L",
  ngml: "ng/mL",
  ugl: "μg/L",
  /* 数字 1/9 形近误读（f1→fL、m1→mL、p9→pg、mmol1→mmol/L 等） */
  f1: "fL",
  m1: "mL",
  p9: "pg",
  mmh9: "mmHg",
  mmol1: "mmol/L",
  umol1: "umol/L",
  nmol1: "nmol/L",
  pmol1: "pmol/L",
  mgd1: "mg/dL",
  mg1: "mg/L",
  ngm1: "ng/mL",
  ug1: "μg/L",
  g1: "g/L"
};

/** 折叠单位用于比对：去空白和斜杠、小写、μ 统一为 u。 */
function foldUnit(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[μµ]/g, "u")
    .replace(/[\s/]+/g, "")
    .toLocaleLowerCase("zh-CN");
}

/** 把 OCR 变体单位（如丢斜杠的 mmolL）矫正为规范写法；无法识别时返回 null。 */
export function canonicalMeasurementUnit(value: string) {
  return foldedSlashlessUnits[foldUnit(value)] || null;
}

export function unitFromResultCell(value: string) {
  const matched = value.match(measurementUnitPattern())?.[0];
  if (!matched) return null;
  const compact = matched.replace(/\s+/g, "");
  return canonicalMeasurementUnit(compact) || compact;
}

/*
 * 未知单位不直接判失败：从结果文本中提取疑似单位片段（数字后的非数字、非趋势字符），
 * 保留原文供归一化阶段处理，避免有效指标被保守放弃。
 */
export function inferUnknownUnit(value: string) {
  const cleaned = value.normalize("NFKC").replace(/[↑↓▲▼⬆⬇]/g, "").trim();
  const numericMatch = cleaned.match(/^(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?/);
  if (!numericMatch) return null;
  const tail = cleaned.slice(numericMatch[0].length).trim();
  if (!tail || tail.length > 30) return null;
  if (/^[|｜]/.test(tail)) return null;
  return tail;
}
