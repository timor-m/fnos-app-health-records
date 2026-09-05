import { createHash } from "node:crypto";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { isTrackableMorphologyFinding } from "../utils/morphology-rules";
import { assertMemberManage } from "./member.service";

const backfillSettingKey = "morphology.legacy_observation_backfill_v1";
const trackingRuleSettingKey = "morphology.tracking_rule_version";
const trackingRuleVersion = "morphology-tracking-v2";
const strongMorphologyPattern =
  /(囊肿|结节|斑块|息肉|结石|钙化灶?|占位|肿块|包块|团块|积液|增生|萎缩|狭窄|扩张|卵泡|脂肪肝|磨玻璃影|病灶|血流信号|淋巴结)/;
const morphologySectionPattern =
  /(超声|彩超|影像|CT|MRI|DR|放射|内镜|病理|检查所见|耳鼻喉|眼科|外科|内科|妇科|口腔|心电图|肺功能)/i;

type LegacyObservation = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceText: string | null;
  evidenceJson: string;
};

function inferType(value: string) {
  return value.match(strongMorphologyPattern)?.[0] || "检查发现";
}

function inferOrgan(value: string) {
  return normalizeMorphologyOrgan(value);
}

function inferLaterality(value: string) {
  if (/双侧|双肾|双乳/.test(value)) return "bilateral";
  if (/左侧|左叶|左肺|左肾|左乳/.test(value)) return "left";
  if (/右侧|右叶|右肺|右肾|右乳/.test(value)) return "right";
  return "unspecified";
}

