import { createHash } from "node:crypto";
import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";
import {
  aiInputPlanningPolicy,
  buildAiExtractionPlan,
  estimateAiUnitOutputTokens,
  localObservationsForLine,
  splitAiExtractionUnit,
  type AiExtractionPlan,
  type AiExtractionUnit,
} from "./ai-input-planner.service";
import { getAiTaskSettings } from "./ai-settings.service";
import {
  morphologySizeFromText,
  normalizeAiExtraction,
  type AiEvidence,
  type AiExecutor,
  type AiExtractionFields,
  type AiExtractionInput,
  type AiExtractionResult,
  type AiMorphologyFinding,
  type AiObservation,
  aiExtractionPromptVersion,
} from "./ai-extraction.service";
import { indicatorNameCandidates } from "./indicator-normalization.service";
import {
  mergeContentClassifications,
  reportContentClassifierVersion,
} from "./report-content-classifier.service";
import { isAiReportStructuredSectionCompatible } from "../domain/health-record";

export const aiExtractionExecutionPolicy = {
  maxConcurrency: 3,
} as const;

type UnitRow = {
  id: string;
  unitKey: string;
  unitIndex: number;
  inputHash: string;
  promptVersion: string | null;
  status: string;
  attempts: number;
  resultJson: string | null;
};

export type AiExtractionUnitEvent = {
  type:
    | "unit_started"
    | "unit_completed"
    | "format_retry"
    | "output_retry"
    | "unit_split"
    | "unit_failed";
  message: string;
  detail: Record<string, unknown>;
};

type ExecuteOptions = {
  onEvent?: (event: AiExtractionUnitEvent) => void;
  shouldContinue?: () => boolean;
};

function configuredConcurrency() {
  const configured = Number(process.env.AI_EXTRACTION_CONCURRENCY);
  if (!Number.isFinite(configured))
    return aiExtractionExecutionPolicy.maxConcurrency;
  return Math.max(
    1,
    Math.min(
      aiExtractionExecutionPolicy.maxConcurrency,
      Math.floor(configured),
    ),
  );
}

async function mapConcurrent<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean } = {},
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  const runWorker = async () => {
    while (nextIndex < items.length && !(options.stopOnError && firstError)) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        if (!options.stopOnError) continue;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(configuredConcurrency(), items.length) },
      () => runWorker(),
    ),
  );
  if (firstError && options.stopOnError) throw firstError;
  return results;
}

function errorDetails(error: unknown) {
  return {
    code: String(
      (error as { code?: string })?.code || "AI_EXTRACTION_FAILED",
    ).slice(0, 80),
    message: (error instanceof Error ? error.message : "AI 整理失败").slice(
      0,
      500,
    ),
  };
}

function configuredProvider() {
  const settings = getAiTaskSettings("report_extraction", true);
  let provider: string | null = null;
  try {
    provider = new URL(settings.baseUrl).host;
  } catch {
    provider = null;
  }
  return { provider, model: settings.model || null };
}

function syncUnitRoute(
  unitId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
) {
  getDatabase()
    .prepare(
      `
    INSERT INTO ai_extraction_unit_routes (
      unit_id, classifier_version, primary_content_type, content_types_json,
      confidence, reasons_json, document_content_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(unit_id) DO UPDATE SET
      classifier_version = excluded.classifier_version,
      primary_content_type = excluded.primary_content_type,
      content_types_json = excluded.content_types_json,
      confidence = excluded.confidence,
      reasons_json = excluded.reasons_json,
      document_content_type = excluded.document_content_type,
      updated_at = CURRENT_TIMESTAMP
  `,
    )
    .run(
      unitId,
      reportContentClassifierVersion,
      unit.classification.primaryType,
      JSON.stringify(unit.classification.contentTypes),
      unit.classification.confidence,
      JSON.stringify(unit.classification.reasons),
      plan.documentClassification.primaryType,
    );
}

function syncPlanUnits(
  jobId: string,
  reportId: string,
  plan: AiExtractionPlan,
) {
  const db = getDatabase();
  const activeKeys = new Set(plan.units.map((unit) => unit.unitKey));
  const existing = db
    .prepare(
      `
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units WHERE job_id = ?
  `,
    )
    .all(jobId) as UnitRow[];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of existing) {
      if (!activeKeys.has(row.unitKey)) {
        db.prepare(
          `
          UPDATE ai_extraction_units SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status <> 'superseded'
        `,
        ).run(row.id);
      }
    }
    const insert = db.prepare(`
      INSERT INTO ai_extraction_units (
        id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
        page_numbers_json, page_ranges_json, input_hash, character_count, candidate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, unit_key) DO UPDATE SET
        plan_hash = excluded.plan_hash,
        unit_index = excluded.unit_index,
        page_numbers_json = excluded.page_numbers_json,
        page_ranges_json = excluded.page_ranges_json,
        character_count = excluded.character_count,
        candidate_count = excluded.candidate_count,
        status = CASE
          WHEN ai_extraction_units.status = 'superseded' AND ai_extraction_units.result_json IS NOT NULL THEN 'completed'
          WHEN ai_extraction_units.status = 'superseded' THEN 'planned'
          ELSE ai_extraction_units.status
        END,
        updated_at = CURRENT_TIMESTAMP
    `);
    plan.units.forEach((unit, index) => {
      insert.run(
        createId("aiunit"),
        jobId,
        reportId,
        plan.planHash,
        unit.unitKey,
        index,
        unit.unitType,
        JSON.stringify(unit.pageNumbers),
        JSON.stringify(unit.pageRanges),
        unit.inputHash,
        unit.characterCount,
        unit.candidateRowCount,
      );
      const routeRow = db
        .prepare(
          `
        SELECT id FROM ai_extraction_units WHERE job_id = ? AND unit_key = ?
      `,
        )
        .get(jobId, unit.unitKey) as { id: string };
      syncUnitRoute(routeRow.id, plan, unit);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const rows = db
    .prepare(
      `
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units
    WHERE job_id = ? AND plan_hash = ? AND status <> 'superseded'
    ORDER BY unit_index, id
  `,
    )
    .all(jobId, plan.planHash) as UnitRow[];
  return new Map(rows.map((row) => [row.unitKey, row]));
}

function inputForUnit(
  reportId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  promptMode: AiExtractionInput["promptMode"],
): AiExtractionInput {
  return {
    reportId,
    text: unit.text,
    inputCharacters: unit.characterCount,
    pageCount: unit.pageNumbers.length,
    planHash: plan.planHash,
    plannedUnits: plan.unitCount,
    sourceInputCharacters: plan.sourceCharacterCount,
    compatibilityTruncated: false,
    unitKey: unit.unitKey,
    unitType: unit.unitType,
    pageNumbers: unit.pageNumbers,
    promptMode,
    extractionMode: unit.extractionMode,
    route: unit.route,
    allowDocumentFields: unit.allowDocumentFields,
    primaryContentType: unit.classification.primaryType,
    contentTypes: unit.classification.contentTypes,
    classificationConfidence: unit.classification.confidence,
    classificationReasons: unit.classification.reasons,
    documentContentType: plan.documentClassification.primaryType,
    candidateFacts: unit.candidateFacts,
    candidateCount: unit.candidateRowCount,
  };
}

function syncDynamicUnit(
  jobId: string,
  reportId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  unitIndex: number,
) {
  const db = getDatabase();
  db.prepare(
    `
    INSERT INTO ai_extraction_units (
      id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
      page_numbers_json, page_ranges_json, input_hash, character_count, candidate_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, unit_key) DO UPDATE SET
      unit_index = excluded.unit_index,
      page_numbers_json = excluded.page_numbers_json,
      page_ranges_json = excluded.page_ranges_json,
      input_hash = excluded.input_hash,
      character_count = excluded.character_count,
      candidate_count = excluded.candidate_count,
      updated_at = CURRENT_TIMESTAMP
  `,
  ).run(
    createId("aiunit"),
    jobId,
    reportId,
    plan.planHash,
    unit.unitKey,
    unitIndex,
    unit.unitType,
    JSON.stringify(unit.pageNumbers),
    JSON.stringify(unit.pageRanges),
    unit.inputHash,
    unit.characterCount,
    unit.candidateRowCount,
  );
  const row = db
    .prepare(
      `
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units WHERE job_id = ? AND unit_key = ?
  `,
    )
    .get(jobId, unit.unitKey) as UnitRow;
  syncUnitRoute(row.id, plan, unit);
  return row;
}

function startUnit(row: UnitRow) {
  getDatabase()
    .prepare(
      `
    UPDATE ai_extraction_units SET status = 'processing', attempts = attempts + 1,
      error_code = NULL, error_message = NULL,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    )
    .run(row.id);
  row.attempts += 1;
}

function recordAttempt(
  row: UnitRow,
  jobId: string,
  reportId: string,
  attemptType: "main" | "format_retry" | "supplement",
  inputCharacters: number,
  result: AiExtractionResult | null,
  error: unknown = null,
) {
  const configured = configuredProvider();
  const failure = error ? errorDetails(error) : null;
  const failedAttempt = error as {
    provider?: string;
    model?: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    elapsedMs?: number | null;
  } | null;
  getDatabase()
    .prepare(
      `
    INSERT INTO ai_extraction_attempts (
      id, unit_id, job_id, report_id, attempt_number, attempt_type, status,
      provider, model, prompt_version, input_characters, prompt_tokens,
      completion_tokens, elapsed_ms, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      createId("aiattempt"),
      row.id,
      jobId,
      reportId,
      row.attempts,
      attemptType,
      result ? "completed" : "failed",
      result?.provider || failedAttempt?.provider || configured.provider,
      result?.model || failedAttempt?.model || configured.model,
      result?.promptVersion || aiExtractionPromptVersion,
      inputCharacters,
      result?.promptTokens ?? failedAttempt?.promptTokens ?? null,
      result?.completionTokens ?? failedAttempt?.completionTokens ?? null,
      result?.elapsedMs ?? failedAttempt?.elapsedMs ?? null,
      failure?.code || null,
      failure?.message || null,
    );
}

function completeUnit(row: UnitRow, result: AiExtractionResult) {
  getDatabase()
    .prepare(
      `
    UPDATE ai_extraction_units SET status = 'completed', provider = ?, model = ?,
      prompt_version = ?, result_json = ?, prompt_tokens = ?, completion_tokens = ?,
      elapsed_ms = ?, error_code = NULL, error_message = NULL,
      finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    )
    .run(
      result.provider,
      result.model,
      result.promptVersion,
      JSON.stringify(result),
      result.promptTokens,
      result.completionTokens,
      result.elapsedMs,
      row.id,
    );
}

function failUnit(row: UnitRow, error: unknown) {
  const failure = errorDetails(error);
  getDatabase()
    .prepare(
      `
    UPDATE ai_extraction_units SET status = 'failed', error_code = ?, error_message = ?,
      finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `,
    )
    .run(failure.code, failure.message, row.id);
}

function parseStoredResult(row: UnitRow) {
  if (row.status !== "completed" || !row.resultJson) return null;
  try {
    return JSON.parse(row.resultJson) as AiExtractionResult;
  } catch {
    return null;
  }
}

function distinctStrings(values: Array<string | null>) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const clean = value?.trim();
    if (!clean || seen.has(clean)) return [];
    seen.add(clean);
    return [clean];
  });
}

function pickField<K extends keyof AiExtractionFields>(
  results: AiExtractionResult[],
  key: K,
): AiExtractionFields[K] {
  const candidates = results
    .flatMap((result, index) => {
      const value = result.fields[key];
      if (value === null || value === undefined || value === "") return [];
      if (Array.isArray(value) && !value.length) return [];
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        !Object.keys(value).length
      )
        return [];
      return [{ value, score: result.confidence[key as string] ?? 0, index }];
    })
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  return (candidates[0]?.value ?? null) as AiExtractionFields[K];
}

function observationKey(item: AiObservation) {
  const evidence = item.evidence
    .map((entry) => `${entry.pageNumber}:${entry.quote}`)
    .join("|");
  return [
    item.sectionName,
    item.itemCode,
    item.itemName,
    item.resultText,
    item.numericValue,
    item.unit,
    item.referenceLow,
    item.referenceHigh,
    item.referenceText,
    evidence,
  ]
    .join("\u0000")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
}

function morphologyKey(item: AiMorphologyFinding) {
  const evidence = item.evidence
    .map((entry) => `${entry.pageNumber}:${entry.quote}`)
    .join("|");
  return [
    item.organ,
    item.region,
    item.laterality,
    item.findingType,
    item.findingName,
    item.presence,
    item.rawText,
    evidence,
  ]
    .join("\u0000")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function observationSemanticIdentity(item: AiObservation) {
  const candidate =
    indicatorNameCandidates(item.normalizedName || item.itemName)[0] ||
    compactEvidence(item.normalizedName || item.itemName);
  return candidate
    .replace(/百分比|百分率|百分数|比例/g, "比率")
    .replace(/数目/g, "计数");
}

function observationResultIdentity(item: AiObservation) {
  const parsed =
    item.numericValue ??
    (() => {
      const match = item.resultText.match(/[-+]?\d+(?:\.\d+)?/);
      if (!match) return null;
      const value = Number(match[0]);
      return Number.isFinite(value) ? value : null;
    })();
  if (parsed !== null) return `number:${Number(parsed.toPrecision(12))}`;
  return `text:${compactEvidence(item.resultText)}`;
}

function evidenceSourceKeys(plan: AiExtractionPlan, item: AiObservation) {
  const keys = new Set<string>();
  for (const evidence of item.evidence) {
    const quote = compactEvidence(evidence.quote);
    if (quote.length < 2) continue;
    const page = plan.pages.find(
      (candidate) => candidate.pageNumber === evidence.pageNumber,
    );
    if (!page) continue;
    const matches = page.lines
      .flatMap((line) => {
        const source = compactEvidence(line.text);
        if (!source) return [];
        if (source === quote) return [{ line, score: 2 }];
        if (source.includes(quote))
          return [{ line, score: 1 + quote.length / source.length }];
        if (quote.includes(source))
          return [{ line, score: 1 + source.length / quote.length }];
        return [];
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.line.index - right.line.index,
      );
    if (matches[0] && (!matches[1] || matches[0].score > matches[1].score)) {
      keys.add(`${page.pageId}:${matches[0].line.id}`);
    } else {
      keys.add(`page-${evidence.pageNumber}:quote-${quote}`);
    }
  }
  return [...keys];
}

function normalizedEvidenceText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[μµ]/g, "u")
    .replace(/[×✕✖＊*]/g, "x")
    .replace(/[–—−~～]/g, "-")
    .replace(/[≤≦]/g, "<=")
    .replace(/[≥≧]/g, ">=")
    .replace(/[（）()，,。.:：;；、|｜\s_]/g, "");
}

function editDistanceWithin(left: string, right: string, limit: number) {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

/*
 * OCR 常见误差只允许发生在文本锚点中：短文本最多 1 字，较长引文最多 2 字。
 * 数字不走编辑距离，避免把结果值或尺寸误纠正成参考范围中的其他数字。
 */
function fuzzyEvidenceContains(sourceValue: unknown, anchorValue: unknown) {
  const source = normalizedEvidenceText(sourceValue);
  const anchor = normalizedEvidenceText(anchorValue);
  if (!source || !anchor) return false;
  if (source.includes(anchor) || anchor.includes(source)) return true;
  if (anchor.length < 4) return false;
  const limit = anchor.length >= 16 ? 2 : 1;
  const minimumLength = Math.max(1, anchor.length - limit);
  const maximumLength = Math.min(source.length, anchor.length + limit);
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    for (let index = 0; index + length <= source.length; index += 1) {
      if (
        editDistanceWithin(source.slice(index, index + length), anchor, limit)
      )
        return true;
    }
  }
  return false;
}

function evidenceNumbers(value: unknown) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[−–—]/g, "-");
  return [...normalized.matchAll(/(?:^|[^\d.])([-+]?\d+(?:\.\d+)?)(?![\d.])/g)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isFinite(number));
}

function sameEvidenceNumber(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-12);
}

function resultComparator(value: unknown) {
  return (
    String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .match(/^(<=|>=|<|>|≤|≥)/)?.[1]
      ?.replace("≤", "<=")
      .replace("≥", ">=") || null
  );
}

/**
 * 从项目名拆出可在 OCR 行内定位的片段：全名、括号内容（如「右踝」「右」）、
 * 去括号基名、侧别词。AI 命名与原文标签常不一致（如「踝臂指数（右踝）」对应
 * 原文「右踝：1.07」），片段是同格定位结果区域的锚点。
 */
function observationNameFragments(names: string[]) {
  const fragments = new Set<string>();
  for (const name of names) {
    const normalized = name.normalize("NFKC").trim();
    if (!normalized) continue;
    fragments.add(normalized);
    for (const match of normalized.matchAll(/[（(]([^（）()]*)[）)]/g)) {
      const content = (match[1] || "").trim();
      if (content) fragments.add(content);
    }
    const base = normalized.replace(/[（(][^（）()]*[）)]/g, "").trim();
    if (base && base !== normalized) fragments.add(base);
    const laterality = normalized.match(/左侧|右侧|左踝|右踝|左眼|右眼|左耳|右耳|左|右/);
    if (laterality) fragments.add(laterality[0]);
  }
  // 长片段优先，避免「右踝」被单字「右」截断出错误余量
  return [...fragments].sort((left, right) => right.length - left.length);
}

const referenceMarkerSplit = /(?:参考范围|参考值|正常范围|正常值|reference|ref\.?)/i;

/** 「名：值」同格时取名称之后的同格余量；找不到直接子串返回 null。 */
function cellRemainderAfterFragment(cell: string, fragments: string[]) {
  const normalizedCell = cell.normalize("NFKC").toLocaleLowerCase("zh-CN");
  for (const fragment of fragments) {
    const normalizedFragment = fragment.toLocaleLowerCase("zh-CN");
    const index = normalizedCell.indexOf(normalizedFragment);
    if (index < 0) continue;
    return normalizedCell
      .slice(index + normalizedFragment.length)
      .replace(/^[：:]\s*/, "")
      .split(referenceMarkerSplit)[0]
      .trim();
  }
  return null;
}

/**
 * 「身高：175.5cm」「右踝：1.07」这类名值同格单元格拆成名/值两部分。
 * 仅当片段后紧跟冒号时拆分（「糖类抗原19-9测定」这类含数字名称不会误拆）。
 * isFullName 表示命中片段是完整项目名——只有这种情况才用原文名改写 AI 命名；
 * 侧别标签（右/右踝）只是定位锚，不能当作项目名。
 */
function splitColonValueCell(
  cell: string,
  names: string[],
  fragments: string[],
) {
  const lowerCell = cell.normalize("NFKC").toLocaleLowerCase("zh-CN");
  for (const fragment of fragments) {
    const lowerFragment = fragment
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN");
    const index = lowerCell.indexOf(lowerFragment);
    if (index < 0) continue;
    const after = lowerCell.slice(index + lowerFragment.length);
    if (!/^[：:]/.test(after)) continue;
    const remainder = after.replace(/^[：:]\s*/, "").trim();
    if (!remainder) return null;
    const isFullName = names.some(
      (name) =>
        name.normalize("NFKC").toLocaleLowerCase("zh-CN") === lowerFragment,
    );
    return {
      namePart: cell.slice(0, index + fragment.length).trim(),
      remainder,
      isFullName,
    };
  }
  return null;
}

/**
 * 结果区域候选，按优先级排列：
 * 1. 「身高：175.5cm」「右踝：1.07」这类名值同格——取同格名称后的余量；
 * 2. 「名称 | 结果」分格——取名称格的下一格；
 * 3. 无法按格定位时回退整行（保持原有行为）。
 * 只要单元格产生了候选就不整行回退，避免整行首数字兜底接受错配值。
 */
function observationResultRegions(line: string, names: string[]) {
  const regions: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = String(value || "").trim();
    if (text && !regions.includes(text)) regions.push(text);
  };
  const fragments = observationNameFragments(names);
  const cells = line
    .split(/[|｜]/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length > 1) {
    for (let index = 0; index < cells.length; index += 1) {
      const remainder = cellRemainderAfterFragment(cells[index], fragments);
      const fuzzyHit = names.some((name) =>
        fuzzyEvidenceContains(cells[index], name),
      );
      if (remainder === null && !fuzzyHit) continue;
      if (remainder) push(remainder);
      // 同格已有数值/定性结果时，下一格是另一对名值（如「右踝：1.07 | 左踝：1.08」），
      // 不能作为本项结果候选；仅当同格没有可用结果内容时才取下一格（「名称 | 结果」布局）
      const remainderHasResult =
        /\d/.test(remainder || "") ||
        /阴性|阳性|正常|异常|未见|未检出|^[-—–±]/.test(remainder || "");
      if (!remainderHasResult && cells[index + 1]) push(cells[index + 1]);
    }
    if (regions.length) return regions;
  }
  const normalizedLine = line.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const directName = names
    .map((name) => name.normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .filter(Boolean)
    .map((name) => ({ name, index: normalizedLine.indexOf(name) }))
    .filter((candidate) => candidate.index >= 0)
    .sort(
      (left, right) =>
        left.index - right.index || right.name.length - left.name.length,
    )[0];
  const afterName = directName
    ? normalizedLine.slice(directName.index + directName.name.length)
    : normalizedLine;
  push(afterName.split(referenceMarkerSplit)[0]);
  return regions;
}

function observationResultMatches(
  line: string,
  item: AiObservation,
  names: string[],
) {
  return observationResultRegions(line, names).some((region) =>
    observationResultInRegionMatches(region, item),
  );
}

function observationResultInRegionMatches(
  region: string,
  item: AiObservation,
) {
  const targetNumbers =
    item.numericValue !== null
      ? [item.numericValue]
      : evidenceNumbers(item.resultText);
  if (targetNumbers.length) {
    const sourceNumbers = evidenceNumbers(region);
    if (sourceNumbers.length < targetNumbers.length) return false;
    if (
      !targetNumbers.every((number, index) =>
        sameEvidenceNumber(number, sourceNumbers[index]),
      )
    )
      return false;
    const comparator = resultComparator(item.resultText);
    return !comparator || resultComparator(region) === comparator;
  }
  const result = normalizedEvidenceText(item.resultText);
  if (!result) return false;
  return fuzzyEvidenceContains(region, result);
}

function observationNameMatches(
  line: AiExtractionPlan["pages"][number]["lines"][number],
  item: AiObservation,
) {
  const names = [item.itemName, item.normalizedName || ""].filter(Boolean);
  const sourceMatched = names.some((name) =>
    fuzzyEvidenceContains(line.text, name),
  ) || observationNameFragments(names).some((fragment) => {
    // 「踝臂指数（右踝）」对应原文「右踝：1.07」：括号内容/侧别等 ≥2 字片段
    // 直接出现在行内即可定位，单字片段不足以作为名称证据
    if (fragment.length < 2) return false;
    return line.text
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .includes(fragment.toLocaleLowerCase("zh-CN"));
  });
  const dictionaryMatched = line.dictionaryFacts.some((fact) =>
    [fact.displayName, fact.alias].some((dictionaryName) =>
      names.some((name) => fuzzyEvidenceContains(dictionaryName, name)),
    ),
  );
  return { matched: sourceMatched || dictionaryMatched, names };
}

function normalizedUnit(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[μµ]/g, "u")
    .replace(/[×✕✖＊*]/g, "x")
    .replace(/\s+/g, "");
}

function observationUnitMatches(line: string, unit: string | null) {
  if (!unit) return false;
  const normalized = normalizedUnit(unit);
  return normalized.length >= 1 && normalizedUnit(line).includes(normalized);
}

function exactEvidenceForObservation(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  item: AiObservation,
) {
  const allowedPages = new Set(unit.pageNumbers);
  const matches = item.evidence
    .flatMap((evidence) => {
      if (!allowedPages.has(evidence.pageNumber)) return [];
      const page = plan.pages.find(
        (candidate) => candidate.pageNumber === evidence.pageNumber,
      );
      if (!page) return [];
      return page.lines
        .filter(
          (line) =>
            line.candidateKind === "scalar" && unit.text.includes(line.text),
        )
        .flatMap((line) => {
          const name = observationNameMatches(line, item);
          if (
            !name.matched ||
            !observationResultMatches(line.text, item, name.names)
          )
            return [];
          const quoteMatched =
            normalizedEvidenceText(evidence.quote).length >= 4 &&
            fuzzyEvidenceContains(line.text, evidence.quote);
          const unitMatched = observationUnitMatches(line.text, item.unit);
          const score = 2 + (quoteMatched ? 2 : 0) + (unitMatched ? 0.5 : 0);
          return [{ pageNumber: page.pageNumber, quote: line.text, score }];
        });
    })
    .sort((left, right) => right.score - left.score);
  return uniqueBy(
    matches.map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`,
  );
}

function cleanSectionLabel(value: string) {
  return value
    .replace(/^【\s*|\s*】$/g, "")
    .replace(/[:：]$/, "")
    .trim();
}

function nearestContext(
  plan: AiExtractionPlan,
  page: AiExtractionPlan["pages"][number],
  lineIndex: number,
) {
  const currentLine = page.lines.find((line) => line.index === lineIndex);
  if (currentLine?.sectionName || currentLine?.tableHeaderText) {
    return {
      section: currentLine.sectionName || null,
      tableHeader: currentLine.tableHeaderText || null,
    };
  }
  let section: string | null = null;
  let reportSection: string | null = null;
  let tableHeader: string | null = null;
  for (const line of page.lines) {
    if (line.index >= lineIndex) break;
    if (line.boundary === "section") {
      const label = cleanSectionLabel(line.text);
      if (
        /(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院).{0,12}(?:报告|报告单)$/.test(
          label,
        )
      ) {
        reportSection = label;
        section = null;
        tableHeader = null;
      } else {
        section = label;
        tableHeader = null;
      }
    } else if (line.boundary === "table_header") {
      tableHeader = line.text;
    }
  }
  const sectionLabel =
    section && reportSection && !section.includes(reportSection)
      ? `${reportSection} / ${section}`
      : section || reportSection;
  return { section: sectionLabel, tableHeader };
}

function correctedTableResult(
  item: AiObservation,
  cells: string[],
  nameCellIndex: number,
) {
  const resultCell = nameCellIndex >= 0 ? cells[nameCellIndex + 1] || "" : "";
  if (!resultCell) return item;
  if (/^[-+±]+$/.test(resultCell)) {
    const referenceCell = cells[nameCellIndex + 2] || "";
    const range = referenceCell.match(
      /([-+]?\d+(?:\.\d+)?)\s*[~～-]\s*([-+]?\d+(?:\.\d+)?)/,
    );
    return {
      ...item,
      resultText: resultCell,
      numericValue: null,
      unit: null,
      referenceLow: range ? Number(range[1]) : item.referenceLow,
      referenceHigh: range ? Number(range[2]) : item.referenceHigh,
      referenceText: range ? referenceCell : item.referenceText,
      abnormalFlag: resultCell.includes("+") ? ("abnormal" as const) : null,
    };
  }
  if (/^(?:阴性|阳性|弱阳性|正常|异常|未见|可见)$/.test(resultCell)) {
    return {
      ...item,
      resultText: resultCell,
      numericValue: null,
      unit: null,
      abnormalFlag: /^(?:阳性|弱阳性|异常|可见)$/.test(resultCell)
        ? ("abnormal" as const)
        : resultCell === "正常"
          ? ("normal" as const)
          : null,
    };
  }
  const numeric = resultCell.match(/[-+]?\d+(?:\.\d+)?/);
  if (!numeric) return item;
  const parsed = Number(numeric[0]);
  if (!Number.isFinite(parsed)) return item;
  const explicitUnit =
    resultCell.match(
      /(?:10\^?\d+\/L|mmol\/L|μmol\/L|nmol\/L|pmol\/L|mg\/dL|mg\/L|ng\/mL|μg\/L|g\/L|L\/L|U\/L|IU\/L|Cell\/HP|Cast\/LP|\/HPF|\/LPF|cm\/s|mmHg|bpm|次\s*\/\s*分|kg\s*\/\s*m(?:2|²|㎡)|kg|cm|mm|mV|ms|Angle|pg|fL|%)/i,
    )?.[0] || null;
  return {
    ...item,
    resultText: resultCell,
    numericValue: parsed,
    unit: explicitUnit || item.unit,
    abnormalFlag: /[↑▲⬆]|偏高/.test(resultCell)
      ? ("high" as const)
      : /[↓▼⬇]|偏低/.test(resultCell)
        ? ("low" as const)
        : item.abnormalFlag,
  };
}

function validatedObservation(
  plan: AiExtractionPlan,
  item: AiObservation,
  evidence: AiEvidence[],
) {
  const firstEvidence = evidence[0];
  const page = plan.pages.find(
    (candidate) => candidate.pageNumber === firstEvidence?.pageNumber,
  );
  const line = page?.lines.find(
    (candidate) => candidate.text === firstEvidence?.quote,
  );
  const inferredContext =
    page && line ? nearestContext(plan, page, line.index) : null;
  const sectionName = inferredContext?.section || item.sectionName;
  const cells = (firstEvidence?.quote || "")
    .split(/[|｜]/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const compactName = compactEvidence(item.itemName);
  const nameCellIndex = cells.findIndex((cell) => {
    const compactCell = compactEvidence(cell);
    return (
      compactCell.length >= 2 &&
      (compactCell.includes(compactName) || compactName.includes(compactCell))
    );
  });
  const names = [item.itemName, item.normalizedName || ""].filter(Boolean);
  // 「身高：175.5cm」名值同格：结果取同格余量而非下一格；
  // 仅当命中片段是完整项目名时才用原文名改写（「右踝：1.07」的「右踝」只是侧别标签）
  const colonSplit =
    nameCellIndex >= 0
      ? splitColonValueCell(
          cells[nameCellIndex],
          names,
          observationNameFragments(names),
        )
      : null;
  const resultCells = colonSplit
    ? [
        ...cells.slice(0, nameCellIndex + 1),
        colonSplit.remainder,
        ...cells.slice(nameCellIndex + 1),
      ]
    : cells;
  const sourceItemName =
    cells.length > 1 && nameCellIndex >= 0
      ? colonSplit
        ? colonSplit.isFullName
          ? colonSplit.namePart
          : item.itemName
        : cells[nameCellIndex]
      : item.itemName;
  const corrected = correctedTableResult(
    {
      ...item,
      sectionName,
      itemName: sourceItemName,
      normalizedName: null,
    },
    resultCells,
    nameCellIndex,
  );
  const currentResultCell =
    nameCellIndex >= 0 && resultCells[nameCellIndex + 1]
      ? resultCells[nameCellIndex + 1]
      : firstEvidence?.quote || "";
  const explicitHigh = /[↑▲⬆]|偏高/.test(currentResultCell);
  const explicitLow = /[↓▼⬇]|偏低/.test(currentResultCell);
  const value = corrected.numericValue;
  const inRange =
    value !== null &&
    (corrected.referenceLow === null || value >= corrected.referenceLow) &&
    (corrected.referenceHigh === null || value <= corrected.referenceHigh) &&
    (corrected.referenceLow !== null || corrected.referenceHigh !== null);
  const outOfRange =
    value !== null &&
    ((corrected.referenceLow !== null && value < corrected.referenceLow) ||
      (corrected.referenceHigh !== null && value > corrected.referenceHigh));
  let abnormalFlag = corrected.abnormalFlag;
  if (abnormalFlag === "high" && inRange && !explicitHigh) abnormalFlag = null;
  if (abnormalFlag === "low" && inRange && !explicitLow) abnormalFlag = null;
  if (abnormalFlag === "normal" && outOfRange) abnormalFlag = null;
  return { ...corrected, abnormalFlag, evidence };
}

function morphologyMeasurements(item: AiMorphologyFinding) {
  return [
    ...new Set(
      [
        item.size.length,
        item.size.width,
        item.size.height,
        ...item.measurements.map((measurement) => measurement.value),
      ].filter(
        (value): value is number => value !== null && Number.isFinite(value),
      ),
    ),
  ];
}

function exactEvidenceForMorphology(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  item: AiMorphologyFinding,
) {
  const allowedPages = new Set(unit.pageNumbers);
  const strongAnchors = [
    item.findingName,
    item.findingType,
    item.organ,
    item.region,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const preferredPages = new Set(
    item.evidence
      .map((entry) => entry.pageNumber)
      .filter((page) => allowedPages.has(page)),
  );
  const measurements = morphologyMeasurements(item);
  const pages = plan.pages.filter(
    (page) =>
      allowedPages.has(page.pageNumber) &&
      (!preferredPages.size || preferredPages.has(page.pageNumber)),
  );
  const matches = pages
    .flatMap((page) => {
      const pageLines = page.lines.filter((line) =>
        unit.text.includes(line.text),
      );
      // 超声类报告常把发现名称（提示行）与测量值（描述行）分开写，长句还会被 OCR 断行。
      // 测量数字允许由同页、含同一器官/部位锚点的描述行佐证；无锚点时维持单行严格校验。
      const locationAnchors = [item.organ, item.region].filter(
        (value): value is string => Boolean(value && value.trim()),
      );
      const companionNumbers = locationAnchors.length
        ? pageLines
            .filter((line) =>
              locationAnchors.some((anchor) =>
                fuzzyEvidenceContains(line.text, anchor),
              ),
            )
            .flatMap((line) => evidenceNumbers(line.text))
        : [];
      return pageLines.flatMap((line) => {
          const sourceNumbers = evidenceNumbers(line.text);
          const measurementsMatched = measurements.every((measurement) =>
            [...sourceNumbers, ...companionNumbers].some((sourceNumber) =>
              sameEvidenceNumber(measurement, sourceNumber),
            ),
          );
          if (!measurementsMatched) return [];
          const matchedAnchors = strongAnchors.filter((anchor) =>
            fuzzyEvidenceContains(line.text, anchor),
          );
          const semanticScore = matchedAnchors.reduce(
            (score, anchor) =>
              score + Math.min(1, normalizedEvidenceText(anchor).length / 4),
            0,
          );
          const directQuote = item.evidence.some(
            (entry) =>
              normalizedEvidenceText(entry.quote).length >= 4 &&
              fuzzyEvidenceContains(line.text, entry.quote),
          );
          const rawTextMatched =
            normalizedEvidenceText(item.rawText).length >= 4 &&
            fuzzyEvidenceContains(line.text, item.rawText);
          const strongSemanticMatch =
            semanticScore >= 1 ||
            matchedAnchors.some(
              (anchor) => normalizedEvidenceText(anchor).length >= 4,
            );
          const quotedMeasuredMatch =
            measurements.length > 0 &&
            directQuote &&
            rawTextMatched &&
            semanticScore >= 0.5;
          if (!strongSemanticMatch && !quotedMeasuredMatch) return [];
          if (!directQuote && !rawTextMatched && semanticScore < 1.5) return [];
          const score =
            semanticScore + (directQuote ? 2 : 0) + (rawTextMatched ? 1 : 0);
          return [{ pageNumber: page.pageNumber, quote: line.text, score }];
        });
    })
    .sort((left, right) => right.score - left.score);
  return uniqueBy(
    matches.slice(0, 5).map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`,
  );
}

function exactEvidenceForClinicalFact(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  evidence: AiEvidence[],
  anchors: Array<string | null>,
) {
  const allowedPages = new Set(unit.pageNumbers);
  const compactAnchors = [...anchors, ...evidence.map((entry) => entry.quote)]
    .map(compactEvidence)
    .filter((value) => value.length >= 2);
  const preferredPages = new Set(
    evidence
      .map((entry) => entry.pageNumber)
      .filter((pageNumber) => allowedPages.has(pageNumber)),
  );
  const matches = plan.pages
    .filter(
      (page) =>
        allowedPages.has(page.pageNumber) &&
        (!preferredPages.size || preferredPages.has(page.pageNumber)),
    )
    .flatMap((page) =>
      page.lines
        .filter((line) => unit.text.includes(line.text))
        .flatMap((line) => {
          const source = compactEvidence(line.text);
          const score = Math.max(
            0,
            ...compactAnchors.map((anchor) =>
              source.includes(anchor) || anchor.includes(source)
                ? Math.min(source.length, anchor.length) /
                  Math.max(source.length, anchor.length)
                : 0,
            ),
          );
          return score >= 0.35
            ? [{ pageNumber: page.pageNumber, quote: line.text, score }]
            : [];
        }),
    )
    .sort((left, right) => right.score - left.score);
  return uniqueBy(
    matches.slice(0, 5).map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`,
  );
}

function validateResultEvidence(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  result: AiExtractionResult,
) {
  const rejectedObservationSamples: Array<{
    itemName: string;
    resultText: string;
    pageNumbers: number[];
  }> = [];
  const validatedObservations =
    unit.route === "scalar" ||
    unit.route === "verification" ||
    unit.route === "document"
      ? result.fields.observations.flatMap((item) => {
          const evidence = exactEvidenceForObservation(plan, unit, item);
          if (evidence.length)
            return [validatedObservation(plan, item, evidence)];
          if (rejectedObservationSamples.length < 10) {
            rejectedObservationSamples.push({
              itemName: item.itemName,
              resultText: item.resultText,
              pageNumbers: [
                ...new Set(
                  item.evidence
                    .map((entry) => entry.pageNumber)
                    .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0),
                ),
              ],
            });
          }
          return [];
        })
      : [];
  const observations =
    unit.route === "document" && unit.candidateRowCount < 1
      ? []
      : validatedObservations;
  const morphologyFindings =
    unit.route === "morphology" ||
    unit.route === "verification" ||
    /* 覆盖整份报告的 document 单元（单页报告、概览合并单元）
       在同一契约下输出形态发现，同样需要证据校验后持久化 */
    (unit.route === "document" && unit.candidateRowCount > 0)
      ? result.fields.morphologyFindings.flatMap((item) => {
          const evidence = exactEvidenceForMorphology(plan, unit, item);
          return evidence.length
            ? [{ ...item, evidence, rawText: evidence[0].quote }]
            : [];
        })
      : [];
  const diagnoses =
    unit.route === "narrative"
      ? result.fields.diagnoses.flatMap((item) => {
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [item.diagnosisText, item.diagnosisCode, item.sectionName],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const medications =
    unit.route === "narrative"
      ? result.fields.medications.flatMap((item) => {
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [
              item.medicationName,
              item.genericName,
              item.specification,
              item.instructions,
            ],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const procedures =
    unit.route === "narrative"
      ? result.fields.procedures.flatMap((item) => {
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [item.procedureName, item.procedureCode, item.resultText],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const vaccinations =
    unit.route === "narrative"
      ? result.fields.vaccinations.flatMap((item) => {
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [item.vaccineName, item.lotNumber, item.manufacturer],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const billingSummaryEvidence =
    unit.route === "narrative" && result.fields.billingSummary
      ? exactEvidenceForClinicalFact(
          plan,
          unit,
          result.fields.billingSummary.evidence,
          [
            result.fields.billingSummary.invoiceNumber,
            result.fields.billingSummary.totalAmount === null
              ? null
              : String(result.fields.billingSummary.totalAmount),
          ],
        )
      : [];
  const billingSummary =
    result.fields.billingSummary && billingSummaryEvidence.length
      ? { ...result.fields.billingSummary, evidence: billingSummaryEvidence }
      : null;
  const billingItems =
    unit.route === "narrative"
      ? result.fields.billingItems.flatMap((item) => {
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [
              item.itemName,
              item.category,
              item.amount === null ? null : String(item.amount),
            ],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const reportSections =
    unit.route === "narrative"
      ? result.fields.reportSections.flatMap((item) => {
          if (
            !isAiReportStructuredSectionCompatible(
              plan.documentClassification.primaryType,
              item.sectionKey,
            )
          )
            return [];
          const evidence = exactEvidenceForClinicalFact(
            plan,
            unit,
            item.evidence,
            [item.title, item.content.slice(0, 300)],
          );
          return evidence.length ? [{ ...item, evidence }] : [];
        })
      : [];
  const rejectedObservations =
    result.fields.observations.length - validatedObservations.length;
  const rejectedMorphologyFindings =
    result.fields.morphologyFindings.length - morphologyFindings.length;
  const rejectedClinicalFacts =
    result.fields.diagnoses.length -
    diagnoses.length +
    result.fields.medications.length -
    medications.length +
    result.fields.procedures.length -
    procedures.length +
    result.fields.vaccinations.length -
    vaccinations.length +
    result.fields.billingItems.length -
    billingItems.length +
    (result.fields.billingSummary && !billingSummary ? 1 : 0);
  const rejectedStructuredSections =
    result.fields.reportSections.length - reportSections.length;
  const clinicalFacts = {
    diagnoses,
    medications,
    procedures,
    vaccinations,
    billingSummary,
    billingItems,
    reportSections,
  };
  const narrativeFields = {
    clinicalDiagnosis: result.fields.clinicalDiagnosis,
    purpose: result.fields.purpose,
    chiefComplaint: result.fields.chiefComplaint,
    findings: result.fields.findings,
    impression: result.fields.impression,
    summary: result.fields.summary,
    recommendation: result.fields.recommendation,
  };
  const source =
    unit.route === "verification"
      ? { observations, morphologyFindings }
        : unit.route === "morphology"
          ? { morphologyFindings }
          : unit.route === "document"
            ? {
                ...result.fields,
                observations,
                morphologyFindings,
                ...clinicalFacts,
              }
          : unit.route === "narrative"
            ? {
                ...narrativeFields,
                observations: [],
                morphologyFindings: [],
                ...clinicalFacts,
              }
            : { observations, morphologyFindings: [] };
  const normalized = normalizeAiExtraction({
    ...source,
    evidence:
      unit.route === "document" || unit.route === "narrative"
        ? result.evidence
        : {},
    confidence:
      unit.route === "document" || unit.route === "narrative"
        ? result.confidence
        : {},
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
    evidenceValidation: {
      rejectedObservations,
      rejectedMorphologyFindings,
      rejectedClinicalFacts,
      rejectedStructuredSections,
      rejectedObservationSamples,
    },
  };
}

function observationCompleteness(item: AiObservation) {
  const values = [
    item.sectionName,
    item.itemCode,
    item.normalizedName,
    item.numericValue,
    item.unit,
    item.referenceLow,
    item.referenceHigh,
    item.referenceText,
    item.abnormalFlag,
    item.method,
  ];
  let score = item.evidence.length;
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") score += 1;
  }
  return score;
}

// 同源候选合并时，临床关键字段（单位/参考范围/异常标记）若两边都有值且不一致，
// 不做"完整度高者胜出"的静默取舍，统一置空并交由读取期异常解释流程标记待核验。
function mergedTextConflict(a: string | null, b: string | null) {
  if (!a || !b) return false;
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .replace(/[μµ]/g, "u")
      .replace(/\s+/g, "");
  return normalize(a) !== normalize(b);
}

function mergedNumberConflict(a: number | null, b: number | null) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b), 1) * 1e-9;
}

function mergeObservationPair(left: AiObservation, right: AiObservation) {
  const primary =
    observationCompleteness(right) > observationCompleteness(left)
      ? right
      : left;
  const fallback = primary === left ? right : left;
  const fill = <K extends keyof AiObservation>(key: K) => {
    const value = primary[key];
    return value === null || value === undefined || value === ""
      ? fallback[key]
      : value;
  };
  return {
    ...primary,
    sectionName: fill("sectionName"),
    itemCode: fill("itemCode"),
    normalizedName: fill("normalizedName"),
    numericValue: fill("numericValue"),
    unit: mergedTextConflict(primary.unit, fallback.unit) ? null : fill("unit"),
    referenceLow: mergedNumberConflict(primary.referenceLow, fallback.referenceLow)
      ? null
      : fill("referenceLow"),
    referenceHigh: mergedNumberConflict(primary.referenceHigh, fallback.referenceHigh)
      ? null
      : fill("referenceHigh"),
    referenceText: mergedTextConflict(primary.referenceText, fallback.referenceText)
      ? null
      : fill("referenceText"),
    abnormalFlag:
      primary.abnormalFlag &&
      fallback.abnormalFlag &&
      primary.abnormalFlag !== fallback.abnormalFlag
        ? null
        : fill("abnormalFlag"),
    method: fill("method"),
    evidence: uniqueBy(
      [...left.evidence, ...right.evidence],
      (entry) => `${entry.pageNumber}:${compactEvidence(entry.quote)}`,
    ),
  } satisfies AiObservation;
}

function deduplicateObservationsBySource(
  plan: AiExtractionPlan,
  observations: AiObservation[],
) {
  const merged: AiObservation[] = [];
  const sourceIndex = new Map<string, number>();
  for (const observation of observations) {
    const semantic = observationSemanticIdentity(observation);
    const result = observationResultIdentity(observation);
    const sources = evidenceSourceKeys(plan, observation);
    const keys = sources.map(
      (source) => `${source}\u0000${semantic}\u0000${result}`,
    );
    const existingIndex = keys.flatMap((key) => {
      const index = sourceIndex.get(key);
      return index === undefined ? [] : [index];
    })[0];
    if (existingIndex === undefined || !keys.length) {
      const index = merged.push(observation) - 1;
      for (const key of keys) sourceIndex.set(key, index);
      continue;
    }
    merged[existingIndex] = mergeObservationPair(
      merged[existingIndex],
      observation,
    );
    for (const key of keys) sourceIndex.set(key, existingIndex);
  }
  return merged;
}

function withSourceDeduplication(
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const observations = deduplicateObservationsBySource(
    plan,
    result.fields.observations,
  );
  if (observations.length === result.fields.observations.length) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    observations,
    evidence: result.evidence,
    confidence: result.confidence,
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
  };
}

function compactEvidence(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（）()，,。.:：;；、|\s_\-]+/g, "");
}

function resultMatchesLine(result: AiExtractionResult, line: string) {
  const compactLine = compactEvidence(line);
  if (!compactLine) return false;
  const evidenceTexts = [
    ...result.fields.observations.flatMap((item) => [
      ...item.evidence.map((entry) => entry.quote),
      `${item.itemName}${item.resultText}`,
    ]),
    ...result.fields.morphologyFindings.flatMap((item) => [
      item.rawText,
      item.morphology || "",
      ...item.evidence.map((entry) => entry.quote),
    ]),
    ...result.fields.diagnoses.flatMap((item) => [
      item.diagnosisText,
      ...item.evidence.map((entry) => entry.quote),
    ]),
    ...result.fields.medications.flatMap((item) => [
      item.medicationName,
      ...item.evidence.map((entry) => entry.quote),
    ]),
    ...result.fields.procedures.flatMap((item) => [
      item.procedureName,
      ...item.evidence.map((entry) => entry.quote),
    ]),
    ...result.fields.vaccinations.flatMap((item) => [
      item.vaccineName,
      ...item.evidence.map((entry) => entry.quote),
    ]),
    ...(result.fields.billingSummary?.evidence.map((entry) => entry.quote) ||
      []),
    ...result.fields.billingItems.flatMap((item) => [
      item.itemName,
      ...item.evidence.map((entry) => entry.quote),
    ]),
  ]
    .map(compactEvidence)
    .filter((value) => value.length >= 4);
  return evidenceTexts.some(
    (value) => compactLine.includes(value) || value.includes(compactLine),
  );
}

function observationMatchesCandidateLine(
  result: AiExtractionResult,
  line: AiExtractionPlan["pages"][number]["lines"][number],
) {
  const bloodPressure = line.text
    .normalize("NFKC")
    .match(/(?:血压|\bBP\b)[^\d]{0,16}(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*mmHg/i);
  if (bloodPressure) {
    const systolic = Number(bloodPressure[1]);
    const diastolic = Number(bloodPressure[2]);
    if (
      systolic >= 50 &&
      systolic <= 280 &&
      diastolic >= 30 &&
      diastolic <= 180 &&
      systolic > diastolic
    ) {
      const observationValue = (item: AiObservation) => {
        if (item.numericValue !== null && Number.isFinite(item.numericValue))
          return item.numericValue;
        const matched = item.resultText.match(/[-+]?\d+(?:\.\d+)?/);
        return matched ? Number(matched[0]) : null;
      };
      const identity = (item: AiObservation) =>
        compactEvidence(
          `${item.itemCode || ""}${item.itemName}${item.normalizedName || ""}`,
        );
      const hasSystolic = result.fields.observations.some(
        (item) =>
          /收缩压|vitalsystolicbp|systolic/.test(identity(item)) &&
          observationValue(item) === systolic,
      );
      const hasDiastolic = result.fields.observations.some(
        (item) =>
          /舒张压|vitaldiastolicbp|diastolic/.test(identity(item)) &&
          observationValue(item) === diastolic,
      );
      if (hasSystolic && hasDiastolic) return true;
    }
  }
  if (resultMatchesLine(result, line.text)) return true;
  const source = compactEvidence(line.text);
  const cells = line.text.split(/[|｜]/).map((cell) => cell.trim());
  const sourceResult = compactEvidence(cells[1] || "");
  return result.fields.observations.some((item) => {
    const names = [item.itemName, item.normalizedName || ""]
      .map(compactEvidence)
      .filter(Boolean);
    const dictionaryNames = line.dictionaryFacts.flatMap((fact) =>
      [fact.displayName, fact.alias].map(compactEvidence).filter(Boolean),
    );
    const nameMatched = dictionaryNames.length
      ? dictionaryNames.some((dictionaryName) =>
          names.some(
            (name) =>
              name === dictionaryName ||
              name.includes(dictionaryName) ||
              dictionaryName.includes(name),
          ),
        )
      : names.some((name) => name.length >= 2 && source.includes(name));
    if (!nameMatched) return false;
    const resultText = compactEvidence(item.resultText);
    if (
      resultText &&
      (sourceResult === resultText || source.includes(resultText))
    )
      return true;
    if (item.numericValue === null) return false;
    return new RegExp(
      `(?:^|[^\\d.])${String(item.numericValue).replace(".", "\\.")}(?:$|[^\\d.])`,
    ).test(line.text.normalize("NFKC"));
  });
}

function morphologySizeValuesInMm(size: {
  length: number | null;
  width: number | null;
  height: number | null;
  unit: string | null;
}) {
  const unit = size.unit?.toLocaleLowerCase() || null;
  const scale = unit === "cm" ? 10 : unit === "m" ? 1000 : 1;
  return [size.length, size.width, size.height]
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .map((value) => Number((value * scale).toFixed(3)))
    .sort((left, right) => right - left);
}

function morphologySizesEquivalent(
  left: ReturnType<typeof morphologySizeFromText>,
  right: AiMorphologyFinding["size"],
) {
  const leftValues = morphologySizeValuesInMm(left);
  const rightValues = morphologySizeValuesInMm(right);
  return (
    leftValues.length > 0 &&
    leftValues.length === rightValues.length &&
    leftValues.every(
      (value, index) => Math.abs(value - rightValues[index]) <= 0.5,
    )
  );
}

function morphologyLateralityFromText(value: string) {
  if (/双侧|双叶|双肾|双肺|双乳/.test(value)) return "bilateral";
  if (/左侧|左叶|左肾|左肺|左乳/.test(value)) return "left";
  if (/右侧|右叶|右肾|右肺|右乳/.test(value)) return "right";
  return "unspecified";
}

function morphologyOrganFromText(value: string) {
  const match = value.match(
    /锁骨下动脉|颈动脉|椎动脉|甲状腺|乳腺|肝脏|肝左叶|肝右叶|胆囊|胆管|胰腺|脾脏|左肾|右肾|双肾|肾脏|膀胱|前列腺|子宫|卵巢|左肺|右肺|双肺|肺部|心脏|淋巴结/,
  )?.[0];
  if (!match) return "";
  if (/^肝/.test(match)) return "肝脏";
  if (/肾/.test(match)) return "肾脏";
  if (/肺/.test(match)) return "肺";
  return match;
}

function morphologyRegionFromText(value: string) {
  return (
    value.match(
      /左叶|右叶|上叶|中叶|下叶|峡部|上极|中极|下极|胰头|胰体|胰尾|胆囊颈|胆囊体|胆囊底|宫腔|内膜|上段|中段|下段/,
    )?.[0] || ""
  );
}

function morphologyFindingMatchesLineLocation(
  finding: AiMorphologyFinding,
  line: string,
) {
  const findingText = [
    finding.organ,
    finding.region,
    finding.findingName,
    finding.findingType,
    finding.morphology,
  ]
    .filter(Boolean)
    .join(" ");
  const lineOrgan = morphologyOrganFromText(line);
  const findingOrgan = morphologyOrganFromText(findingText);
  if (!lineOrgan || !findingOrgan || lineOrgan !== findingOrgan) return false;
  const lineLaterality = morphologyLateralityFromText(line);
  const findingLaterality =
    finding.laterality === "unspecified"
      ? morphologyLateralityFromText(findingText)
      : finding.laterality;
  if (
    lineLaterality !== "unspecified" &&
    findingLaterality !== "unspecified" &&
    lineLaterality !== findingLaterality
  )
    return false;
  const lineRegion = morphologyRegionFromText(line);
  const findingRegion = morphologyRegionFromText(findingText);
  return !lineRegion || !findingRegion || lineRegion === findingRegion;
}

function morphologyFindingMatchesLineSemantics(
  finding: AiMorphologyFinding,
  line: string,
) {
  const findingText = `${finding.findingType} ${finding.findingName}`;
  if (/脂肪肝/.test(findingText)) return false;
  const directTypes = [
    "囊肿",
    "结节",
    "斑块",
    "息肉",
    "结石",
    "钙化",
    "占位",
    "肿块",
    "包块",
    "团块",
    "积液",
    "增生",
    "萎缩",
    "狭窄",
    "扩张",
    "卵泡",
    "脂肪肝",
    "磨玻璃影",
    "淋巴结",
  ];
  if (
    directTypes.some(
      (type) => findingText.includes(type) && line.includes(type),
    )
  )
    return true;
  /* 超声详细描述可能只写“强/高回声区”，结论才命名为钙化灶。只在有明确尺寸时
     允许该语义桥接，最终还会要求同页、同器官/部位和双向唯一。 */
  return (
    /钙化/.test(findingText) &&
    /(?:强|高)回声(?:区|灶)/.test(line) &&
    morphologySizeValuesInMm(morphologySizeFromText(line)).length > 0
  );
}

function morphologyMeasurementEntries(
  line: string,
  size: ReturnType<typeof morphologySizeFromText>,
) {
  if (size.length === null || !size.unit) return [];
  if (size.width === null && size.height === null) {
    const key =
      line.match(
        /(直径|长径|短径|厚度|内径|大小)[^\d]{0,8}\d+(?:\.\d+)?\s*(?:mm|cm|m)\b/i,
      )?.[1] || "大小";
    return [{ key, value: size.length, unit: size.unit }];
  }
  return [
    { key: "长径", value: size.length, unit: size.unit },
    size.width === null
      ? null
      : { key: "短径", value: size.width, unit: size.unit },
    size.height === null
      ? null
      : { key: "厚度", value: size.height, unit: size.unit },
  ].filter(
    (item): item is { key: string; value: number; unit: string } =>
      item !== null,
  );
}

function withDeterministicMorphologyMeasurements(
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const candidates = plan.pages.flatMap((page) =>
    page.lines.flatMap((line) => {
      if (line.candidateKind !== "morphology") return [];
      const size = morphologySizeFromText(line.text);
      if (!morphologySizeValuesInMm(size).length) return [];
      const targetIndexes = result.fields.morphologyFindings.flatMap(
        (finding, index) => {
          if (morphologySizeValuesInMm(finding.size).length) return [];
          if (
            !finding.evidence.some(
              (entry) => entry.pageNumber === page.pageNumber,
            )
          )
            return [];
          if (!morphologyFindingMatchesLineLocation(finding, line.text))
            return [];
          if (!morphologyFindingMatchesLineSemantics(finding, line.text))
            return [];
          return [index];
        },
      );
      return [{ pageNumber: page.pageNumber, line, size, targetIndexes }];
    }),
  );
  const candidateCountByTarget = new Map<number, number>();
  for (const candidate of candidates) {
    if (candidate.targetIndexes.length !== 1) continue;
    const targetIndex = candidate.targetIndexes[0];
    candidateCountByTarget.set(
      targetIndex,
      (candidateCountByTarget.get(targetIndex) || 0) + 1,
    );
  }
  const findings = result.fields.morphologyFindings.map((finding) => ({
    ...finding,
    size: { ...finding.size },
    measurements: [...finding.measurements],
    evidence: [...finding.evidence],
  }));
  let changed = false;
  for (const candidate of candidates) {
    if (candidate.targetIndexes.length !== 1) continue;
    const targetIndex = candidate.targetIndexes[0];
    if (candidateCountByTarget.get(targetIndex) !== 1) continue;
    const finding = findings[targetIndex];
    finding.size = { ...candidate.size };
    finding.measurements = morphologyMeasurementEntries(
      candidate.line.text,
      candidate.size,
    );
    if (
      !finding.evidence.some(
        (entry) =>
          entry.pageNumber === candidate.pageNumber &&
          compactEvidence(entry.quote) === compactEvidence(candidate.line.text),
      )
    ) {
      finding.evidence.push({
        pageNumber: candidate.pageNumber,
        quote: candidate.line.text,
      });
    }
    changed = true;
  }
  if (!changed) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    morphologyFindings: findings,
    evidence: result.evidence,
    confidence: result.confidence,
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
  };
}

function morphologyMatchesCandidateLine(
  result: AiExtractionResult,
  line: AiExtractionPlan["pages"][number]["lines"][number],
) {
  const sourceSize = morphologySizeFromText(line.text);
  const sourceDimensions = morphologySizeValuesInMm(sourceSize);
  if (!sourceDimensions.length && resultMatchesLine(result, line.text))
    return true;
  const source = compactEvidence(line.text);
  return result.fields.morphologyFindings.some((item) => {
    // AI 结构化名称（如“肝右叶囊肿”）常与原文措辞不同（“囊性回声”），字面锚点
    // 计不出来；但只要该发现的原文/证据引用精确覆盖这一行，身份即已确认。
    const evidenceMatched = [
      item.rawText,
      item.morphology || "",
      ...item.evidence.map((entry) => entry.quote),
    ]
      .map(compactEvidence)
      .some(
        (value) =>
          value.length >= 4 &&
          (source.includes(value) || value.includes(source)),
      );
    const strongAnchors = [
      item.findingName,
      item.findingType,
      item.organ,
      item.region,
    ]
      .map(compactEvidence)
      .filter((value) => value.length >= 2);
    const matchedAnchors = strongAnchors.filter(
      (anchor) => source.includes(anchor) || anchor.includes(source),
    ).length;
    const measurements = [
      item.size.length,
      item.size.width,
      item.size.height,
    ].filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
    const measurementMatched = sourceDimensions.length
      ? morphologySizesEquivalent(sourceSize, item.size)
      : !measurements.length ||
        measurements.some((value) =>
          new RegExp(
            `(?:^|[^\\d.])${String(value).replace(".", "\\.")}(?:$|[^\\d.])`,
          ).test(line.text),
        );
    return (
      measurementMatched &&
      (evidenceMatched ||
        matchedAnchors >= 2 ||
        strongAnchors.some(
          (anchor) => anchor.length >= 4 && source.includes(anchor),
        ))
    );
  });
}

function resultMatchesCandidateLine(
  result: AiExtractionResult,
  line: AiExtractionPlan["pages"][number]["lines"][number],
) {
  return line.candidateKind === "morphology"
    ? morphologyMatchesCandidateLine(result, line)
    : observationMatchesCandidateLine(result, line);
}

function unitCandidateLines(plan: AiExtractionPlan, unit: AiExtractionUnit) {
  if (
    unit.route === "narrative" ||
    (unit.route === "document" && unit.candidateRowCount === 0)
  )
    return [];
  return unit.pageRanges.flatMap((range) => {
    const page = plan.pages.find((item) => item.pageId === range.pageId);
    if (!page) return [];
    const rangeLines =
      unit.unitType === "complete_pages"
        ? page.lines
        : page.lines.filter(
            (line) =>
              line.index >= range.lineStart && line.index <= range.lineEnd,
          );
    return rangeLines
      .filter(
        (line) =>
          (unit.route === "verification"
            ? unit.candidateFacts.some(
                (fact) =>
                  fact.pageNumber === page.pageNumber &&
                  fact.sourceText === line.text,
              )
            : line.candidateKind === unit.extractionMode) &&
          localObservationsForLine(line).length === 0 &&
          unit.text.includes(line.text),
      )
      .map((line) => ({ page, line }));
  });
}

function supplementUnits(plan: AiExtractionPlan, result: AiExtractionResult) {
  type Candidate = {
    page: AiExtractionPlan["pages"][number];
    line: AiExtractionPlan["pages"][number]["lines"][number];
  };
  type Block = {
    page: AiExtractionPlan["pages"][number];
    pageNumber: number;
    extractionMode: AiExtractionUnit["extractionMode"];
    candidates: Candidate[];
    text: string;
    chunkIndex: number;
    chunkCount: number;
  };
  const byPageAndMode = new Map<string, Candidate[]>();
  for (const unit of plan.units.filter(
    (item) => item.unitType !== "supplement",
  )) {
    for (const candidate of unitCandidateLines(plan, unit)) {
      if (resultMatchesCandidateLine(result, candidate.line)) continue;
      if (candidate.line.candidateResolutionReason !== "supplement_required")
        continue;
      const key = `${candidate.page.pageNumber}:${unit.extractionMode}`;
      const current = byPageAndMode.get(key) || [];
      if (!current.some((item) => item.line.id === candidate.line.id))
        current.push(candidate);
      byPageAndMode.set(key, current);
    }
  }
  const rawBlocks: Block[] = [...byPageAndMode.entries()].flatMap(
    ([key, candidates]) => {
      if (!candidates.length) return [];
      const [pageNumberText, mode] = key.split(":");
      const pageNumber = Number(pageNumberText);
      const extractionMode = mode as AiExtractionUnit["extractionMode"];
      const page = candidates[0].page;
      const contexts = candidates.map((item) =>
        nearestContext(plan, page, item.line.index),
      );
      const sections = distinctStrings(contexts.map((item) => item.section));
      const headers = distinctStrings(contexts.map((item) => item.tableHeader));
      return [
        {
          page,
          pageNumber,
          extractionMode,
          candidates,
          chunkIndex: 1,
          chunkCount: 1,
          text: [
            `[第 ${pageNumber} 页 · ${extractionMode === "morphology" ? "形态发现" : "指标"}遗漏候选补提取]`,
            ...sections.map((item) => `[章节：${item.replace(/[:：]$/, "")}]`),
            ...headers.map((item) => `[表头：${item}]`),
            ...candidates.map((item) => item.line.text),
          ].join("\n"),
        },
      ];
    },
  );
  const blocks = rawBlocks.flatMap((block) => {
    const maximum = block.extractionMode === "morphology" ? 16 : 30;
    const chunkCount = Math.max(
      1,
      Math.ceil(block.candidates.length / maximum),
    );
    return Array.from({ length: chunkCount }, (_, index): Block => {
      const candidates = block.candidates.slice(
        index * maximum,
        (index + 1) * maximum,
      );
      return {
        ...block,
        candidates,
        chunkIndex: index + 1,
        chunkCount,
        text: [
          `[第 ${block.pageNumber} 页 · ${block.extractionMode === "morphology" ? "形态发现" : "指标"}遗漏候选补提取${chunkCount > 1 ? ` · ${index + 1}/${chunkCount}` : ""}]`,
          ...distinctStrings(
            candidates.map(
              (item) =>
                nearestContext(plan, block.page, item.line.index).section,
            ),
          ).map((item) => `[章节：${item.replace(/[:：]$/, "")}]`),
          ...distinctStrings(
            candidates.map(
              (item) =>
                nearestContext(plan, block.page, item.line.index).tableHeader,
            ),
          ).map((item) => `[表头：${item}]`),
          ...candidates.map((item) => item.line.text),
        ].join("\n"),
      };
    });
  });
  const units: AiExtractionUnit[] = [];
  let pending: typeof blocks = [];
  const flush = () => {
    if (!pending.length) return;
    const extractionMode: AiExtractionUnit["extractionMode"] = "scalar";
    const text = pending.map((block) => block.text).join("\n\n");
    const inputHash = createHash("sha256")
      .update(
        [
          aiInputPlanningPolicy.version,
          "supplement",
          "verification",
          text,
        ].join("\u0000"),
      )
      .digest("hex");
    const pageNumbers = [
      ...new Set(pending.map((block) => block.pageNumber)),
    ].sort((left, right) => left - right);
    const candidateRowCount = pending.reduce(
      (sum, block) => sum + block.candidates.length,
      0,
    );
    const candidateFacts = pending.flatMap((block) =>
      block.candidates.map((item) => ({
        pageNumber: block.pageNumber,
        kind: item.line.candidateKind as "scalar" | "morphology",
        sourceText: item.line.text,
        dictionaryFacts: item.line.dictionaryFacts,
      })),
    );
    const morphologyCandidateCount = candidateFacts.filter(
      (fact) => fact.kind === "morphology",
    ).length;
    units.push({
      unitKey: `unit_${createHash("sha256")
        .update(`supplement|verification|${pageNumbers.join(",")}|${inputHash}`)
        .digest("hex")
        .slice(0, 24)}`,
      inputHash,
      unitType: "supplement",
      extractionMode,
      route: "verification",
      allowDocumentFields: false,
      classification: mergeContentClassifications(
        pending.map((block) => block.page.classification),
      ),
      pageNumbers,
      pageRanges: pending.map((block) => ({
        pageId: block.page.pageId,
        pageNumber: block.pageNumber,
        lineStart: Math.min(...block.candidates.map((item) => item.line.index)),
        lineEnd: Math.max(...block.candidates.map((item) => item.line.index)),
        chunkIndex: block.chunkIndex,
        chunkCount: block.chunkCount,
      })),
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount,
      localObservationCount: 0,
      estimatedOutputTokens: estimateAiUnitOutputTokens({
        pageCount: pageNumbers.length,
        characterCount: text.length,
        candidateRowCount,
        morphologyCandidateCount,
        candidateCharacters: candidateFacts.reduce(
          (sum, fact) => sum + fact.sourceText.length,
          0,
        ),
      }),
      lineCount: pending.reduce(
        (sum, block) => sum + block.candidates.length,
        0,
      ),
      text,
      candidateFacts,
    });
    pending = [];
  };
  for (const block of blocks) {
    const combinedCharacters = [...pending, block]
      .map((item) => item.text)
      .join("\n\n").length;
    const combinedCandidates = [...pending, block].reduce(
      (sum, item) => sum + item.candidates.length,
      0,
    );
    const combinedMorphologyCandidates = [...pending, block].reduce(
      (sum, item) =>
        sum +
        (item.extractionMode === "morphology" ? item.candidates.length : 0),
      0,
    );
    const estimatedOutputTokens = estimateAiUnitOutputTokens({
      pageCount: new Set([...pending, block].map((item) => item.pageNumber))
        .size,
      characterCount: combinedCharacters,
      candidateRowCount: combinedCandidates,
      morphologyCandidateCount: combinedMorphologyCandidates,
    });
    if (
      pending.length &&
      (new Set([...pending, block].map((item) => item.pageNumber)).size >
        aiInputPlanningPolicy.maxSparsePagesPerUnit ||
        combinedCharacters > aiInputPlanningPolicy.targetCharacters ||
        estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens ||
        combinedCandidates > aiInputPlanningPolicy.maxCandidateRowsPerUnit)
    )
      flush();
    pending.push(block);
  }
  flush();
  return units;
}

const basicMeasurements = [
  {
    name: "身高",
    aliases: /(?:身高|height)/i,
    unit: /(cm|mm|m)\b/i,
    minimum: 30,
    maximum: 260,
  },
  {
    name: "体重",
    aliases: /(?:体重(?!指数)|weight)/i,
    unit: /(kg(?!\s*\/)|公斤|千克)\b/i,
    minimum: 2,
    maximum: 400,
  },
  {
    name: "体重指数",
    aliases: /(?:体重指数|BMI)/i,
    unit: /(kg\s*\/\s*m(?:2|²))\b/i,
    minimum: 5,
    maximum: 100,
    unitOptional: true,
  },
  {
    name: "腰围",
    aliases: /腰围/i,
    unit: /(cm|mm|m)\b/i,
    minimum: 20,
    maximum: 250,
  },
  {
    name: "臀围",
    aliases: /臀围/i,
    unit: /(cm|mm|m)\b/i,
    minimum: 20,
    maximum: 300,
  },
  {
    name: "脉搏",
    aliases: /(?:脉搏|心率|pulse)/i,
    unit: /(bpm|次\s*\/\s*分)/i,
    minimum: 20,
    maximum: 250,
    unitOptional: true,
  },
] as const;

function deterministicTableObservations(
  plan: AiExtractionPlan,
): AiObservation[] {
  const seen = new Set<string>();
  return plan.pages.flatMap((page) =>
    page.lines.flatMap((line) =>
      localObservationsForLine(line).flatMap((fact) => {
        const key = `${fact.pageNumber}:${fact.observationKey}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            sectionName: fact.sectionName,
            itemCode: null,
            itemName: fact.itemName,
            normalizedName: fact.normalizedName,
            resultText: fact.resultText,
            numericValue: fact.numericValue,
            unit: fact.unit,
            referenceLow: fact.referenceLow,
            referenceHigh: fact.referenceHigh,
            referenceText: fact.referenceText,
            abnormalFlag: fact.abnormalFlag,
            method: null,
            evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }],
          },
        ];
      }),
    ),
  );
}

function deterministicBasicObservations(
  plan: AiExtractionPlan,
  fields: AiExtractionFields,
) {
  const existing = new Set(
    fields.observations.map((item) => compactEvidence(item.itemName)),
  );
  for (const definition of basicMeasurements) {
    if (
      fields.observations.some((item) => definition.aliases.test(item.itemName))
    ) {
      existing.add(compactEvidence(definition.name));
    }
  }
  if (fields.observations.some((item) => /收缩压/.test(item.itemName)))
    existing.add(compactEvidence("收缩压"));
  if (fields.observations.some((item) => /舒张压/.test(item.itemName)))
    existing.add(compactEvidence("舒张压"));
  const additions: AiObservation[] = [];
  const add = (item: AiObservation) => {
    const key = compactEvidence(item.itemName);
    if (existing.has(key)) return;
    existing.add(key);
    additions.push(item);
  };
  for (const page of plan.pages) {
    for (const line of page.lines) {
      for (const definition of basicMeasurements) {
        if (existing.has(compactEvidence(definition.name))) continue;
        const alias = line.text.match(definition.aliases);
        if (!alias || alias.index === undefined) continue;
        const suffix = line.text.slice(
          alias.index + alias[0].length,
          alias.index + alias[0].length + 48,
        );
        const valueMatch = suffix.match(/^[^\d+-]{0,12}([-+]?\d+(?:\.\d+)?)/);
        if (!valueMatch || /参考|范围/.test(suffix.slice(0, valueMatch.index)))
          continue;
        const value = Number(valueMatch[1]);
        if (
          !Number.isFinite(value) ||
          value < definition.minimum ||
          value > definition.maximum
        )
          continue;
        const afterValue = suffix.slice(
          (valueMatch.index || 0) + valueMatch[0].length,
        );
        const unitMatch = afterValue.match(definition.unit);
        if (
          !unitMatch &&
          !("unitOptional" in definition && definition.unitOptional)
        )
          continue;
        add({
          sectionName: "一般检查",
          itemCode: null,
          itemName: definition.name,
          normalizedName: definition.name,
          resultText: valueMatch[1],
          numericValue: value,
          unit: unitMatch?.[1]?.replace(/\s+/g, "") || null,
          referenceLow: null,
          referenceHigh: null,
          referenceText: null,
          abnormalFlag: /[↑▲]|偏高/.test(line.text)
            ? "high"
            : /[↓▼]|偏低/.test(line.text)
              ? "low"
              : null,
          method: null,
          evidence: [{ pageNumber: page.pageNumber, quote: line.text }],
        });
      }
      if (
        !["收缩压", "舒张压"].every((name) =>
          existing.has(compactEvidence(name)),
        )
      ) {
        const bloodPressure = line.text.match(
          /(?:血压|BP)[^\d]{0,12}(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*(mmHg)?/i,
        );
        if (bloodPressure) {
          const systolic = Number(bloodPressure[1]);
          const diastolic = Number(bloodPressure[2]);
          if (
            systolic >= 50 &&
            systolic <= 280 &&
            diastolic >= 30 &&
            diastolic <= 180
          ) {
            for (const [name, value] of [
              ["收缩压", systolic],
              ["舒张压", diastolic],
            ] as const)
              add({
                sectionName: "一般检查",
                itemCode: null,
                itemName: name,
                normalizedName: name,
                resultText: String(value),
                numericValue: value,
                unit: "mmHg",
                referenceLow: null,
                referenceHigh: null,
                referenceText: null,
                abnormalFlag: null,
                method: null,
                evidence: [{ pageNumber: page.pageNumber, quote: line.text }],
              });
          }
        }
      }
    }
  }
  return additions;
}

type VascularMetric = "abi" | "bapwv";
type VascularSide = "left" | "right";

function vascularMetricFromText(text: string): VascularMetric | null {
  if (/ba\s*PWV|肱踝脉搏波|臂踝脉搏波|\bPWV\b/i.test(text)) return "bapwv";
  if (/\bABI\b|踝肱指数|踝臂指数/i.test(text)) return "abi";
  return null;
}

function vascularSideFromText(text: string): VascularSide | null {
  if (/右(?:侧|踝)?/.test(text)) return "right";
  if (/左(?:侧|踝)?/.test(text)) return "left";
  return null;
}

function vascularSideValue(text: string, side: VascularSide) {
  const label = side === "right" ? "右(?:侧|踝)?" : "左(?:侧|踝)?";
  const afterSide = text.match(
    new RegExp(
      `${label}\\s*(?:(?:ba\\s*PWV|PWV|ABI|踝肱指数|踝臂指数)\\s*)?[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
      "i",
    ),
  );
  const beforeSide = text.match(
    new RegExp(
      `(?:ba\\s*PWV|PWV|ABI|踝肱指数|踝臂指数)\\s*[（(]?${side === "right" ? "右" : "左"}[）)]?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
      "i",
    ),
  );
  const value = Number(afterSide?.[1] || beforeSide?.[1]);
  return Number.isFinite(value) ? value : null;
}

function deterministicVascularObservations(
  plan: AiExtractionPlan,
  fields: AiExtractionFields,
) {
  const existing = new Set<string>();
  for (const observation of fields.observations) {
    const metric = vascularMetricFromText(observation.itemName);
    const side = vascularSideFromText(observation.itemName);
    if (metric && side) existing.add(`${metric}:${side}`);
  }
  const additions: AiObservation[] = [];
  const bilateralEvidence = new Set<string>();
  for (const page of plan.pages) {
    let activeMetric: VascularMetric | null = null;
    for (const line of page.lines) {
      const explicitMetric = vascularMetricFromText(line.text);
      if (explicitMetric) activeMetric = explicitMetric;
      const metric = explicitMetric || activeMetric;
      if (!metric) continue;
      const right = vascularSideValue(line.text, "right");
      const left = vascularSideValue(line.text, "left");
      if (right !== null && left !== null)
        bilateralEvidence.add(compactEvidence(line.text));
      for (const [side, value] of [
        ["right", right],
        ["left", left],
      ] as const) {
        if (value === null || existing.has(`${metric}:${side}`)) continue;
        if (metric === "abi" && (value < 0.2 || value > 3)) continue;
        if (metric === "bapwv" && (value < 100 || value > 5000)) continue;
        const sideLabel = side === "right" ? "右侧" : "左侧";
        const itemName =
          metric === "abi"
            ? `${sideLabel}踝肱指数`
            : `${sideLabel}肱踝脉搏波传导速度`;
        existing.add(`${metric}:${side}`);
        additions.push({
          sectionName: "动脉功能检查",
          itemCode: metric === "abi" ? "ABI" : "baPWV",
          itemName,
          normalizedName: itemName,
          resultText: String(value),
          numericValue: value,
          unit: metric === "bapwv" ? "cm/s" : null,
          referenceLow: null,
          referenceHigh: null,
          referenceText: null,
          abnormalFlag: null,
          method: null,
          evidence: [{ pageNumber: page.pageNumber, quote: line.text }],
        });
      }
    }
  }
  return { additions, bilateralEvidence };
}

function withDeterministicFallback(
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const tableAdditions = deterministicTableObservations(plan).filter(
    (local) =>
      !result.fields.observations.some(
        (existing) =>
          (compactEvidence(existing.itemName) ===
            compactEvidence(local.itemName) ||
            compactEvidence(existing.normalizedName) ===
              compactEvidence(local.normalizedName)) &&
          compactEvidence(existing.resultText) ===
            compactEvidence(local.resultText) &&
          existing.evidence.some((entry) =>
            local.evidence.some(
              (candidate) =>
                entry.pageNumber === candidate.pageNumber &&
                compactEvidence(entry.quote) ===
                  compactEvidence(candidate.quote),
            ),
          ),
      ),
  );
  const fieldsWithTables = {
    ...result.fields,
    observations: [...result.fields.observations, ...tableAdditions],
  };
  const basicAdditions = deterministicBasicObservations(plan, fieldsWithTables);
  const vascular = deterministicVascularObservations(plan, fieldsWithTables);
  const observations = fieldsWithTables.observations.filter((observation) => {
    if (vascularSideFromText(observation.itemName)) return true;
    if (!vascularMetricFromText(observation.itemName)) return true;
    return !observation.evidence.some((item) =>
      vascular.bilateralEvidence.has(compactEvidence(item.quote)),
    );
  });
  const additions = [...basicAdditions, ...vascular.additions];
  if (
    !additions.length &&
    observations.length === result.fields.observations.length
  )
    return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    observations: [...observations, ...additions],
    evidence: result.evidence,
    confidence: result.confidence,
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
  };
}

function withLocalDocumentClassification(
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const local = plan.documentClassification;
  if (local.primaryType === "other" || local.confidence < 0.5) return result;
  const anchoredCheckup =
    local.primaryType === "checkup" &&
    local.reasons.includes("整份文档包含体检封面或总检章节");
  if (result.fields.reportType && !anchoredCheckup) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    reportType: local.primaryType,
    evidence: result.evidence,
    confidence: {
      ...result.confidence,
      reportType: Math.max(result.confidence.reportType || 0, local.confidence),
    },
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
  };
}

const businessIdentifierDefinitions = [
  {
    key: "physicalExamNo",
    pattern: /(?:体检编号|体检号)\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i,
  },
  { key: "reportNo", pattern: /报告号\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i },
  {
    key: "outpatientNo",
    pattern: /门诊号\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i,
  },
  {
    key: "inpatientNo",
    pattern: /住院号\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i,
  },
  { key: "examNo", pattern: /检查号\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i },
  {
    key: "specimenNo",
    pattern: /标本号\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i,
  },
  {
    key: "barcodeNo",
    pattern: /(?:条码号|条形码号)\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i,
  },
] as const;

function withDeterministicDocumentFields(
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const identifiers = { ...result.fields.identifiers };
  for (const page of plan.pages) {
    for (const line of page.lines) {
      for (const definition of businessIdentifierDefinitions) {
        if (identifiers[definition.key]) continue;
        const match = line.text.normalize("NFKC").match(definition.pattern);
        if (match?.[1]) identifiers[definition.key] = match[1];
      }
    }
  }
  const bodyParts =
    plan.documentClassification.primaryType === "checkup"
      ? result.fields.bodyParts.filter(
          (item) =>
            !/^(?:综合体检|健康体检|体检|physicalexam|checkup)$/i.test(
              compactEvidence(item.name || item.raw),
            ),
        )
      : result.fields.bodyParts;
  if (
    Object.keys(identifiers).length ===
      Object.keys(result.fields.identifiers).length &&
    bodyParts.length === result.fields.bodyParts.length
  )
    return result;
  const fields = { ...result.fields, identifiers, bodyParts };
  return {
    ...result,
    fields,
    rawResponseJson: JSON.stringify({
      ...fields,
      evidence: result.evidence,
      confidence: result.confidence,
    }),
  };
}

function localObservationQualityIdentity(
  fact: ReturnType<typeof localObservationsForLine>[number],
) {
  const result =
    fact.numericValue !== null && Number.isFinite(fact.numericValue)
      ? `number:${Number(fact.numericValue.toPrecision(12))}`
      : `text:${compactEvidence(fact.resultText)}`;
  return `${compactEvidence(fact.normalizedName || fact.itemName)}\u0000${result}`;
}

function localEvidencePriority(
  line: AiExtractionPlan["pages"][number]["lines"][number],
) {
  let score = 0;
  if (line.sourceCells.length >= 2) score += 4;
  if (line.tableHeaderText) score += 4;
  if (
    /(?:本次结果|检查结果|检验结果|实测|结果)/.test(line.tableHeaderText || "")
  )
    score += 2;
  if (/[|｜]/.test(line.text)) score += 1;
  if (line.role === "narrative" || line.contentRole === "recommendation")
    score -= 3;
  if (/(?:建议|复查|随诊|健康管理)/.test(line.text)) score -= 2;
  return score;
}

function updateCandidateQuality(
  jobId: string,
  plan: AiExtractionPlan,
  result: AiExtractionResult,
) {
  const db = getDatabase();
  const unitRows = new Map(
    (
      db
        .prepare(
          `
    SELECT id, unit_key AS unitKey FROM ai_extraction_units WHERE job_id = ?
  `,
        )
        .all(jobId) as Array<{ id: string; unitKey: string }>
    ).map((row) => [row.unitKey, row.id]),
  );
  const insertCandidate = db.prepare(`
    INSERT INTO ai_extraction_candidates (
      id, job_id, unit_id, report_id, candidate_key, source_hash, page_number,
      source_line_ids_json, kind, dictionary_keys_json, status, matched_entity_key, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, candidate_key) DO UPDATE SET
      unit_id = COALESCE(excluded.unit_id, ai_extraction_candidates.unit_id),
      status = excluded.status,
      matched_entity_key = excluded.matched_entity_key,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.prepare("DELETE FROM ai_extraction_candidates WHERE job_id = ?").run(
    jobId,
  );

  /* 同一指标同一结果可能同时出现在总检建议和明细表。候选闭环只把结构更强的
     明细证据记为 local_extracted，其余原文保留但标记 redundant，避免把重复
     摘要误报为“遗漏候选”，也让候选状态与最终趋势去重语义一致。 */
  const preferredLocalEvidence = new Map<
    string,
    {
      line: AiExtractionPlan["pages"][number]["lines"][number];
      priority: number;
    }
  >();
  for (const page of plan.pages) {
    for (const line of page.lines) {
      const priority = localEvidencePriority(line);
      for (const fact of localObservationsForLine(line)) {
        const identity = localObservationQualityIdentity(fact);
        const existing = preferredLocalEvidence.get(identity);
        if (!existing || priority > existing.priority) {
          preferredLocalEvidence.set(identity, { line, priority });
        }
      }
    }
  }

  for (const page of plan.pages) {
    for (const line of page.lines) {
      const localObservations = localObservationsForLine(line);
      if (!localObservations.length) continue;
      const redundant = localObservations.every(
        (fact) =>
          preferredLocalEvidence.get(localObservationQualityIdentity(fact))
            ?.line !== line,
      );
      const sourceHash = createHash("sha256").update(line.text).digest("hex");
      const candidateKey = createHash("sha256")
        .update(
          [
            page.pageNumber,
            line.sourceLineIds.join(","),
            "scalar",
            sourceHash,
          ].join("\u0000"),
        )
        .digest("hex");
      insertCandidate.run(
        createId("aicandidate"),
        jobId,
        null,
        plan.reportId,
        candidateKey,
        sourceHash,
        page.pageNumber,
        JSON.stringify(line.sourceLineIds),
        "scalar",
        JSON.stringify(line.dictionaryFacts.map((fact) => fact.canonicalKey)),
        redundant ? "redundant" : "local_extracted",
        localObservations.map((fact) => fact.normalizedName).join(" | "),
        redundant
          ? "duplicate_evidence:同指标同结果已由更明确的本地表格证据覆盖"
          : localObservations.length > 1
            ? `本地字典与明确表格结构已确定，共拆分 ${localObservations.length} 项`
            : "本地字典与表格结构已确定",
      );
    }
  }

  let unmatched = 0;
  for (const unit of plan.units.filter(
    (item) => item.unitType !== "supplement",
  )) {
    const candidates = unitCandidateLines(plan, unit);
    let matched = 0;
    for (const item of candidates) {
      const resolved = resultMatchesCandidateLine(result, item.line);
      const directlyExtracted =
        resolved && resultMatchesLine(result, item.line.text);
      if (resolved) matched += 1;
      else unmatched += 1;
      const sourceHash = createHash("sha256")
        .update(item.line.text)
        .digest("hex");
      const candidateKey = createHash("sha256")
        .update(
          [
            item.page.pageNumber,
            item.line.sourceLineIds.join(","),
            item.line.candidateKind,
            sourceHash,
          ].join("\u0000"),
        )
        .digest("hex");
      const matchedEntityKey =
        item.line.dictionaryFacts[0]?.canonicalKey ||
        item.line.text.split(/[|｜]/)[0]?.trim() ||
        null;
      insertCandidate.run(
        createId("aicandidate"),
        jobId,
        unitRows.get(unit.unitKey) || null,
        plan.reportId,
        candidateKey,
        sourceHash,
        item.page.pageNumber,
        JSON.stringify(item.line.sourceLineIds),
        item.line.candidateKind,
        JSON.stringify(
          item.line.dictionaryFacts.map((fact) => fact.canonicalKey),
        ),
        resolved
          ? directlyExtracted
            ? "ai_extracted"
            : "redundant"
          : "unresolved",
        resolved ? matchedEntityKey : null,
        resolved
          ? directlyExtracted
            ? "ai_extracted:AI 结果已通过原文证据匹配"
            : "duplicate_evidence:同指标同结果已由其他原文位置覆盖"
          : item.line.candidateResolutionReason === "ambiguous_layout"
            ? "ambiguous_layout:版面中存在多个无明确结果列的数值，保留人工核对"
            : "supplement_required:补提取后仍未找到可验证的对应事实",
      );
    }
    db.prepare(
      `
      UPDATE ai_extraction_units SET candidate_count = ?, matched_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND unit_key = ?
    `,
    ).run(candidates.length, matched, jobId, unit.unitKey);
  }
  return unmatched;
}

function mergeEvidence(results: AiExtractionResult[]) {
  const merged: Record<string, AiEvidence[]> = {};
  for (const result of results) {
    for (const [key, entries] of Object.entries(result.evidence)) {
      merged[key] = uniqueBy(
        [...(merged[key] || []), ...entries],
        (entry) => `${entry.pageNumber}:${entry.quote}`,
      );
    }
  }
  return merged;
}

export function mergeAiExtractionResults(
  results: AiExtractionResult[],
): AiExtractionResult {
  if (!results.length)
    throw Object.assign(new Error("AI 没有生成可合并的解析结果"), {
      code: "AI_EMPTY_RESULT",
    });
  const narrativeKeys = new Set<keyof AiExtractionFields>([
    "clinicalDiagnosis",
    "purpose",
    "chiefComplaint",
    "findings",
    "impression",
    "summary",
    "recommendation",
  ]);
  const mergedSource: Record<string, unknown> = {};
  for (const key of Object.keys(results[0].fields) as Array<
    keyof AiExtractionFields
  >) {
    if (
      key === "observations" ||
      key === "morphologyFindings" ||
      key === "bodyParts" ||
      key === "identifiers" ||
      key === "clinicians" ||
      key === "diagnoses" ||
      key === "medications" ||
      key === "procedures" ||
      key === "vaccinations" ||
      key === "billingSummary" ||
      key === "billingItems" ||
      key === "reportSections"
    )
      continue;
    mergedSource[key] = narrativeKeys.has(key)
      ? distinctStrings(
          results.map((result) => result.fields[key] as string | null),
        ).join("\n") || null
      : pickField(results, key);
  }
  mergedSource.bodyParts = uniqueBy(
    results.flatMap((result) => result.fields.bodyParts),
    (item) =>
      [item.raw, item.name, item.parent, item.laterality]
        .join("\u0000")
        .toLocaleLowerCase("zh-CN"),
  );
  mergedSource.identifiers = Object.assign(
    {},
    ...results.map((result) => result.fields.identifiers),
  );
  mergedSource.clinicians = Object.assign(
    {},
    ...results.map((result) => result.fields.clinicians),
  );
  mergedSource.observations = uniqueBy(
    results.flatMap((result) => result.fields.observations),
    observationKey,
  );
  mergedSource.morphologyFindings = uniqueBy(
    results.flatMap((result) => result.fields.morphologyFindings),
    morphologyKey,
  );
  mergedSource.diagnoses = uniqueBy(
    results.flatMap((result) => result.fields.diagnoses),
    (item) =>
      [
        item.diagnosisType,
        compactEvidence(item.diagnosisText),
        item.diagnosisCode || "",
      ].join("\u0000"),
  );
  mergedSource.medications = uniqueBy(
    results.flatMap((result) => result.fields.medications),
    (item) =>
      [
        item.context,
        compactEvidence(item.medicationName),
        compactEvidence(item.specification || ""),
        compactEvidence(item.dose || ""),
        compactEvidence(item.frequency || ""),
        compactEvidence(item.route || ""),
      ].join("\u0000"),
  );
  mergedSource.procedures = uniqueBy(
    results.flatMap((result) => result.fields.procedures),
    (item) =>
      [
        item.procedureType,
        compactEvidence(item.procedureName),
        item.performedAt || "",
        compactEvidence(item.bodyPart || ""),
      ].join("\u0000"),
  );
  mergedSource.vaccinations = uniqueBy(
    results.flatMap((result) => result.fields.vaccinations),
    (item) =>
      [
        compactEvidence(item.vaccineName),
        item.doseNumber || "",
        item.administeredAt || "",
        item.lotNumber || "",
      ].join("\u0000"),
  );
  const billingSummaries = results.flatMap((result) =>
    result.fields.billingSummary ? [result.fields.billingSummary] : [],
  );
  mergedSource.billingSummary = billingSummaries.length
    ? {
        invoiceNumber:
          billingSummaries.find((item) => item.invoiceNumber)?.invoiceNumber ||
          null,
        totalAmount:
          billingSummaries.find((item) => item.totalAmount !== null)
            ?.totalAmount ?? null,
        insuranceAmount:
          billingSummaries.find((item) => item.insuranceAmount !== null)
            ?.insuranceAmount ?? null,
        selfPayAmount:
          billingSummaries.find((item) => item.selfPayAmount !== null)
            ?.selfPayAmount ?? null,
        currency:
          billingSummaries.find((item) => item.currency)?.currency || "CNY",
        evidence: uniqueBy(
          billingSummaries.flatMap((item) => item.evidence),
          (entry) => `${entry.pageNumber}:${compactEvidence(entry.quote)}`,
        ),
      }
    : null;
  mergedSource.billingItems = uniqueBy(
    results.flatMap((result) => result.fields.billingItems),
    (item) =>
      [
        compactEvidence(item.itemName),
        compactEvidence(item.category || ""),
        item.amount === null ? "" : String(item.amount),
        item.quantity === null ? "" : String(item.quantity),
      ].join("\u0000"),
  );
  mergedSource.reportSections = [
    ...results
      .flatMap((result) => result.fields.reportSections)
      .reduce((sections, item) => {
        const existing = sections.get(item.sectionKey);
        if (!existing) {
          sections.set(item.sectionKey, {
            ...item,
            evidence: [...item.evidence],
          });
          return sections;
        }
        const contents = distinctStrings([existing.content, item.content]);
        existing.content = contents.join("\n");
        existing.evidence = uniqueBy(
          [...existing.evidence, ...item.evidence],
          (entry) => `${entry.pageNumber}:${compactEvidence(entry.quote)}`,
        );
        return sections;
      }, new Map<string, AiExtractionResult["fields"]["reportSections"][number]>())
      .values(),
  ];
  const evidence = mergeEvidence(results);
  const confidenceKeys = [
    ...new Set(results.flatMap((result) => Object.keys(result.confidence))),
  ];
  const confidence = Object.fromEntries(
    confidenceKeys.map((key) => [
      key,
      Math.max(...results.map((result) => result.confidence[key] ?? 0)),
    ]),
  );
  const normalized = normalizeAiExtraction({
    ...mergedSource,
    evidence,
    confidence,
  });
  return {
    provider: results[0].provider,
    model: results[0].model,
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
    promptTokens: results.some((result) => result.promptTokens !== null)
      ? results.reduce((sum, result) => sum + (result.promptTokens || 0), 0)
      : null,
    completionTokens: results.some((result) => result.completionTokens !== null)
      ? results.reduce((sum, result) => sum + (result.completionTokens || 0), 0)
      : null,
    elapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
    evidenceValidation: {
      rejectedObservations: results.reduce(
        (sum, result) =>
          sum + (result.evidenceValidation?.rejectedObservations || 0),
        0,
      ),
      rejectedMorphologyFindings: results.reduce(
        (sum, result) =>
          sum + (result.evidenceValidation?.rejectedMorphologyFindings || 0),
        0,
      ),
      rejectedClinicalFacts: results.reduce(
        (sum, result) =>
          sum + (result.evidenceValidation?.rejectedClinicalFacts || 0),
        0,
      ),
      rejectedStructuredSections: results.reduce(
        (sum, result) =>
          sum + (result.evidenceValidation?.rejectedStructuredSections || 0),
        0,
      ),
      rejectedObservationSamples: results
        .flatMap(
          (result) => result.evidenceValidation?.rejectedObservationSamples || [],
        )
        .slice(0, 20),
    },
  };
}

async function executeUnit(
  jobId: string,
  reportId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  row: UnitRow,
  executor: AiExecutor,
  options: ExecuteOptions,
  splitDepth = 0,
) {
  const stored = parseStoredResult(row);
  if (
    stored &&
    row.inputHash === unit.inputHash &&
    row.promptVersion === aiExtractionPromptVersion &&
    stored.promptVersion === aiExtractionPromptVersion
  )
    return stored;

  const run = async (
    attemptType: "main" | "format_retry" | "supplement",
    outputTokenScale = 1,
  ) => {
    startUnit(row);
    const input = inputForUnit(
      reportId,
      plan,
      unit,
      attemptType === "format_retry"
        ? "json_retry"
        : attemptType === "supplement"
          ? "supplement"
          : "standard",
    );
    input.outputTokenScale = outputTokenScale;
    options.onEvent?.({
      type: attemptType === "format_retry" ? "format_retry" : "unit_started",
      message:
        attemptType === "format_retry"
          ? "AI 返回格式无效，正在按严格 JSON 重试"
          : attemptType === "supplement"
            ? `AI 复核第 ${unit.pageNumbers.join("、")} 页未匹配测量候选`
            : `AI 整理单元 ${row.unitIndex + 1}/${plan.unitCount}`,
      detail: {
        unitKey: unit.unitKey,
        unitIndex: row.unitIndex,
        unitType: unit.unitType,
        route: unit.route,
        pageNumbers: unit.pageNumbers,
        characterCount: unit.characterCount,
        candidateCount: unit.candidateRowCount,
        morphologyCandidateCount: unit.morphologyCandidateCount,
        primaryContentType: unit.classification.primaryType,
        contentTypes: unit.classification.contentTypes,
        classificationConfidence: unit.classification.confidence,
        estimatedOutputTokens: unit.estimatedOutputTokens,
        attemptType,
        unitAttempt: row.attempts,
        outputTokenScale,
      },
    });
    try {
      const result = validateResultEvidence(plan, unit, await executor(input));
      recordAttempt(
        row,
        jobId,
        reportId,
        attemptType,
        unit.characterCount,
        result,
      );
      return result;
    } catch (error) {
      recordAttempt(
        row,
        jobId,
        reportId,
        attemptType,
        unit.characterCount,
        null,
        error,
      );
      throw error;
    }
  };

  const splitAndRun = async (cause: unknown) => {
    const children = splitAiExtractionUnit(plan, unit);
    if (children.length < 2) throw cause;
    options.onEvent?.({
      type: "unit_split",
      message: `AI 输出仍超限，已将第 ${unit.pageNumbers.join("、")} 页当前单元拆分后继续处理`,
      detail: {
        unitKey: unit.unitKey,
        unitIndex: row.unitIndex,
        unitType: unit.unitType,
        pageNumbers: unit.pageNumbers,
        childUnits: children.map((child) => ({
          unitKey: child.unitKey,
          pageNumbers: child.pageNumbers,
          characterCount: child.characterCount,
          candidateCount: child.candidateRowCount,
          estimatedOutputTokens: child.estimatedOutputTokens,
        })),
      },
    });
    const childResults = await mapConcurrent(
      children,
      async (child, childIndex) => {
        const childRow = syncDynamicUnit(
          jobId,
          reportId,
          plan,
          child,
          row.unitIndex * 1_000 + childIndex + 1,
        );
        return executeUnit(
          jobId,
          reportId,
          plan,
          child,
          childRow,
          executor,
          options,
          splitDepth + 1,
        );
      },
      { stopOnError: true },
    );
    return mergeAiExtractionResults(childResults);
  };

  const recover = async (
    error: unknown,
    outputTokenScale: number,
    allowFormatRetry: boolean,
  ): Promise<AiExtractionResult> => {
    const code = errorDetails(error).code;
    if (code === "AI_INVALID_JSON" && allowFormatRetry) {
      try {
        return await run("format_retry", outputTokenScale);
      } catch (retryError) {
        return recover(retryError, outputTokenScale, false);
      }
    }
    if (code === "AI_OUTPUT_TRUNCATED") {
      const truncation = error as {
        requestedMaxTokens?: number;
        modelMaxOutputTokens?: number;
      };
      /*
       * 拆分最多两级（单元 → 1/2 → 1/4）。低输出上限模型若仍超限，
       * 继续拆只会把一次失败放大成几十次无效请求并拖垮服务，
       * 这里及时止损，给出可操作的明确报错。
       */
      if (splitDepth >= 2) {
        throw Object.assign(
          new Error(
            "解析单元已拆到最小仍超出模型输出上限：当前模型的输出能力不足以完成解析，" +
            "请更换输出上限更高的模型，或在 AI 设置中将解析程度调为概览后重试",
          ),
          { code: "AI_OUTPUT_SPLIT_EXHAUSTED", cause: error },
        );
      }
      const canRaise =
        outputTokenScale < 2 &&
        (!truncation.requestedMaxTokens ||
          !truncation.modelMaxOutputTokens ||
          truncation.requestedMaxTokens < truncation.modelMaxOutputTokens);
      if (canRaise) {
        options.onEvent?.({
          type: "output_retry",
          message: "AI 输出达到当前预算，正在扩大输出空间重试当前单元",
          detail: {
            unitKey: unit.unitKey,
            unitIndex: row.unitIndex,
            unitType: unit.unitType,
            pageNumbers: unit.pageNumbers,
            previousMaxTokens: truncation.requestedMaxTokens || null,
            modelMaxOutputTokens: truncation.modelMaxOutputTokens || null,
            outputTokenScale: 2,
          },
        });
        try {
          return await run(
            unit.unitType === "supplement" ? "supplement" : "main",
            2,
          );
        } catch (retryError) {
          return recover(retryError, 2, true);
        }
      }
      return splitAndRun(error);
    }
    throw error;
  };

  let result: AiExtractionResult;
  try {
    result = await run(unit.unitType === "supplement" ? "supplement" : "main");
  } catch (error) {
    try {
      result = await recover(error, 1, true);
    } catch (finalError) {
      failUnit(row, finalError);
      options.onEvent?.({
        type: "unit_failed",
        message: errorDetails(finalError).message,
        detail: {
          unitKey: unit.unitKey,
          unitIndex: row.unitIndex,
          unitType: unit.unitType,
          pageNumbers: unit.pageNumbers,
          ...errorDetails(finalError),
        },
      });
      throw finalError;
    }
  }
  completeUnit(row, result);
  options.onEvent?.({
    type: "unit_completed",
    message: `AI 整理单元 ${row.unitIndex + 1}/${plan.unitCount} 完成`,
    detail: {
      unitKey: unit.unitKey,
      unitIndex: row.unitIndex,
      unitType: unit.unitType,
      pageNumbers: unit.pageNumbers,
      extractionMode: unit.extractionMode,
      route: unit.route,
      primaryContentType: unit.classification.primaryType,
      contentTypes: unit.classification.contentTypes,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      elapsedMs: result.elapsedMs,
      rejectedObservations:
        result.evidenceValidation?.rejectedObservations || 0,
      rejectedMorphologyFindings:
        result.evidenceValidation?.rejectedMorphologyFindings || 0,
      rejectedClinicalFacts:
        result.evidenceValidation?.rejectedClinicalFacts || 0,
      rejectedStructuredSections:
        result.evidenceValidation?.rejectedStructuredSections || 0,
      rejectedObservationSamples:
        result.evidenceValidation?.rejectedObservationSamples || [],
    },
  });
  return result;
}

export async function executeAiExtractionPlan(
  jobId: string,
  reportId: string,
  executor: AiExecutor,
  options: ExecuteOptions = {},
) {
  const plan = buildAiExtractionPlan(reportId);
  const rows = syncPlanUnits(jobId, reportId, plan);
  const results = await mapConcurrent(
    plan.units,
    async (unit) => {
      if (options.shouldContinue && !options.shouldContinue()) {
        throw Object.assign(new Error("报告任务已取消"), {
          code: "AI_TASK_CANCELLED",
        });
      }
      const row = rows.get(unit.unitKey);
      if (!row) throw new Error(`AI 解析单元未持久化：${unit.unitKey}`);
      return executeUnit(jobId, reportId, plan, unit, row, executor, options);
    },
    { stopOnError: true },
  );
  let merged = withDeterministicMorphologyMeasurements(
    plan,
    withDeterministicDocumentFields(
      plan,
      withLocalDocumentClassification(
        plan,
        withDeterministicFallback(
          plan,
          withSourceDeduplication(plan, mergeAiExtractionResults(results)),
        ),
      ),
    ),
  );
  /*
   * 概览模式：主单元与确定性兜底保持现状，但不做补充复核（supplement），
   * 未覆盖的候选行按现有 warning 逻辑留在单元审计中。
   */
  const supplements = plan.extractionDepth === "overview"
    ? []
    : supplementUnits(plan, merged);
  let effectivePlan = plan;
  if (supplements.length) {
    const units = [...plan.units, ...supplements];
    effectivePlan = {
      ...plan,
      units,
      unitCount: units.length,
      planHash: createHash("sha256")
        .update(
          units.map((unit) => `${unit.unitKey}:${unit.inputHash}`).join("|"),
        )
        .digest("hex"),
    };
    const supplementRows = syncPlanUnits(jobId, reportId, effectivePlan);
    const supplementResults = await mapConcurrent(
      supplements,
      async (unit) => {
        if (options.shouldContinue && !options.shouldContinue()) {
          throw Object.assign(new Error("报告任务已取消"), {
            code: "AI_TASK_CANCELLED",
          });
        }
        const row = supplementRows.get(unit.unitKey);
        if (!row) return null;
        try {
          return await executeUnit(
            jobId,
            reportId,
            effectivePlan,
            unit,
            row,
            executor,
            options,
          );
        } catch (error) {
          const failure = errorDetails(error);
          getDatabase()
            .prepare(
              `
          UPDATE ai_extraction_units SET status = 'warning', error_code = ?, error_message = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `,
            )
            .run(failure.code, failure.message, row.id);
          return null;
        }
      },
      { stopOnError: true },
    );
    results.push(
      ...supplementResults.filter(
        (result): result is AiExtractionResult => result !== null,
      ),
    );
    merged = withDeterministicMorphologyMeasurements(
      plan,
      withDeterministicDocumentFields(
        plan,
        withLocalDocumentClassification(
          plan,
          withDeterministicFallback(
            plan,
            withSourceDeduplication(plan, mergeAiExtractionResults(results)),
          ),
        ),
      ),
    );
  }
  const unmatchedCandidates = updateCandidateQuality(jobId, plan, merged);
  let warningUnits = results.filter((result) =>
    Boolean(
      (result.evidenceValidation?.rejectedObservations || 0) +
      (result.evidenceValidation?.rejectedMorphologyFindings || 0) +
      (result.evidenceValidation?.rejectedClinicalFacts || 0) +
      (result.evidenceValidation?.rejectedStructuredSections || 0),
    ),
  ).length;
  for (const unit of supplements) {
    const unresolved = unitCandidateLines(plan, unit).filter(
      (item) => !resultMatchesCandidateLine(merged, item.line),
    ).length;
    if (!unresolved) continue;
    warningUnits += 1;
    getDatabase()
      .prepare(
        `
      UPDATE ai_extraction_units SET status = 'warning',
        error_code = COALESCE(error_code, 'AI_UNMATCHED_CANDIDATES'),
        error_message = COALESCE(error_message, ?), updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND unit_key = ?
    `,
      )
      .run(`复核后仍有 ${unresolved} 个测量候选待核对`, jobId, unit.unitKey);
  }
  return {
    plan: effectivePlan,
    result: merged,
    inputCharacters: effectivePlan.units.reduce(
      (sum, unit) => sum + unit.characterCount,
      0,
    ),
    unmatchedCandidates,
    warningUnits,
  };
}