function inferSize(value: string) {
  const match = value.match(
    /(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)(?:\s*[×xX*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m)\b/i
  );
  return match ? {
    length: Number(match[1]),
    width: Number(match[2]),
    height: match[3] ? Number(match[3]) : null,
    unit: match[4].toLowerCase()
  } : { length: null, width: null, height: null, unit: null };
}

function shouldMoveLegacyObservation(row: LegacyObservation) {
  const text = `${row.sectionName || ""} ${row.itemName} ${row.resultText}`;
  if (strongMorphologyPattern.test(text)) return true;
  return row.numericValue === null
    && !row.unit
    && !row.referenceText
    && morphologySectionPattern.test(row.sectionName || "");
}

function parseEvidence(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function backfillLegacyMorphologyFindings() {
  const db = getDatabase();
  const completed = db.prepare(`
    SELECT 1 AS found FROM app_settings WHERE setting_key = ?
  `).get(backfillSettingKey) as { found: number } | undefined;
  if (completed) return { scanned: 0, migrated: 0, alreadyCompleted: true };

  const rows = db.prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName,
      o.item_name AS itemName, o.result_text AS resultText, o.numeric_value AS numericValue,
      o.unit, o.reference_text AS referenceText, o.evidence_json AS evidenceJson
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed'
      AND n.indicator_id IS NULL
    ORDER BY o.report_id, o.id
  `).all() as LegacyObservation[];
  const candidates = rows.filter(shouldMoveLegacyObservation);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of candidates) {
      const combinedText = `${row.itemName} ${row.resultText}`;
      const evidence = parseEvidence(row.evidenceJson);
      const rawText = typeof evidence[0]?.quote === "string"
        ? String(evidence[0].quote)
        : `${row.itemName}：${row.resultText}`;
      const size = inferSize(combinedText);
      db.prepare(`
        INSERT INTO morphology_findings (
          id, report_id, section_name, organ, laterality, finding_type, finding_name,
          presence, size_length, size_width, size_height, size_unit, morphology_text,
          raw_text, evidence_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_migration')
      `).run(
        createId("finding"), row.reportId, row.sectionName, inferOrgan(combinedText),
        inferLaterality(combinedText), inferType(combinedText), row.itemName,
        /未见|未发现|无明显/.test(row.resultText) ? "absent" : "present",
        size.length, size.width, size.height, size.unit, row.resultText,
        rawText.slice(0, 3000), JSON.stringify(evidence)
      );
      db.prepare("DELETE FROM observations WHERE id = ?").run(row.id);
    }
    db.prepare(`
      INSERT INTO app_settings (setting_key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(backfillSettingKey, JSON.stringify({
      scanned: rows.length,
      migrated: candidates.length,
      completedAt: new Date().toISOString()
    }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { scanned: rows.length, migrated: candidates.length, alreadyCompleted: false };
}

type FindingRow = {
  id: string;
  reportId: string;
  memberId: string;
  reportTitle: string;
  reportStatus: string;
  hospitalName: string | null;
  examDate: string | null;
  sectionName: string | null;
  organ: string | null;
  region: string | null;
  laterality: MorphologyLaterality;
  findingType: string;
  findingName: string;
  presence: "present" | "absent" | "uncertain";
  findingCount: number | null;
  sizeLength: number | null;
  sizeWidth: number | null;
  sizeHeight: number | null;
  sizeUnit: string | null;
  measurementsJson: string;
  morphology: string | null;
  classificationSystem: string | null;
  classificationValue: string | null;
  classificationText: string | null;
  comparisonText: string | null;
  rawText: string;
  evidenceJson: string;
  confidence: number | null;
  trackingGroupId: string | null;
  matchConfidence: number | null;
  source: "ai" | "manual" | "legacy_migration";
  manualFieldsJson: string;
};

type MorphologyLaterality = "left" | "right" | "bilateral" | "midline" | "unspecified";

type TrackingDescriptor = {
  organ: string;
  type: string;
  laterality: MorphologyLaterality;
  region: string | null;
  baseKey: string;
};

export type MorphologyTrackingResult = {
  scanned: number;
  linked: number;
  groups: number;
  untracked: number;
  ambiguous: number;
  members: number;
};

export type MorphologyTrackingPoint = {
  findingId: string;
  reportId: string;
  reportTitle: string;
  reportStatus: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  findingName: string;
  organ: string | null;
  region: string | null;
  laterality: MorphologyLaterality;
  findingType: string;
  presence: FindingRow["presence"];
  size: {
    length: number | null;
    width: number | null;
    height: number | null;
    unit: string | null;
    label: string | null;
    primaryMm: number | null;
  };
  morphology: string | null;
  classification: {
    system: string | null;
    value: string | null;
    text: string | null;
    label: string;
  } | null;
  comparisonText: string | null;
  rawText: string;
  evidenceQuote: string | null;
  matchConfidence: number | null;
  manualFields: string[];
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type MorphologyTrackingSeries = {
  trackingGroupId: string;
  name: string;
  organ: string;
  region: string | null;
  laterality: MorphologyLaterality;
  findingType: string;
  pointCount: number;
  firstDate: string | null;
  lastDate: string | null;
  latest: MorphologyTrackingPoint;
  previous: MorphologyTrackingPoint | null;
  changeKind:
    | "baseline"
    | "size_increased"
    | "size_decreased"
    | "size_stable"
    | "presence_changed"
    | "classification_changed"
    | "description_changed";
  changeSummary: string;
  points: MorphologyTrackingPoint[];
};

export type UntrackedMorphologyFinding = {
  findingId: string;
  reportId: string;
  reportTitle: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  findingName: string;
  organ: string | null;
  findingType: string;
  region: string | null;
  laterality: MorphologyLaterality;
  presence: FindingRow["presence"];
  size: MorphologyTrackingPoint["size"];
  morphology: string | null;
  classification: MorphologyTrackingPoint["classification"];
  rawText: string;
  manualFields: string[];
  reason: string;
};

const organRules: Array<[RegExp, string]> = [
  [/甲状腺/, "甲状腺"],
  [/乳腺|乳房/, "乳腺"],
  [/肝左叶|肝右叶|肝脏|肝叶|肝/, "肝脏"],
  [/胆囊/, "胆囊"],
  [/胆总管|胆管/, "胆管"],
  [/胰腺|胰头|胰体|胰尾/, "胰腺"],
  [/脾脏|脾/, "脾脏"],
  [/左肾|右肾|双肾|肾脏|肾/, "肾脏"],
  [/膀胱/, "膀胱"],
  [/前列腺/, "前列腺"],
  [/子宫内膜|宫腔|子宫/, "子宫"],
  [/宫颈/, "宫颈"],
  [/左侧卵巢|右侧卵巢|双侧卵巢|卵巢/, "卵巢"],
  [/盆腔/, "盆腔"],
  [/左肺|右肺|双肺|肺部|肺叶|肺/, "肺"],
  [/心脏|心室|心房/, "心脏"],
  [/颈动脉/, "颈动脉"],
  [/椎动脉/, "椎动脉"],
  [/锁骨下动脉/, "锁骨下动脉"],
  [/下肢动脉/, "下肢动脉"],
  [/淋巴结/, "淋巴结"],
  [/食管/, "食管"],
  [/胃部|胃/, "胃"],
  [/结肠|直肠|小肠|肠道/, "肠道"],
  [/眼底|眼球|眼/, "眼"],
  [/鼻腔|鼻窦|鼻/, "鼻"],
  [/咽喉|咽部|喉部/, "咽喉"],
  [/口腔|牙龈|牙齿/, "口腔"],
  [/骨骼|骨质|骨/, "骨骼"]
];

const typeRules: Array<[RegExp, string]> = [
  [/囊肿|囊性灶/, "囊肿"],
  [/结节/, "结节"],
  [/斑块/, "斑块"],
  [/息肉/, "息肉"],
  [/结石/, "结石"],
  [/钙化/, "钙化"],
  [/肿块|包块|团块|占位|肿物/, "肿块"],
  [/积液/, "积液"],
  [/增生/, "增生"],
  [/萎缩/, "萎缩"],
  [/狭窄/, "狭窄"],
  [/扩张|增宽/, "扩张"],
  [/卵泡/, "卵泡"],
  [/脂肪肝|脂肪变/, "脂肪肝"],
  [/淋巴结/, "淋巴结"],
  [/厚度|壁厚|内膜厚/, "厚度"],
  [/大小|体积/, "大小"],
  [/位置|前位|后位/, "位置"],
  [/回声/, "回声"],
  [/形态|边界|轮廓/, "形态"],
  [/血流/, "血流"],
  [/密度/, "密度"],
  [/数量|数目/, "数量"]
];

const regionPatterns = [
  /左叶|右叶|上叶|中叶|下叶|峡部/,
  /上极|中极|下极/,
  /胰头|胰体|胰尾/,
  /胆囊颈|胆囊体|胆囊底/,
  /宫腔|内膜/,
  /上段|中段|下段/,
  /\d{1,2}\s*点钟(?:方向)?/
];

const regionOrganPrefixes = [
  "锁骨下动脉", "下肢动脉", "甲状腺", "颈动脉", "椎动脉",
  "乳腺", "肝脏", "胆囊", "胆总管", "胆管", "胰腺", "脾脏",
  "肾脏", "膀胱", "前列腺", "子宫", "宫颈", "卵巢", "肺部",
  "肺", "心脏", "食管", "结肠", "直肠", "小肠", "肠道", "胃部",
  "胃", "肝", "肾", "脾"
].sort((left, right) => right.length - left.length);

function compactKey(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（）()【】\[\]，,。.:：;；、\s_-]+/g, "");
}

export function normalizeMorphologyOrgan(value: string | null | undefined) {
  const text = String(value || "").trim();
  return organRules.find(([pattern]) => pattern.test(text))?.[1] || null;
}

export function normalizeMorphologyType(value: string | null | undefined) {
  const text = String(value || "").trim();
  return typeRules.find(([pattern]) => pattern.test(text))?.[1] || null;
}

function normalizeLaterality(value: MorphologyLaterality, text: string): MorphologyLaterality {
  if (value !== "unspecified") return value;
  if (/双侧|双肾|双肺|双乳|双卵巢/.test(text)) return "bilateral";
  if (/左侧|左叶|左肺|左肾|左乳|左卵巢/.test(text)) return "left";
  if (/右侧|右叶|右肺|右肾|右乳|右卵巢/.test(text)) return "right";
  if (/正中|中线/.test(text)) return "midline";
  return "unspecified";
}

function structuredMorphologyRegion(value: string | null) {
  let region = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[，,。.:：;；、\s_-]+/g, "");
  if (!region || !regionPatterns.some((pattern) => pattern.test(region))) {
    return null;
  }
  for (const prefix of regionOrganPrefixes) {
    if (region.startsWith(prefix) && region.length > prefix.length) {
      region = region.slice(prefix.length);
      break;
    }
  }
  region = region
    .replace(/^(?:左侧|右侧|双侧)(?=叶|段|部|区)/, (side) => side.slice(0, 1))
    .slice(0, 80);
  return region || null;
}

function normalizeRegion(value: string | null, text: string) {
  const structured = structuredMorphologyRegion(value);
  if (structured) return structured;
  const source = text;
  return regionPatterns.find((pattern) => pattern.test(source))?.exec(source)?.[0]
    ?.replace(/\s+/g, "") || null;
}

function descriptorFor(row: FindingRow): TrackingDescriptor | null {
  const identifyingText = [row.organ, row.region, row.findingType, row.findingName].filter(Boolean).join(" ");
  const fallbackText = `${identifyingText} ${row.rawText.slice(0, 500)}`;
  const organ = normalizeMorphologyOrgan(row.organ || identifyingText)
    || normalizeMorphologyOrgan(row.findingName)
    || normalizeMorphologyOrgan(fallbackText);
  const type = normalizeMorphologyType(`${row.findingType} ${row.findingName}`)
    || normalizeMorphologyType(row.rawText.slice(0, 500));
  if (!organ || !type) return null;
  const laterality = normalizeLaterality(row.laterality, identifyingText);
  const region = normalizeRegion(row.region, identifyingText);
  return {
    organ,
    type,
    laterality,
    region,
    baseKey: [organ, type, laterality].map(compactKey).join("|")
  };
}

function deterministicTrackingId(memberId: string, descriptor: TrackingDescriptor) {
  const key = [
    memberId,
    descriptor.organ,
    descriptor.type,
    descriptor.laterality,
    descriptor.region || ""
  ].map(compactKey).join("|");
  return `morph_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function sizePrimaryMillimeters(row: Pick<FindingRow, "sizeLength" | "sizeWidth" | "sizeHeight" | "sizeUnit">) {
  const dimensions = [row.sizeLength, row.sizeWidth, row.sizeHeight]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!dimensions.length) return null;
  const unit = compactKey(row.sizeUnit);
  const factor = unit === "cm" ? 10 : unit === "m" ? 1000 : unit === "mm" ? 1 : null;
  return factor === null ? null : Math.max(...dimensions) * factor;
}

function distinctSizes(rows: FindingRow[]) {
  return new Set(rows.map((row) => {
    const value = sizePrimaryMillimeters(row);
    return value === null ? "none" : String(Math.round(value * 10) / 10);
  }).filter((value) => value !== "none"));
}

function trackingRows(memberId?: string) {
  return getDatabase().prepare(`
    SELECT f.id, f.report_id AS reportId, r.member_id AS memberId,
      r.title AS reportTitle, r.status AS reportStatus,
      r.hospital_name_raw AS hospitalName,
      COALESCE(r.examined_at, r.report_issued_at, r.created_at) AS examDate,
      f.section_name AS sectionName, f.organ, f.region, f.laterality,
      f.finding_type AS findingType, f.finding_name AS findingName,
      f.presence, f.finding_count AS findingCount,
      f.size_length AS sizeLength, f.size_width AS sizeWidth,
      f.size_height AS sizeHeight, f.size_unit AS sizeUnit,
      f.measurements_json AS measurementsJson, f.morphology_text AS morphology,
      f.classification_system AS classificationSystem,
      f.classification_value AS classificationValue,
      f.classification_text AS classificationText,
      f.comparison_text AS comparisonText, f.raw_text AS rawText,
      f.evidence_json AS evidenceJson, f.confidence,
      f.tracking_group_id AS trackingGroupId, f.match_confidence AS matchConfidence,
      f.source, f.manual_fields_json AS manualFieldsJson
    FROM morphology_findings f
    JOIN reports r ON r.id = f.report_id
    WHERE r.status IN ('needs_review', 'ready')
      AND (? IS NULL OR r.member_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(f.manual_fields_json) WHERE value = 'ignored'
      )
    ORDER BY r.member_id, COALESCE(r.examined_at, r.report_issued_at, r.created_at), r.id, f.id
  `).all(memberId || null, memberId || null) as FindingRow[];
}

function manualFieldSet(row: Pick<FindingRow, "manualFieldsJson">) {
  try {
    const parsed = JSON.parse(row.manualFieldsJson) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

const trackingGroupLabelField = "trackingGroupLabel";

function fallbackTrackingDescriptor(row: FindingRow): TrackingDescriptor {
  const identifyingText = [row.organ, row.region, row.findingType, row.findingName]
    .filter(Boolean).join(" ");
  const organ = String(row.organ || "").trim()
    || normalizeMorphologyOrgan(row.findingName)
    || "部位待确认";
  const type = String(row.findingType || "").trim()
    || String(row.findingName || "").trim()
    || "形态发现";
  const laterality = normalizeLaterality(row.laterality, identifyingText);
  const region = String(row.region || "").trim() || null;
  return {
    organ,
    type,
    laterality,
    region,
    baseKey: [organ, type, laterality].map(compactKey).join("|")
  };
}

function trackingGroupPresentation(groupRows: FindingRow[], descriptors: Map<string, TrackingDescriptor>) {
  const preferredRow = groupRows.find((row) => manualFieldSet(row).has(trackingGroupLabelField))
    || groupRows.find((row) => Boolean(descriptors.get(row.id)?.region))
    || groupRows.find((row) => descriptors.has(row.id))
    || groupRows[0];
  if (!preferredRow) return null;
  const descriptor = descriptors.get(preferredRow.id) || fallbackTrackingDescriptor(preferredRow);
  const name = descriptors.has(preferredRow.id)
    ? trackingSeriesName(descriptor)
    : String(preferredRow.findingName || "").trim() || trackingSeriesName(descriptor);
  return { preferredRow, descriptor, name };
}

function trackingAssignments(rows: FindingRow[]) {
  const descriptors = new Map<string, TrackingDescriptor>();
  const byIdentity = new Map<string, Array<{ row: FindingRow; descriptor: TrackingDescriptor }>>();
  for (const row of rows) {
    const descriptor = descriptorFor(row);
    if (!descriptor) continue;
    descriptors.set(row.id, descriptor);
    const identityKey = [descriptor.organ, descriptor.type].map(compactKey).join("|");
    const entries = byIdentity.get(identityKey) || [];
    entries.push({ row, descriptor });
    byIdentity.set(identityKey, entries);
  }

  const assignments = new Map<string, { groupId: string; confidence: number }>();
  const ambiguous = new Map<string, string>();
  const resolvedEntries: Array<{
    row: FindingRow;
    descriptor: TrackingDescriptor;
    inferredLaterality: boolean;
  }> = [];
  for (const entries of byIdentity.values()) {
    const knownLateralities = new Set(
      entries.map((entry) => entry.descriptor.laterality).filter((value) => value !== "unspecified")
    );
    for (const entry of entries) {
      let descriptor = entry.descriptor;
      let inferredLaterality = false;
      if (descriptor.laterality === "unspecified" && knownLateralities.size > 1) {
        ambiguous.set(entry.row.id, "同一器官存在多个侧别，当前记录未注明左侧或右侧");
        continue;
      }
      if (descriptor.laterality === "unspecified" && knownLateralities.size === 1) {
        descriptor = {
          ...descriptor,
          laterality: [...knownLateralities][0] || "unspecified"
        };
        descriptor.baseKey = [descriptor.organ, descriptor.type, descriptor.laterality]
          .map(compactKey).join("|");
        inferredLaterality = true;
        descriptors.set(entry.row.id, descriptor);
      }
      resolvedEntries.push({ row: entry.row, descriptor, inferredLaterality });
    }
  }

  const byBase = new Map<string, typeof resolvedEntries>();
  for (const entry of resolvedEntries) {
    const entries = byBase.get(entry.descriptor.baseKey) || [];
    entries.push(entry);
    byBase.set(entry.descriptor.baseKey, entries);
  }
  for (const entries of byBase.values()) {
    const knownRegions = new Set(entries.map((entry) => entry.descriptor.region).filter(Boolean));
    for (const entry of entries) {
      let descriptor = entry.descriptor;
      let confidence = descriptor.region
        ? descriptor.laterality === "unspecified" ? 0.9 : 0.96
        : descriptor.laterality === "unspecified" ? 0.78 : 0.86;
      if (entry.inferredLaterality) confidence = descriptor.region ? 0.8 : 0.76;
      if (!descriptor.region && knownRegions.size === 1) {
        descriptor = { ...descriptor, region: [...knownRegions][0] || null };
        confidence = entry.inferredLaterality
          ? 0.74
          : descriptor.laterality === "unspecified" ? 0.8 : 0.84;
        descriptors.set(entry.row.id, descriptor);
      } else if (!descriptor.region && knownRegions.size > 1) {
        ambiguous.set(entry.row.id, "同一器官存在多个区域，当前记录缺少可唯一关联的位置");
        continue;
      }
      const groupId = deterministicTrackingId(entry.row.memberId, descriptor);
      assignments.set(entry.row.id, {
        groupId,
        confidence: Math.min(confidence, Math.max(0.5, entry.row.confidence ?? confidence))
      });
    }
  }

  const sameReportGroups = new Map<string, FindingRow[]>();
  for (const row of rows) {
    const assignment = assignments.get(row.id);
    if (!assignment) continue;
    const key = `${row.reportId}|${assignment.groupId}`;
    const group = sameReportGroups.get(key) || [];
    group.push(row);
    sameReportGroups.set(key, group);
  }
  for (const group of sameReportGroups.values()) {
    if (group.length < 2 || distinctSizes(group).size < 2) continue;
    for (const row of group) {
      assignments.delete(row.id);
      ambiguous.set(row.id, "同次报告存在多个尺寸不同、但部位描述相同的发现");
    }
  }
  return { assignments, ambiguous, descriptors };
}

function rebuildRows(rows: FindingRow[]): MorphologyTrackingResult {
  const db = getDatabase();
  const manualRows = rows.filter((row) => manualFieldSet(row).has("trackingGroup") && row.trackingGroupId);
  const automaticRows = rows.filter((row) => !manualFieldSet(row).has("trackingGroup"));
  const { assignments, ambiguous } = trackingAssignments(automaticRows);
  const memberIds = [...new Set(rows.map((row) => row.memberId))];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const memberId of memberIds) {
      db.prepare(`
        UPDATE morphology_findings
        SET tracking_group_id = NULL, match_confidence = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE report_id IN (SELECT id FROM reports WHERE member_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(manual_fields_json) WHERE value = 'trackingGroup'
          )
      `).run(memberId);
    }
    for (const [findingId, assignment] of assignments) {
      db.prepare(`
        UPDATE morphology_findings
        SET tracking_group_id = ?, match_confidence = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(assignment.groupId, assignment.confidence, findingId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    scanned: rows.length,
    linked: assignments.size + manualRows.length,
    groups: new Set([
      ...[...assignments.values()].map((item) => item.groupId),
      ...manualRows.map((row) => row.trackingGroupId!)
    ]).size,
    untracked: rows.length - assignments.size - manualRows.length,
    ambiguous: ambiguous.size,
    members: memberIds.length
  };
}

export function rebuildMorphologyTrackingForMember(memberId: string) {
  return rebuildRows(trackingRows(memberId));
}

export function rebuildMorphologyTrackingForReport(reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ?")
    .get(reportId) as { memberId: string } | undefined;
  return report ? rebuildMorphologyTrackingForMember(report.memberId) : null;
}

export function rebuildAllMorphologyTracking() {
  return rebuildRows(trackingRows());
}

export function rebuildMorphologyTrackingIfNeeded() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?
  `).get(trackingRuleSettingKey) as { valueJson: string } | undefined;
  if (row) {
    try {
      if (JSON.parse(row.valueJson) === trackingRuleVersion) return null;
    } catch {
      // Invalid local state is repaired by the deterministic rebuild below.
    }
  }
  const result = rebuildAllMorphologyTracking();
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(trackingRuleSettingKey, JSON.stringify(trackingRuleVersion));
  return result;
}

function assertMemberAccess(user: RequestUser, memberId: string) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  const access = getDatabase().prepare(`
    SELECT 1 AS allowed FROM member_permissions WHERE member_id = ? AND user_id = ?
  `).get(memberId, user.id) as { allowed: number } | undefined;
  if (!access) throw createError({ statusCode: 403, statusMessage: "没有查看该成员形态变化的权限" });
}

type TrackingEvidence = { pageNumber: number; quote: string | null };

function trackingEvidenceScore(
  row: FindingRow,
  evidence: TrackingEvidence,
) {
  const quote = compactKey(evidence.quote);
  if (!quote) return 0;
  const rawText = compactKey(row.rawText);
  let score = 0;
  if (rawText && quote === rawText) score += 100_000;
  else if (rawText && (rawText.includes(quote) || quote.includes(rawText))) {
    score += 50_000 + Math.min(rawText.length, quote.length);
  }
  for (const [value, weight] of [
    [row.morphology, 4_000],
    [row.findingName, 2_000],
    [row.findingType, 1_000],
    [row.region, 500],
    [row.organ, 250],
  ] as const) {
    const normalized = compactKey(value);
    if (normalized && quote.includes(normalized)) score += weight;
  }
  return score + Math.min(quote.length, 500);
}

function parseTrackingEvidence(value: string, row: FindingRow) {
  try {
    const parsed = JSON.parse(value) as Array<{ pageNumber?: unknown; quote?: unknown }>;
    if (!Array.isArray(parsed)) return null;
    const candidates = parsed.flatMap((item) => {
      const pageNumber = Math.max(0, Math.round(Number(item?.pageNumber || 0)));
      if (!pageNumber) return [];
      return [{
        pageNumber,
        quote: typeof item.quote === "string" ? item.quote.trim().slice(0, 500) || null : null,
      } satisfies TrackingEvidence];
    });
    return candidates.sort((left, right) =>
      trackingEvidenceScore(row, right) - trackingEvidenceScore(row, left)
      || compactKey(right.quote).length - compactKey(left.quote).length
      || left.pageNumber - right.pageNumber
      || String(left.quote || "").localeCompare(String(right.quote || ""), "zh-CN")
    )[0] || null;
  } catch {
    return null;
  }
}

function sourcePages(rows: FindingRow[]) {
  const reportIds = [...new Set(rows.map((row) => row.reportId))];
  if (!reportIds.length) return new Map<string, MorphologyTrackingPoint["sourcePage"]>();
  const placeholders = reportIds.map(() => "?").join(",");
  const pages = getDatabase().prepare(`
    SELECT id, report_id AS reportId, page_number AS pageNumber,
      original_name AS originalName, mime_type AS mimeType,
      source_page_number AS sourcePageNumber
    FROM report_pages
    WHERE report_id IN (${placeholders})
  `).all(...reportIds) as Array<{
    id: string;
    reportId: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  }>;
  return new Map(pages.map((page) => [`${page.reportId}:${page.pageNumber}`, {
    id: page.id,
    pageNumber: page.pageNumber,
    originalName: page.originalName,
    mimeType: page.mimeType,
    sourcePageNumber: page.sourcePageNumber
  }]));
}

function sizeLabel(row: FindingRow) {
  const dimensions = [row.sizeLength, row.sizeWidth, row.sizeHeight]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return dimensions.length
    ? `${dimensions.join(" × ")}${row.sizeUnit ? ` ${row.sizeUnit}` : ""}`
    : null;
}

function classification(row: FindingRow) {
  const label = row.classificationText
    || [row.classificationSystem, row.classificationValue].filter(Boolean).join(" ");
  return label ? {
    system: row.classificationSystem,
    value: row.classificationValue,
    text: row.classificationText,
    label
  } : null;
}

function pointRichness(row: FindingRow) {
  return Number(row.reportStatus === "ready") * 100
    + Number(sizePrimaryMillimeters(row) !== null) * 30
    + Number(Boolean(classification(row))) * 20
    + Math.min(20, Math.round((row.morphology?.length || 0) / 20))
    + Math.round((row.confidence || 0) * 10);
}

function morphologyLocation(organ: string, laterality: MorphologyLaterality) {
  if (laterality === "unspecified" || laterality === "midline") return organ;
  if (organ === "肾脏") return laterality === "bilateral" ? "双肾" : laterality === "left" ? "左肾" : "右肾";
  if (organ === "肺") return laterality === "bilateral" ? "双肺" : laterality === "left" ? "左肺" : "右肺";
  const prefix = laterality === "bilateral" ? "双侧" : laterality === "left" ? "左侧" : "右侧";
  return `${prefix}${organ}`;
}

function trackingSeriesName(descriptor: TrackingDescriptor) {
  const regionIncludesSide = Boolean(
    descriptor.region
    && (
      descriptor.laterality === "left" && /左/.test(descriptor.region)
      || descriptor.laterality === "right" && /右/.test(descriptor.region)
      || descriptor.laterality === "bilateral" && /双/.test(descriptor.region)
    )
  );
  const location = regionIncludesSide
    ? descriptor.organ
    : morphologyLocation(descriptor.organ, descriptor.laterality);
  const region = descriptor.region && !compactKey(location).includes(compactKey(descriptor.region))
    ? descriptor.region
    : "";
  return `${location}${region}${descriptor.type}`;
}

function changeSummary(points: MorphologyTrackingPoint[]) {
  const latest = points.at(-1)!;
  const previous = points.length > 1 ? points.at(-2)! : null;
  if (!previous) return { kind: "baseline" as const, summary: "目前只有一次报告记录" };
  if (latest.presence !== previous.presence) {
    const status = (value: MorphologyTrackingPoint["presence"]) =>
      value === "present" ? "有记录" : value === "absent" ? "报告未见" : "待确认";
    return {
      kind: "presence_changed" as const,
      summary: `原报告状态由“${status(previous.presence)}”变为“${status(latest.presence)}”`
    };
  }
  if (latest.classification?.label && previous.classification?.label
    && compactKey(latest.classification.label) !== compactKey(previous.classification.label)) {
    return {
      kind: "classification_changed" as const,
      summary: `原报告分级由“${previous.classification.label}”变为“${latest.classification.label}”`
    };
  }
  const currentSize = latest.size.primaryMm;
  const previousSize = previous.size.primaryMm;
  if (currentSize !== null && previousSize !== null) {
    const delta = currentSize - previousSize;
    const threshold = Math.max(1, Math.abs(previousSize) * 0.05);
    if (Math.abs(delta) <= threshold) {
      return { kind: "size_stable" as const, summary: "原报告最大径与上次记录接近" };
    }
    return {
      kind: delta > 0 ? "size_increased" as const : "size_decreased" as const,
      summary: `原报告最大径较上次${delta > 0 ? "增加" : "减少"} ${Math.abs(delta).toFixed(1)} mm`
    };
  }
  const latestDescription = compactKey(latest.morphology || latest.rawText);
  const previousDescription = compactKey(previous.morphology || previous.rawText);
  if (latestDescription && previousDescription && latestDescription !== previousDescription) {
    return { kind: "description_changed" as const, summary: "两次原报告的形态描述存在差异" };
  }
  return { kind: "size_stable" as const, summary: "原报告未提供可比较的尺寸或分级变化" };
}

function untrackedReason(row: FindingRow, ambiguous: Map<string, string>) {
  const ambiguityReason = ambiguous.get(row.id);
  if (ambiguityReason) return ambiguityReason;
  const text = `${row.findingType} ${row.findingName} ${row.rawText.slice(0, 300)}`;
  if (!normalizeMorphologyOrgan(row.organ || row.findingName || text)) return "器官或部位不明确";
  if (!normalizeMorphologyType(text)) return "发现类型不明确";
  return "存在多个区域，当前记录缺少可唯一关联的位置";
}

export function listMorphologyTracking(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const rows = trackingRows(memberId).filter((row) => isTrackableMorphologyFinding({
    findingName: row.findingName,
    findingType: row.findingType,
    rawText: row.rawText,
    morphology: row.morphology,
    presence: row.presence
  }));
  const { ambiguous, descriptors } = trackingAssignments(rows);
  const pages = sourcePages(rows);
  const grouped = new Map<string, FindingRow[]>();
  for (const row of rows) {
    if (!row.trackingGroupId) continue;
    const group = grouped.get(row.trackingGroupId) || [];
    group.push(row);
    grouped.set(row.trackingGroupId, group);
  }

  const series = [...grouped.entries()].flatMap(([trackingGroupId, groupRows]) => {
    const presentation = trackingGroupPresentation(groupRows, descriptors);
    if (!presentation) return [];
    const { descriptor } = presentation;
    const byReport = new Map<string, FindingRow>();
    for (const row of groupRows) {
      const existing = byReport.get(row.reportId);
      if (!existing || pointRichness(row) > pointRichness(existing)) byReport.set(row.reportId, row);
    }
    const selectedRows = [...byReport.values()].sort((left, right) =>
      String(left.examDate || "").localeCompare(String(right.examDate || ""))
      || left.reportId.localeCompare(right.reportId)
    );
    const seenDuplicates = new Set<string>();
    const points = selectedRows.flatMap((row) => {
      const evidence = parseTrackingEvidence(row.evidenceJson, row);
      const point: MorphologyTrackingPoint = {
        findingId: row.id,
        reportId: row.reportId,
        reportTitle: row.reportTitle,
        reportStatus: row.reportStatus,
        reportIssuedAt: row.examDate,
        hospitalName: row.hospitalName,
        findingName: row.findingName,
        organ: row.organ,
        region: row.region,
        laterality: row.laterality,
        findingType: row.findingType,
        presence: row.presence,
        size: {
          length: row.sizeLength,
          width: row.sizeWidth,
          height: row.sizeHeight,
          unit: row.sizeUnit,
          label: sizeLabel(row),
          primaryMm: sizePrimaryMillimeters(row)
        },
        morphology: row.morphology,
        classification: classification(row),
        comparisonText: row.comparisonText,
        rawText: row.rawText,
        evidenceQuote: evidence?.quote || null,
        matchConfidence: row.matchConfidence,
        manualFields: [...manualFieldSet(row)],
        sourcePage: evidence ? pages.get(`${row.reportId}:${evidence.pageNumber}`) || null : null
      };
      const duplicateKey = [
        String(row.examDate || "").slice(0, 10),
        compactKey(row.hospitalName),
        row.presence,
        point.size.primaryMm ?? "",
        compactKey(point.classification?.label),
        compactKey(point.rawText)
      ].join("|");
      if (seenDuplicates.has(duplicateKey)) return [];
      seenDuplicates.add(duplicateKey);
      return [point];
    });
    if (!points.length) return [];
    const change = changeSummary(points);
    return [{
      trackingGroupId,
      name: presentation.name,
      organ: descriptor.organ,
      region: descriptor.region,
      laterality: descriptor.laterality,
      findingType: descriptor.type,
      pointCount: points.length,
      firstDate: points[0]?.reportIssuedAt || null,
      lastDate: points.at(-1)?.reportIssuedAt || null,
      latest: points.at(-1)!,
      previous: points.length > 1 ? points.at(-2)! : null,
      changeKind: change.kind,
      changeSummary: change.summary,
      points
    } satisfies MorphologyTrackingSeries];
  }).sort((left, right) =>
    Number(right.pointCount > 1) - Number(left.pointCount > 1)
    || String(right.lastDate || "").localeCompare(String(left.lastDate || ""))
    || left.name.localeCompare(right.name, "zh-CN")
  );

  const untracked: UntrackedMorphologyFinding[] = rows
    .filter((row) => !row.trackingGroupId)
    .map((row) => ({
      findingId: row.id,
      reportId: row.reportId,
      reportTitle: row.reportTitle,
      reportIssuedAt: row.examDate,
      hospitalName: row.hospitalName,
      findingName: row.findingName,
      organ: normalizeMorphologyOrgan(row.organ || row.findingName),
      findingType: row.findingType,
      region: row.region,
      laterality: row.laterality,
      presence: row.presence,
      size: {
        length: row.sizeLength,
        width: row.sizeWidth,
        height: row.sizeHeight,
        unit: row.sizeUnit,
        label: sizeLabel(row),
        primaryMm: sizePrimaryMillimeters(row)
      },
      morphology: row.morphology,
      classification: classification(row),
      rawText: row.rawText,
      manualFields: [...manualFieldSet(row)],
      reason: untrackedReason(row, ambiguous)
    }))
    .sort((left, right) => String(right.reportIssuedAt || "").localeCompare(String(left.reportIssuedAt || "")));

  return {
    ruleVersion: trackingRuleVersion,
    summary: {
      groups: series.length,
      multiRecordGroups: series.filter((item) => item.pointCount > 1).length,
      findings: series.reduce((sum, item) => sum + item.pointCount, 0),
      untracked: untracked.length
    },
    series,
    untracked
  };
}

type EditableFindingInput = Record<string, unknown>;
const editableColumns = {
  organ: "organ", region: "region", laterality: "laterality",
  findingType: "finding_type", findingName: "finding_name", presence: "presence",
  findingCount: "finding_count", sizeLength: "size_length", sizeWidth: "size_width",
  sizeHeight: "size_height", sizeUnit: "size_unit", morphology: "morphology_text",
  classificationSystem: "classification_system", classificationValue: "classification_value",
  classificationText: "classification_text"
} as const;

function findingForManage(user: RequestUser, findingId: string) {
  const row = getDatabase().prepare(`
    SELECT f.id, f.report_id AS reportId, r.member_id AS memberId,
      f.tracking_group_id AS trackingGroupId, f.laterality,
      f.manual_fields_json AS manualFieldsJson
    FROM morphology_findings f JOIN reports r ON r.id = f.report_id
    WHERE f.id = ? AND r.status <> 'trashed'
  `).get(findingId) as {
    id: string; reportId: string; memberId: string; trackingGroupId: string | null;
    laterality: MorphologyLaterality; manualFieldsJson: string;
  } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "形态发现不存在" });
  assertMemberManage(user, row.memberId);
  return row;
}

function textValue(value: unknown, maxLength = 300) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || null : null;
}

function numberValue(value: unknown, integer = false) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return integer ? Math.round(parsed) : parsed;
}

function appendAudit(user: RequestUser, action: string, findingId: string | null, detail: Record<string, unknown>) {
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'morphology_finding', ?, ?)
  `).run(createId("audit"), user.id, action, findingId, JSON.stringify(detail));
}

export function updateMorphologyFinding(user: RequestUser, findingId: string, input: EditableFindingInput) {
  const finding = findingForManage(user, findingId);
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const changed = new Set<string>();
  for (const [key, column] of Object.entries(editableColumns) as Array<[keyof typeof editableColumns, string]>) {
    if (!(key in input)) continue;
    let value: string | number | null;
    if (["sizeLength", "sizeWidth", "sizeHeight"].includes(key)) value = numberValue(input[key]);
    else if (key === "findingCount") value = numberValue(input[key], true);
    else if (key === "laterality") {
      value = ["left", "right", "bilateral", "midline", "unspecified"].includes(String(input[key]))
        ? String(input[key]) : "unspecified";
    } else if (key === "presence") {
      value = ["present", "absent", "uncertain"].includes(String(input[key])) ? String(input[key]) : "uncertain";
    } else value = textValue(input[key], key === "morphology" ? 3000 : 300);
    if (["findingType", "findingName"].includes(key) && !value) {
      throw createError({ statusCode: 400, statusMessage: "发现类型和名称不能为空" });
    }
    updates.push(`${column} = ?`);
    values.push(value);
    changed.add(
      ["sizeLength", "sizeWidth", "sizeHeight", "sizeUnit"].includes(key)
        ? "size"
        : ["classificationSystem", "classificationValue", "classificationText"].includes(key)
          ? "classification"
          : key
    );
  }
  if (!updates.length) throw createError({ statusCode: 400, statusMessage: "没有需要保存的形态字段" });
  const manualFields = manualFieldSet(finding);
  for (const key of changed) manualFields.add(key);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE morphology_findings SET ${updates.join(", ")}, source = 'manual',
      manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, JSON.stringify([...manualFields]), findingId);
    appendAudit(user, "morphology.update", findingId, { memberId: finding.memberId, fields: [...changed] });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  rebuildMorphologyTrackingForMember(finding.memberId);
  return listMorphologyTracking(user, finding.memberId);
}

function assertCompatibleLaterality(source: MorphologyLaterality, target: MorphologyLaterality) {
  if (["left", "right"].includes(source) && ["left", "right"].includes(target) && source !== target) {
    throw createError({ statusCode: 400, statusMessage: "左右侧明确冲突，不能关联到同一变化线" });
  }
}

function manualTrackingId() {
  return `manual_morph_${createId("group").replace(/[^a-zA-Z0-9_]/g, "")}`;
}

export function setMorphologyTracking(user: RequestUser, findingId: string, input: Record<string, unknown>) {
  const finding = findingForManage(user, findingId);
  const mode = String(input.mode || "");
  let groupId: string | null = null;
  let targetRows: FindingRow[] = [];
  let targetLabelFindingId: string | null = null;
  let action = finding.trackingGroupId ? "morphology.split" : "morphology.separate";
  if (mode === "existing") {
    groupId = textValue(input.trackingGroupId, 100);
    if (!groupId) throw createError({ statusCode: 400, statusMessage: "请选择要关联的变化线" });
    const memberRows = trackingRows(finding.memberId);
    targetRows = memberRows.filter((row) => row.trackingGroupId === groupId);
    if (!targetRows.length) throw createError({ statusCode: 404, statusMessage: "目标变化线不存在" });
    for (const target of targetRows) assertCompatibleLaterality(finding.laterality, target.laterality);
    const { descriptors } = trackingAssignments(memberRows);
    targetLabelFindingId = trackingGroupPresentation(targetRows, descriptors)?.preferredRow.id || null;
    action = "morphology.link";
  } else if (mode === "separate") groupId = manualTrackingId();
  else if (mode !== "automatic") throw createError({ statusCode: 400, statusMessage: "关联方式无效" });

  const manualFields = manualFieldSet(finding);
  if (mode === "automatic") {
    manualFields.delete("trackingGroup");
    manualFields.delete(trackingGroupLabelField);
  } else {
    manualFields.add("trackingGroup");
    if (mode === "separate" || targetLabelFindingId === findingId) {
      manualFields.add(trackingGroupLabelField);
    } else {
      manualFields.delete(trackingGroupLabelField);
    }
  }
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const target of targetRows) {
      if (target.id === findingId) continue;
      const targetManualFields = manualFieldSet(target);
      if (target.id === targetLabelFindingId) targetManualFields.add(trackingGroupLabelField);
      else targetManualFields.delete(trackingGroupLabelField);
      db.prepare(`UPDATE morphology_findings SET manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(JSON.stringify([...targetManualFields]), target.id);
    }
    db.prepare(`UPDATE morphology_findings SET tracking_group_id = ?, match_confidence = ?,
      manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(groupId, groupId ? 1 : null, JSON.stringify([...manualFields]), findingId);
    appendAudit(user, action, findingId, { memberId: finding.memberId, trackingGroupId: groupId, mode });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (mode === "automatic") rebuildMorphologyTrackingForMember(finding.memberId);
  return listMorphologyTracking(user, finding.memberId);
}

export function ignoreMorphologyFinding(user: RequestUser, findingId: string) {
  const finding = findingForManage(user, findingId);
  const manualFields = manualFieldSet(finding);
  manualFields.add("ignored");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE morphology_findings SET tracking_group_id = NULL, match_confidence = NULL,
      source = 'manual', manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify([...manualFields]), findingId);
    appendAudit(user, "morphology.ignore", findingId, { memberId: finding.memberId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listMorphologyTracking(user, finding.memberId);
}

export function mergeMorphologyTrackingGroups(user: RequestUser, memberId: string, sourceGroupId: string, targetGroupId: string) {
  assertMemberManage(user, memberId);
  if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
    throw createError({ statusCode: 400, statusMessage: "请选择两个不同的变化线" });
  }
  const memberRows = trackingRows(memberId);
  const rows = memberRows.filter((row) => [sourceGroupId, targetGroupId].includes(row.trackingGroupId || ""));
  const source = rows.filter((row) => row.trackingGroupId === sourceGroupId);
  const target = rows.filter((row) => row.trackingGroupId === targetGroupId);
  if (!source.length || !target.length) throw createError({ statusCode: 404, statusMessage: "变化线不存在" });
  for (const left of source) for (const right of target) assertCompatibleLaterality(left.laterality, right.laterality);
  const { descriptors } = trackingAssignments(memberRows);
  const targetLabelFindingId = trackingGroupPresentation(target, descriptors)?.preferredRow.id || target[0]!.id;
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of target) {
      const manualFields = manualFieldSet(row);
      if (row.id === targetLabelFindingId) manualFields.add(trackingGroupLabelField);
      else manualFields.delete(trackingGroupLabelField);
      db.prepare(`UPDATE morphology_findings SET manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(JSON.stringify([...manualFields]), row.id);
    }
    for (const row of source) {
      const manualFields = manualFieldSet(row);
      manualFields.add("trackingGroup");
      manualFields.delete(trackingGroupLabelField);
      db.prepare(`UPDATE morphology_findings SET tracking_group_id = ?, match_confidence = 1,
        manual_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(targetGroupId, JSON.stringify([...manualFields]), row.id);
    }
    appendAudit(user, "morphology.merge", null, { memberId, sourceGroupId, targetGroupId, count: source.length });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listMorphologyTracking(user, memberId);
}

export function rebuildMorphologyTrackingForAdministrator(user: RequestUser) {
  if (!isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可重新关联历史形态发现" });
  }
  const result = rebuildAllMorphologyTracking();
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.rebuild_morphology_tracking', 'morphology_finding', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify(result));
  return result;
}
