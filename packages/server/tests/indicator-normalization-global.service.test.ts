import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  assessPersistedObservationReference,
  convertUnit,
  indicatorNameCandidates,
  listIndicatorNormalizationIssues,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";
import { installRemoteDictionarySnapshotForTests } from "../services/indicator-dictionary.service.ts";
import { getReportDetail, listTrendSeries } from "../services/records.service.ts";

test("reference evidence is independent of manual confirmation and range validity", () => {
  const input = { referenceLow: 5, referenceHigh: 21, referenceText: "5-21",
    hasAiExtraction: 1, evidenceJson: '[{"pageNumber":1,"quote":"T-BIL 12.3 μmol/L"}]' };
  assert.equal(assessPersistedObservationReference(input).status, "raw_only");
  assert.equal(assessPersistedObservationReference(input).low, null);
  assert.equal(assessPersistedObservationReference({ ...input, manualReviewed: true }).status, "trusted");
  assert.equal(assessPersistedObservationReference({ ...input, manualReviewed: true, referenceLow: 30 }).low, null);
  assert.equal(assessPersistedObservationReference({ ...input, hasAiExtraction: 0 }).status, "trusted");
});

test("splits report codes from names without removing medical qualifiers", () => {
  assert.ok(indicatorNameCandidates("白细胞数目 WBC").includes("白细胞数目"));
  assert.ok(indicatorNameCandidates("白细胞(WhiteCell)").includes("whitecell"));
  assert.ok(indicatorNameCandidates("WBC-白细胞计数").includes("白细胞计数"));
  assert.ok(indicatorNameCandidates("中性粒细胞比率 NEUT%").includes("中性粒细胞比率"));
  assert.notDeepEqual(
    indicatorNameCandidates("中性粒细胞比率 NEUT%"),
    indicatorNameCandidates("中性粒细胞绝对值 NEUT#")
  );
  assert.notDeepEqual(
    indicatorNameCandidates("全血粘度（高切）"),
    indicatorNameCandidates("全血粘度（低切）")
  );
  assert.ok(indicatorNameCandidates("全血粘度(5/s)").includes("全血粘度(5/s)"));
  assert.notDeepEqual(
    indicatorNameCandidates("空腹血糖"),
    indicatorNameCandidates("餐后血糖")
  );
  assert.notDeepEqual(
    indicatorNameCandidates("FEV1.0%(G)"),
    indicatorNameCandidates("FEV1.0%(T)")
  );
});

test("removes OCR report ordinals before dictionary matching", () => {
  assert.ok(indicatorNameCandidates(" ＊ 3.谷草/谷丙 ** ").includes("谷草/谷丙"));
  assert.ok(indicatorNameCandidates("﹡白细胞＊").includes("白细胞"));
  assert.ok(indicatorNameCandidates("*NEUT%*").includes("neut%"));
  assert.ok(indicatorNameCandidates("*NEUT#*").includes("neut#"));
  assert.ok(indicatorNameCandidates("A*B").includes("a*b"));
  assert.deepEqual(indicatorNameCandidates("＊＊"), []);
  assert.ok(indicatorNameCandidates("3.谷草/谷丙").includes("谷草/谷丙"));
  assert.ok(indicatorNameCandidates("19.红细胞分布宽度(SD)").includes("红细胞分布宽度"));
  assert.ok(indicatorNameCandidates("23、TSH").includes("tsh"));
  assert.ok(indicatorNameCandidates("（8）TSH").includes("tsh"));
  assert.ok(indicatorNameCandidates("No.9 中性粒细胞绝对数").includes("中性粒细胞绝对数"));
  assert.ok(indicatorNameCandidates("10 单核细胞绝对数").includes("单核细胞绝对数"));
});

test("removes report status, result suffixes and conclusion prefixes without losing the raw name", () => {
  assert.ok(indicatorNameCandidates("(N)癌胚抗原").includes("癌胚抗原"));
  assert.ok(indicatorNameCandidates("RV5+SV1:1.75mV").includes("rv5+sv1"));
  assert.ok(indicatorNameCandidates("4、血清尿素测定减低").includes("血清尿素"));
  assert.ok(indicatorNameCandidates("您本次体检一般检查示体重指数").includes("体重指数"));
});

test("truncates result values, reference ranges and dates glued into indicator names", () => {
  assert.ok(
    indicatorNameCandidates("血清泌乳素测定值偏高(24.11ng/ml)(参考值男:2.7-13").includes("血清泌乳素")
  );
  assert.ok(
    indicatorNameCandidates("型串联质谱检测:25-羟基维生素D17.23ng/mL:2026-06-15总IgE,肺炎支原体三项,肺炎支原体")
      .includes("25羟基维生素d")
  );
  assert.ok(
    indicatorNameCandidates("抗体,20项过敏原测定:免疫球蛋白E(Ig)291.0ng/ml:2026-06-16体液细胞形态学检测:颜色")
      .includes("免疫球蛋白e")
  );
  // 括号内的测量条件和侧别命名是指标本体，不受值边界截断影响。
  assert.ok(indicatorNameCandidates("全血粘度(5/s)").includes("全血粘度(5/s)"));
  assert.ok(indicatorNameCandidates("全血粘度(5/s)").every((candidate) => candidate !== "全血粘度"));
  assert.ok(indicatorNameCandidates("RV5+SV1:1.75mV").includes("rv5+sv1"));
});

test("normalizes English indicator separators consistently", () => {
  assert.deepEqual(
    indicatorNameCandidates("anti_thyroid_peroxidase antibody"),
    indicatorNameCandidates("Anti-thyroid peroxidase antibody")
  );
});

test("strips trailing value placeholders so alias matching can hit the dictionary", () => {
  assert.ok(indicatorNameCandidates("血清尿酸值").includes("血清尿酸"));
  assert.ok(indicatorNameCandidates("尿酸测定值").includes("尿酸"));
  assert.ok(indicatorNameCandidates("pH值").includes("ph"));
  // 原名保留，且本身以「值」结尾的指标名不会被剥坏
  assert.ok(indicatorNameCandidates("国际标准化比值").includes("国际标准化比值"));
});

test("keeps immunoglobulin class brackets as part of the indicator identity", () => {
  // TORCH 筛查中 (IgG)/(IgM) 是指标本体：剥掉后 IgM 会错配到 IgG 条目
  assert.ok(indicatorNameCandidates("弓形虫抗体测定(IgM)").includes("弓形虫抗体测定(igm)"));
  assert.ok(indicatorNameCandidates("弓形虫抗体测定(IgG)").includes("弓形虫抗体测定(igg)"));
  assert.notDeepEqual(
    indicatorNameCandidates("风疹病毒抗体测定(IgM)"),
    indicatorNameCandidates("风疹病毒抗体测定(IgG)")
  );
});

test("reorders bracketed laterality so prefixed dictionary aliases can match", () => {
  // 字典别名是「右PWV」「左侧baPWV」前置形式，「PWV(右)」需要重排候选才能命中
  assert.ok(indicatorNameCandidates("PWV(右)").includes("右pwv"));
  assert.ok(indicatorNameCandidates("PWV(右)").includes("pwv右"));
  assert.ok(indicatorNameCandidates("baPWV（左侧）").includes("左侧bapwv"));
  // 左右候选保持区分，不会合并成同一身份
  assert.notDeepEqual(
    indicatorNameCandidates("PWV(左)"),
    indicatorNameCandidates("PWV(右)")
  );
});

test("accepts hyphenated canonical names when OCR evidence closes the same normalized loop", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-hyphen-evidence-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('evidence-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('evidence-member', '本人', 'self', 'evidence-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('evidence-report', 'evidence-member', 'evidence-user', 'laboratory', '专项检验', 'ready', '2026-08-01');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, attempts, pipeline_version, deduplication_key, finished_at
      ) VALUES ('evidence-ai-job', 'evidence-report', 'ai_extract', 'completed', 1, 'test', 'evidence-ai-job', CURRENT_TIMESTAMP);
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json
      ) VALUES (
        'evidence-extraction', 'evidence-report', 'evidence-ai-job', 'test', 'test', 'test',
        '{}', '{}', '{}', '{}'
      );
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, evidence_json
      ) VALUES (
        'hyphen-evidence-observation', 'evidence-report', '肿瘤标志物',
        'T-BIL', 'T-BIL', '12.3',
        12.3, 'μmol/L', 5, 21, '5-21',
        '[{"pageNumber":1,"quote":"T-BIL | 12.3 | μmol/L | 5-21"}]'
      );
    `);

    normalizeReportObservations("evidence-report");
    const row = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id = 'hyphen-evidence-observation'
    `).get() as { canonicalKey: string | null; quality: string; excludedReason: string | null };

    assert.equal(row.canonicalKey, "liver_tbil");
    assert.equal(row.quality, "high");
    assert.equal(row.excludedReason, null);
    db.prepare(`INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('evidence-member', 'evidence-user', 'manager', 'evidence-user')`).run();
    const user: RequestUser = { id: 'evidence-user', displayName: '用户', provider: 'fnos_gateway',
      authenticated: true, isGatewayAdmin: false };
    for (const [low, high] of [[1, 2], [30, 5]]) {
      db.prepare(`UPDATE observations SET reference_low = ?, reference_high = ?, reference_text = ?,
        evidence_json = ? WHERE id = 'hyphen-evidence-observation'`).run(low, high, `${low}-${high}`,
        JSON.stringify([{ pageNumber: 1, quote: 'T-BIL | 12.3 | μmol/L' }]));
      normalizeReportObservations('evidence-report');
      const normalized = db.prepare(`SELECT quality FROM observation_normalizations
        WHERE observation_id = 'hyphen-evidence-observation'`).get() as { quality: string };
      assert.equal(normalized.quality, 'high');
      const point = listTrendSeries(user, 'evidence-member')[0]?.points[0];
      assert.ok(point, 'reliable measured point remains in trends');
      assert.equal(point.referenceLow, null);
      assert.equal(point.referenceHigh, null);
      const detail = getReportDetail(user, 'evidence-report');
      assert.equal(detail.observations[0].referenceLow, null);
      assert.equal(detail.observations[0].displayAbnormalFlag, null);
    }
    // Ablation: relaxing the reference gate must not relax value or unit evidence.
    for (const quote of ['T-BIL | 99 | μmol/L', 'T-BIL | 12.3']) {
      db.prepare(`UPDATE observations SET evidence_json = ?
        WHERE id = 'hyphen-evidence-observation'`).run(JSON.stringify([{ pageNumber: 1, quote }]));
      normalizeReportObservations('evidence-report');
      const rejected = db.prepare(`SELECT quality FROM observation_normalizations
        WHERE observation_id = 'hyphen-evidence-observation'`).get() as { quality: string };
      assert.equal(rejected.quality, 'low');
      assert.equal(listTrendSeries(user, 'evidence-member').length, 0);
    }
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("normalizes common checkup indicators and keeps ambiguous source types separate", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-common-indicators-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users (id, display_name) VALUES ('global-user', '用户')").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('global-member', '本人', 'self', 'global-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, hospital_name_raw, report_issued_at
      ) VALUES ('common-report', 'global-member', 'global-user', 'checkup', '年度体检', 'ready', '示例体检中心', '2026-07-28')
    `).run();
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'common-report', ?, ?, ?, ?, ?, ?)
    `);
    insert.run("common-sbp", "一般检查", "收缩压", "收缩压", "128", 128, "mmHg");
    insert.run("common-hct", "血常规", "HCT", "红细胞压积", "0.42", 0.42, "L/L");
    insert.run("common-urine-protein-number", "尿常规", "尿蛋白", "尿蛋白", "120", 120, "mg/L");
    insert.run("common-urine-protein-state", "尿常规", "尿蛋白", "尿蛋白", "阴性", null, null);
    insert.run("common-egfr", "肾功能", "eGFR", "估算肾小球滤过率", "98", 98, "mL/min/1.73m²");
    insert.run("common-bun", "肾功能", "BUN", "尿素氮", "14", 14, "mg/dL");
    insert.run("common-urea", "肾功能", "尿素", "尿素", "30", 30, "mg/dL");
    insert.run("common-stool-wbc", "便常规", "白细胞", "白细胞", "-", null, null);
    insert.run("common-urine-wbc", "尿常规 / 尿镜检", "镜检白细胞", "镜检白细胞", "2", 2, "Cell/HP");
    insert.run("common-blood-wbc", "血常规", "白细胞", "白细胞", "5.2", 5.2, "10^9/L");
    insert.run("common-pulse", "一般检查", "心率", "心率", "72", 72, "bpm");
    insert.run("common-ecg-rate", "心电图检查报告单 / 检查描述", "心率", "心率", "73", 73, "bpm");
    insert.run("common-urine-ph", "尿常规", "酸碱度", "酸碱度", "6.0", 6, null);
    insert.run("common-eosinophil-count", "血常规", "嗜酸性粒细胞数", "嗜酸性粒细胞数", "0.2", 0.2, "10^9/L");
    insert.run("common-basophil-count", "血常规", "嗜碱性粒细胞数", "嗜碱性粒细胞数", "0.01", 0.01, "10^9/L");
    insert.run("common-total-t3", "甲状腺功能三项", "三碘甲状腺原氨酸（T3）", "三碘甲状腺原氨酸", "2.56", 2.56, "nmol/L");
    insert.run("common-total-t4", "甲状腺功能三项", "甲状腺素（T4）", "甲状腺素", "109.17", 109.17, "nmol/L");
    insert.run("common-total-psa", "肿瘤标志物", "前列腺特异性抗原", "前列腺特异性抗原", "0.34", 0.34, "ng/mL");
    insert.run("common-abi-right", "动脉功能检查", "右侧踝肱指数", "右侧踝肱指数", "1.07", 1.07, null);
    insert.run("common-abi-left", "动脉功能检查", "左侧踝肱指数", "左侧踝肱指数", "1.08", 1.08, null);
    insert.run("common-bapwv-right", "动脉功能检查", "右侧肱踝脉搏波传导速度", "右侧肱踝脉搏波传导速度", "1315", 1315, "cm/s");
    insert.run("common-bapwv-left", "动脉功能检查", "左侧肱踝脉搏波传导速度", "左侧肱踝脉搏波传导速度", "1395", 1395, "cm/s");
    insert.run("common-serum-alp", "肝功能", "血清碱性磷酸酶", null, "72", 72, "U/L");
    insert.run("common-serum-tbil", "肝功能", "血清总胆红素", null, "12", 12, "μmol/L");
    insert.run("common-serum-cystatin", "肾功能", "血清胱抑素C测定", null, "0.8", 0.8, "mg/L");

    normalizeReportObservations("common-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality
      FROM observation_normalizations
      WHERE observation_id LIKE 'common-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: string;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(byId.get("common-sbp")?.canonicalKey, "vital_systolic_bp");
    assert.equal(byId.get("common-hct")?.canonicalKey, "cbc_hct");
    assert.equal(byId.get("common-hct")?.canonicalValue, 42);
    assert.equal(byId.get("common-hct")?.canonicalUnit, "%");
    assert.equal(byId.get("common-urine-protein-number")?.canonicalKey, "urine_protein_quantitative");
    assert.equal(byId.get("common-urine-protein-number")?.canonicalUnit, "mg/L");
    assert.equal(byId.get("common-urine-protein-state")?.canonicalKey, "urine_protein");
    assert.equal(byId.get("common-urine-protein-state")?.quality, "excluded");
    assert.equal(byId.get("common-egfr")?.canonicalKey, "renal_egfr");
    assert.equal(byId.get("common-bun")?.canonicalKey, "renal_bun");
    assert.ok(Math.abs((byId.get("common-bun")?.canonicalValue || 0) - 4.998) < 0.001);
    assert.equal(byId.get("common-urea")?.canonicalKey, "renal_urea");
    assert.ok(Math.abs((byId.get("common-urea")?.canonicalValue || 0) - 4.995) < 0.001);
    assert.equal(byId.get("common-stool-wbc")?.canonicalKey, "stool_wbc");
    assert.equal(byId.get("common-stool-wbc")?.quality, "excluded");
    assert.equal(byId.get("common-urine-wbc")?.canonicalKey, "urine_wbc");
    assert.equal(byId.get("common-blood-wbc")?.canonicalKey, "cbc_wbc");
    assert.equal(byId.get("common-pulse")?.canonicalKey, "vital_pulse");
    assert.equal(byId.get("common-ecg-rate")?.canonicalKey, "ecg_heart_rate");
    assert.equal(byId.get("common-urine-ph")?.canonicalKey, "urine_ph");
    assert.equal(byId.get("common-eosinophil-count")?.canonicalKey, "cbc_eosinophil_count");
    assert.equal(byId.get("common-basophil-count")?.canonicalKey, "cbc_basophil_count");
    assert.equal(byId.get("common-total-t3")?.canonicalKey, "thyroid_t3_total");
    assert.equal(byId.get("common-total-t4")?.canonicalKey, "thyroid_t4_total");
    assert.equal(byId.get("common-total-psa")?.canonicalKey, "tumor_psa_total");
    assert.equal(byId.get("common-abi-right")?.canonicalKey, "vascular_abi_right");
    assert.equal(byId.get("common-abi-left")?.canonicalKey, "vascular_abi_left");
    assert.equal(byId.get("common-bapwv-right")?.canonicalKey, "vascular_bapwv_right");
    assert.equal(byId.get("common-bapwv-left")?.canonicalKey, "vascular_bapwv_left");
    assert.equal(byId.get("common-serum-alp")?.canonicalKey, "liver_alp");
    assert.equal(byId.get("common-serum-alp")?.quality, "high");
    assert.equal(byId.get("common-serum-tbil")?.canonicalKey, "liver_tbil");
    assert.equal(byId.get("common-serum-tbil")?.quality, "high");
    assert.equal(byId.get("common-serum-cystatin")?.canonicalKey, "renal_cystatin_c");
    assert.equal(byId.get("common-serum-cystatin")?.quality, "high");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("standardizes audited laboratory and ophthalmology candidates without merging laterality or deriving ratios", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-audited-candidates-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('audit-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('audit-member', '本人', 'self', 'audit-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('audit-report', 'audit-member', 'audit-user', 'checkup', '专项体检', 'ready', '2026-08-01');
    `);
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'audit-report', ?, ?, NULL, ?, ?, ?)
    `);
    for (const observation of [
      ["audit-ldh", "心肌酶谱四项", "乳酸脱氢酶", "180 U/L", 180, "U/L"],
      ["audit-ck", "心肌酶谱四项", "血清磷酸肌酸激酶", "120 U/L", 120, "U/L"],
      ["audit-ck-mb", "心肌酶谱四项", "肌酸激酶同工酶(CK-MB)", "12 U/L", 12, "U/L"],
      ["audit-amylase", "淀粉酶(AMY)", "淀粉酶", "80 U/L", 80, "U/L"],
      ["audit-iop-right", "眼科", "右眼眼压", "18 mmHg", 18, "mmHg"],
      ["audit-iop-left", "眼科", "左眼眼压", "17 mmHg", 17, "mmHg"],
      ["audit-testosterone", "睾酮测定（TTE）", "睾酮测定", "4.2 ng/mL", 4.2, "ng/mL"],
      ["audit-prolactin", "血清泌乳素测定（PRL）", "血清泌乳素测定", "20 ng/ml", 20, "ng/ml"],
      ["audit-pepsinogen-i", "胃蛋白酶原测定", "胃蛋白酶原I", "60 μg/L", 60, "μg/L"],
      ["audit-pepsinogen-ii", "胃蛋白酶原测定", "胃蛋白酶原II", "10 μg/L", 10, "μg/L"],
      ["audit-pepsinogen-ratio", "胃蛋白酶原测定", "胃蛋白酶原比值", "8.5", 8.5, null]
    ] as const) insert.run(...observation);

    normalizeReportObservations("audit-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality
      FROM observation_normalizations
      WHERE observation_id LIKE 'audit-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: string;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));
    const expected = new Map([
      ["audit-ldh", ["laboratory_ldh", "U/L"]],
      ["audit-ck", ["laboratory_ck", "U/L"]],
      ["audit-ck-mb", ["laboratory_ck_mb", "U/L"]],
      ["audit-amylase", ["laboratory_amylase", "U/L"]],
      ["audit-iop-right", ["ophthalmology_intraocular_pressure_right", "mmHg"]],
      ["audit-iop-left", ["ophthalmology_intraocular_pressure_left", "mmHg"]],
      ["audit-testosterone", ["laboratory_testosterone", "ng/mL"]],
      ["audit-prolactin", ["laboratory_prolactin", "ng/mL"]],
      ["audit-pepsinogen-i", ["laboratory_pepsinogen_i", "μg/L"]],
      ["audit-pepsinogen-ii", ["laboratory_pepsinogen_ii", "μg/L"]]
    ] as const);
    for (const [observationId, [canonicalKey, canonicalUnit]] of expected) {
      assert.equal(byId.get(observationId)?.canonicalKey, canonicalKey);
      assert.equal(byId.get(observationId)?.canonicalUnit, canonicalUnit);
      assert.equal(byId.get(observationId)?.quality, "high");
    }
    assert.notEqual(
      byId.get("audit-iop-right")?.canonicalKey,
      byId.get("audit-iop-left")?.canonicalKey,
      "left and right intraocular pressure must remain separate trends"
    );
    assert.equal(byId.get("audit-pepsinogen-ratio")?.canonicalKey, "laboratory_pepsinogen_ratio");
    assert.equal(byId.get("audit-pepsinogen-ratio")?.canonicalUnit, null);
    assert.equal(byId.get("audit-pepsinogen-ratio")?.canonicalValue, 8.5);
    assert.equal(byId.get("audit-pepsinogen-ratio")?.quality, "medium");
    assert.notEqual(
      byId.get("audit-pepsinogen-ratio")?.canonicalValue,
      (byId.get("audit-pepsinogen-i")?.canonicalValue || 0)
        / (byId.get("audit-pepsinogen-ii")?.canonicalValue || 1),
      "the system must retain the explicitly reported ratio instead of calculating it"
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("converts units for newly covered common indicators", () => {
  assert.equal(convertUnit("cbc_mchc", 33, "g/dL", "g/L"), 330);
  assert.ok(Math.abs(convertUnit("glucose_postprandial_2h", 180, "mg/dL", "mmol/L") - 9.99) < 0.01);
  assert.ok(Math.abs(convertUnit("renal_creatinine", 1, "mg/dL", "μmol/L") - 88.4) < 0.001);
  assert.ok(Math.abs(convertUnit("liver_dbil", 1, "mg/dL", "μmol/L") - 17.104) < 0.001);
  assert.ok(Math.abs(convertUnit("laboratory_testosterone", 420, "ng/dL", "ng/mL") - 4.2) < 1e-9);
  assert.equal(convertUnit("laboratory_prolactin", 20, "μg/L", "ng/mL"), 20);
  assert.equal(convertUnit("laboratory_pepsinogen_i", 60, "ng/mL", "μg/L"), 60);
});

test("gates ambiguous aliases unless section, unit, or result type uniquely disambiguates them", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ambiguous-indicators-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('ambiguous-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('ambiguous-member', '本人', 'self', 'ambiguous-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('ambiguous-report', 'ambiguous-member', 'ambiguous-user', 'checkup', '专项检查', 'ready', '2026-08-01');
    `);
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'ambiguous-report', ?, ?, ?, ?, ?, ?)
    `);
    for (const row of [
      ["ambiguous-heart-rate", null, "心率", "心率", "72", 72, "bpm"],
      ["ecg-heart-rate", "心电图", "心率", "心率", "73", 73, "bpm"],
      ["vital-heart-rate", "生命体征", "心率", "心率", "71", 71, "bpm"],
      ["ambiguous-wbc", null, "白细胞计数", "白细胞计数", "5.2", 5.2, null],
      ["blood-wbc-unit", null, "WBC", "WBC", "5.1", 5.1, "10^9/L"],
      ["urine-wbc-context", "尿沉渣", "白细胞计数", "白细胞计数", "3", 3, "/HPF"],
      ["stool-wbc-context", "便常规", "白细胞", "白细胞", "-", null, null],
      ["urine-protein-no-unit", "尿蛋白定量", "尿蛋白定量", "尿蛋白定量", "120", 120, null],
      ["urine-protein-state", "尿常规", "尿蛋白", "尿蛋白", "阴性", null, null]
    ] as const) insert.run(...row);

    normalizeReportObservations("ambiguous-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        quality, match_reason AS matchReason, excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id LIKE 'ambiguous-%'
         OR observation_id IN ('ecg-heart-rate', 'vital-heart-rate', 'blood-wbc-unit', 'urine-wbc-context', 'stool-wbc-context', 'urine-protein-no-unit', 'urine-protein-state')
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      quality: string;
      matchReason: string;
      excludedReason: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(byId.get("ambiguous-heart-rate")?.quality, "low");
    assert.match(byId.get("ambiguous-heart-rate")?.matchReason || "", /多义名称缺少章节/);
    assert.equal(byId.get("ecg-heart-rate")?.canonicalKey, "ecg_heart_rate");
    assert.equal(byId.get("ecg-heart-rate")?.quality, "high");
    assert.equal(byId.get("vital-heart-rate")?.canonicalKey, "vital_pulse");
    assert.equal(byId.get("vital-heart-rate")?.quality, "high");

    assert.equal(byId.get("ambiguous-wbc")?.quality, "low");
    assert.match(byId.get("ambiguous-wbc")?.matchReason || "", /多义名称缺少章节/);
    assert.equal(byId.get("blood-wbc-unit")?.canonicalKey, "cbc_wbc");
    assert.equal(byId.get("blood-wbc-unit")?.quality, "high");
    assert.equal(byId.get("urine-wbc-context")?.canonicalKey, "urine_wbc");
    assert.equal(byId.get("urine-wbc-context")?.quality, "high");
    assert.equal(byId.get("stool-wbc-context")?.canonicalKey, "stool_wbc");
    assert.equal(byId.get("stool-wbc-context")?.quality, "excluded");

    assert.equal(byId.get("urine-protein-no-unit")?.canonicalKey, "urine_protein_quantitative");
    assert.equal(byId.get("urine-protein-no-unit")?.quality, "low");
    assert.match(byId.get("urine-protein-no-unit")?.excludedReason || "", /缺少单位/);
    assert.equal(byId.get("urine-protein-state")?.canonicalKey, "urine_protein");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("maps bare QUS T/Z values only inside quantitative ultrasound bone context", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-qus-context-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('qus-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('qus-member', '本人', 'self', 'qus-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('qus-report', 'qus-member', 'qus-user', 'checkup', '骨健康检查', 'ready', '2026-08-01');
    `);
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'qus-report', ?, ?, ?, ?, ?, ?)
    `);
    for (const row of [
      ["qus-t", "超声骨密度检测报告", "T值", "超声骨密度 T 值", "-1.9", -1.9, null],
      ["qus-z", "超声骨密度检测报告", "Z值", "超声骨密度 Z 值", "-1.7", -1.7, null],
      ["generic-t", "其他功能检查", "T值", null, "1.2", 1.2, null],
      ["generic-z", "其他功能检查", "Z值", null, "0.8", 0.8, null]
    ] as const) insert.run(...row);

    normalizeReportObservations("qus-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, quality, matched_by AS matchedBy
      FROM observation_normalizations
      WHERE observation_id IN ('qus-t', 'qus-z', 'generic-t', 'generic-z')
      ORDER BY observation_id
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      quality: string;
      matchedBy: string;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.deepEqual(
      [byId.get("qus-t")?.canonicalKey, byId.get("qus-z")?.canonicalKey],
      ["qus_bone_t_score", "qus_bone_z_score"]
    );
    assert.deepEqual(
      [byId.get("qus-t")?.canonicalValue, byId.get("qus-z")?.canonicalValue],
      [-1.9, -1.7]
    );
    assert.deepEqual(
      [byId.get("qus-t")?.quality, byId.get("qus-z")?.quality],
      ["medium", "medium"]
    );
    assert.deepEqual(
      [byId.get("qus-t")?.matchedBy, byId.get("qus-z")?.matchedBy],
      ["builtin_alias", "builtin_alias"]
    );
    assert.equal(byId.get("generic-t")?.canonicalKey, null);
    assert.equal(byId.get("generic-z")?.canonicalKey, null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps side-qualified vascular indicators trend-ready when AI normalizes colloquial evidence names", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-vascular-evidence-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('vascular-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('vascular-member', '本人', 'self', 'vascular-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('vascular-report', 'vascular-member', 'vascular-user', 'checkup', '年度体检', 'ready', '2026-08-01');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key, finished_at
      ) VALUES (
        'vascular-ai-job', 'vascular-report', 'ai_extract', 'completed',
        'evidence-golden-v1', 'vascular-report:ai_extract:golden', CURRENT_TIMESTAMP
      );
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json, input_characters
      ) VALUES (
        'vascular-extraction', 'vascular-report', 'vascular-ai-job',
        'offline-golden', 'offline-golden', 'offline-golden-v1', '{}', '{}', '{}', '{}', 0
      );
    `);
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, item_code, result_text, numeric_value, unit, evidence_json
      ) VALUES (?, 'vascular-report', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // 真实回归场景：AI 把「右踝：1.07 | 左踝：1.08」规范为「右侧/左侧踝肱指数」，
    // 名称字面无法回指原文，但数值锚点完整，不应被逐出默认趋势。
    insert.run("vascular-abi-right", "动脉功能检查", "右侧踝肱指数", "右侧踝肱指数", "ABI", "1.07", 1.07, null,
      JSON.stringify([{ pageNumber: 21, quote: "右踝：1.07 | 左踝：1.08" }]));
    insert.run("vascular-abi-left", "动脉功能检查", "左侧踝肱指数", "左侧踝肱指数", "ABI", "1.08", 1.08, null,
      JSON.stringify([{ pageNumber: 21, quote: "右踝：1.07 | 左踝：1.08" }]));
    insert.run("vascular-bapwv-right", "动脉功能检查", "右侧肱踝脉搏波传导速度", "右侧肱踝脉搏波传导速度", "baPWV", "1315", 1315, "cm/s",
      JSON.stringify([{ pageNumber: 21, quote: "右：1315 | 左：1395 | 2000 | PWV(cm/s) | LD | 血管模型" }]));
    insert.run("vascular-bapwv-left", "动脉功能检查", "左侧肱踝脉搏波传导速度", "左侧肱踝脉搏波传导速度", "baPWV", "1395", 1395, "cm/s",
      JSON.stringify([{ pageNumber: 21, quote: "右：1315 | 左：1395 | 2000 | PWV(cm/s) | LD | 血管模型" }]));
    // 名称与数值都无法回指的条目仍然必须拦截。
    insert.run("vascular-hallucinated", "动脉功能检查", "收缩压", "收缩压", null, "128", 128, "mmHg",
      JSON.stringify([{ pageNumber: 21, quote: "右踝：1.07 | 左踝：1.08" }]));

    normalizeReportObservations("vascular-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, quality, excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id LIKE 'vascular-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      quality: string;
      excludedReason: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    // 通用项 vascular_abi / vascular_bapwv 只是侧别项的父级同族映射，不构成歧义。
    assert.equal(byId.get("vascular-abi-right")?.canonicalKey, "vascular_abi_right");
    assert.equal(byId.get("vascular-abi-left")?.canonicalKey, "vascular_abi_left");
    assert.equal(byId.get("vascular-bapwv-right")?.canonicalKey, "vascular_bapwv_right");
    assert.equal(byId.get("vascular-bapwv-left")?.canonicalKey, "vascular_bapwv_left");
    assert.equal(byId.get("vascular-abi-right")?.quality, "medium");
    assert.equal(byId.get("vascular-abi-left")?.quality, "medium");
    assert.equal(byId.get("vascular-bapwv-right")?.quality, "high");
    assert.equal(byId.get("vascular-bapwv-left")?.quality, "high");
    for (const id of ["vascular-abi-right", "vascular-abi-left", "vascular-bapwv-right", "vascular-bapwv-left"]) {
      assert.equal(byId.get(id)?.excludedReason, null, `${id} 不应携带趋势禁用原因`);
    }
    assert.equal(byId.get("vascular-hallucinated")?.quality, "low");
    assert.match(byId.get("vascular-hallucinated")?.excludedReason || "", /项目名称无法回指/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("classifies reported dictionary candidates without resubmitting known or policy-filtered names", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-feedback-candidates-"));
  process.env.STORAGE_DIR = storageDir;
  const admin: RequestUser = {
    id: "feedback-admin",
    displayName: "反馈管理员",
    provider: "development",
    authenticated: true,
    isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.exec(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES ('feedback-admin', '反馈管理员', 1);
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('feedback-member', '本人', 'self', 'feedback-admin');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES (
        'feedback-report', 'feedback-member', 'feedback-admin', 'checkup',
        '字典反馈回归', 'ready', '2026-08-11'
      );
    `);
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit
      ) VALUES (?, 'feedback-report', ?, ?, NULL, ?, ?, ?)
    `);
    for (const row of [
      ["feedback-rdw-cv", "血常规", "红细胞分布宽度(CV)", "12.5", 12.5, "%"],
      ["feedback-ast", "肝功能", "血清天门冬氨酸氨基转移", "22", 22, "U/L"],
      ["feedback-cholesterol", "血脂", "总胆固醇测定", "4.5", 4.5, "mmol/L"],
      ["feedback-glucose", "空腹生化", "血清葡萄糖测定", "5.1", 5.1, "mmol/L"],
      ["feedback-vision-left", "眼科视力", "矫正视力左", "1.0", 1, null],
      ["feedback-map", "生命体征血压", "MAP", "92", 92, "mmHg"],
      ["feedback-pulse-pressure", "生命体征血压", "脉压", "45", 45, "mmHg"],
      ["feedback-thyroglobulin", "甲状腺功能", "甲状腺球蛋白", "8.2", 8.2, "ng/mL"],
      ["feedback-h-pylori", "幽门螺杆菌抗体", "出门螺杆菌抗体测定", "阴性", null, null],
      ["feedback-middle-reduced", "血流变", "全血中切还原粘度", "8.1", 8.1, "mPa.s"],
      ["feedback-high-relative", "血流变", "全血相对粘度高切", "4.2", 4.2, null],
      ["feedback-middle-relative", "血流变", "全血相对粘度中切", "5.8", 5.8, null],
      ["feedback-electrophoresis", "血流变", "红细胞电泳指数", "4.6", 4.6, null],
      ["feedback-shear-rate", "血流变", "切变率(1/S)50.00", "5.2", 5.2, null],
      ["feedback-summary", "体检汇总", "小结", "未见明显异常", null, null],
      ["feedback-device-code", "动脉血管功能检查", "UTN", "120", 120, null],
      ["feedback-ambiguous-abi", "动脉血管功能检查", "AB11.01", "1.01", 1.01, null]
    ] as const) insert.run(...row);

    normalizeReportObservations("feedback-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        matched_by AS matchedBy
      FROM observation_normalizations
      WHERE observation_id LIKE 'feedback-%'
    `).all() as Array<{ observationId: string; canonicalKey: string | null; matchedBy: string }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(byId.get("feedback-rdw-cv")?.canonicalKey, "cbc_rdw_cv");
    assert.equal(byId.get("feedback-ast")?.canonicalKey, "liver_ast");
    assert.equal(byId.get("feedback-cholesterol")?.canonicalKey, "lipid_tc");
    assert.equal(byId.get("feedback-glucose")?.canonicalKey, "glucose_fasting");
    assert.equal(byId.get("feedback-vision-left")?.canonicalKey, "vision_corrected_left");
    assert.equal(byId.get("feedback-map")?.canonicalKey, "vital_mean_arterial_pressure");
    assert.equal(byId.get("feedback-pulse-pressure")?.canonicalKey, "vital_pulse_pressure");
    assert.equal(byId.get("feedback-thyroglobulin")?.canonicalKey, "thyroid_thyroglobulin");
    assert.equal(byId.get("feedback-h-pylori")?.canonicalKey, "infectious_h_pylori_antibody");
    assert.equal(byId.get("feedback-middle-reduced")?.canonicalKey, "hemorheology_whole_blood_middle_shear_reduced_viscosity");
    assert.equal(byId.get("feedback-high-relative")?.canonicalKey, "hemorheology_whole_blood_high_shear_relative_index");
    assert.equal(byId.get("feedback-middle-relative")?.canonicalKey, "hemorheology_whole_blood_middle_shear_relative_index");
    assert.equal(byId.get("feedback-electrophoresis")?.canonicalKey, "hemorheology_erythrocyte_electrophoresis_index");
    for (const id of ["feedback-shear-rate", "feedback-summary", "feedback-device-code"]) {
      assert.equal(byId.get(id)?.matchedBy, "observation_noise_filter");
    }
    assert.equal(byId.get("feedback-ambiguous-abi")?.canonicalKey, null);

    db.prepare("INSERT OR IGNORE INTO member_permissions(member_id,user_id,permission,granted_by) SELECT id,?,'manager',? FROM health_members WHERE created_by=?").run(admin.id,admin.id,admin.id);
    const issueNames = new Set(listIndicatorNormalizationIssues(admin).map((issue) => issue.rawName));
    assert.equal(issueNames.has("切变率(1/S)50.00"), false);
    assert.equal(issueNames.has("小结"), false);
    assert.equal(issueNames.has("UTN"), false);
    assert.equal(issueNames.has("AB11.01"), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("tolerates OCR noise in scientific-notation and lookalike units", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-unit-ocr-noise-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('unit-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('unit-member', '本人', 'self', 'unit-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('unit-report', 'unit-member', 'unit-user', 'laboratory', '检验报告', 'ready', '2026-08-01');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, attempts, pipeline_version, deduplication_key, finished_at
      ) VALUES ('unit-ai-job', 'unit-report', 'ai_extract', 'completed', 1, 'test', 'unit-ai-job', CURRENT_TIMESTAMP);
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json
      ) VALUES (
        'unit-extraction', 'unit-report', 'unit-ai-job', 'test', 'test', 'test',
        '{}', '{}', '{}', '{}'
      );
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, evidence_json
      ) VALUES
      ('unit-obs-plt', 'unit-report', '血常规', '血小板计数', '血小板计数', '357',
        357, '×109/L', '[{"pageNumber":1,"quote":"血小板计数 357 ×109/L"}]'),
      ('unit-obs-neut', 'unit-report', '血常规', '中性粒细胞计数', '中性粒细胞计数', '7.19',
        7.19, '×10°9/L', '[{"pageNumber":1,"quote":"中性粒细胞计数 7.19 ×10°9/L"}]'),
      ('unit-obs-cr', 'unit-report', '肾功能', '肌酐', '肌酐', '78.5',
        78.5, 'umo1/L', '[{"pageNumber":1,"quote":"肌酐 78.5 umo1/L"}]'),
      ('unit-obs-tg', 'unit-report', '血脂', '甘油三酯', '甘油三酯', '1.89',
        1.89, 'mmolL', '[{"pageNumber":1,"quote":"甘油三酯 1.89 mmolL"}]'),
      ('unit-obs-mcv', 'unit-report', '血常规', '平均红细胞体积', '平均红细胞体积', '82',
        82, 'f1', '[{"pageNumber":1,"quote":"平均红细胞体积 82 f1"}]'),
      ('unit-obs-mch', 'unit-report', '血常规', '平均红细胞血红蛋白量', '平均红细胞血红蛋白量', '29.5',
        29.5, 'p9', '[{"pageNumber":1,"quote":"平均红细胞血红蛋白量 29.5 p9"}]');
    `);

    normalizeReportObservations("unit-report");
    const rows = db.prepare(`
      SELECT observation_id AS id, canonical_key AS canonicalKey, quality,
        canonical_unit AS canonicalUnit, excluded_reason AS excludedReason
      FROM observation_normalizations
    `).all() as Array<{
      id: string; canonicalKey: string | null; quality: string;
      canonicalUnit: string | null; excludedReason: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    /* ×109/L、×10°9/L 是 10^9/L 的 OCR 噪声形态，umo1/L 是 μmol/L 的形近字误读 */
    assert.equal(byId.get("unit-obs-plt")?.canonicalKey, "cbc_plt");
    assert.equal(byId.get("unit-obs-plt")?.quality, "high");
    assert.equal(byId.get("unit-obs-plt")?.canonicalUnit, "10^9/L");
    assert.equal(byId.get("unit-obs-neut")?.canonicalKey, "cbc_neutrophil_count");
    assert.equal(byId.get("unit-obs-neut")?.quality, "high");
    assert.equal(byId.get("unit-obs-cr")?.canonicalKey, "renal_creatinine");
    assert.equal(byId.get("unit-obs-cr")?.quality, "high");
    assert.equal(byId.get("unit-obs-cr")?.canonicalUnit, "μmol/L");
    /* mmolL 是 mmol/L 丢斜杠的 OCR 噪声形态 */
    assert.equal(byId.get("unit-obs-tg")?.canonicalKey, "lipid_tg");
    assert.equal(byId.get("unit-obs-tg")?.quality, "high");
    assert.equal(byId.get("unit-obs-tg")?.canonicalUnit, "mmol/L");
    /* f1 是 fL 的形近误读（数字 1 代替字母 l） */
    assert.equal(byId.get("unit-obs-mcv")?.canonicalKey, "cbc_mcv");
    assert.equal(byId.get("unit-obs-mcv")?.quality, "high");
    assert.equal(byId.get("unit-obs-mcv")?.canonicalUnit, "fL");
    /* p9 是 pg 的形近误读（数字 9 代替字母 g） */
    assert.equal(byId.get("unit-obs-mch")?.canonicalKey, "cbc_mch");
    assert.equal(byId.get("unit-obs-mch")?.quality, "high");
    assert.equal(byId.get("unit-obs-mch")?.canonicalUnit, "pg");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("ai suggestion duplicates of builtin indicators do not trigger ambiguity gate", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-dup-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('dup-user', '用户');
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('dup-member', '本人', 'self', 'dup-user');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('dup-report', 'dup-member', 'dup-user', 'laboratory', '检验报告', 'ready', '2026-08-01');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, attempts, pipeline_version, deduplication_key, finished_at
      ) VALUES ('dup-ai-job', 'dup-report', 'ai_extract', 'completed', 1, 'test', 'dup-ai-job', CURRENT_TIMESTAMP);
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json
      ) VALUES (
        'dup-extraction', 'dup-report', 'dup-ai-job', 'test', 'test', 'test',
        '{}', '{}', '{}', '{}'
      );
      INSERT INTO indicator_catalog (
        id, canonical_key, display_name, category, value_type, trend_enabled, source, ai_managed
      ) VALUES ('ai-dup-sg', 'ai:numeric:尿比重', '尿比重', '尿常规', 'numeric', 1, 'user', 1);
      INSERT INTO indicator_aliases (
        id, indicator_id, alias_name, normalized_alias, scope, source, confidence, enabled
      ) VALUES ('ai-dup-sg-alias', 'ai-dup-sg', '尿比重', '尿比重', 'global', 'ai_suggestion', 1, 1);
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, evidence_json
      ) VALUES (
        'dup-obs-sg', 'dup-report', '三大常规', '尿比重', '尿比重', '1.018',
        1.018, NULL, '[{"pageNumber":1,"quote":"尿比重 1.018"}]'
      );
    `);

    normalizeReportObservations("dup-report");
    const row = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, excluded_reason AS excludedReason
      FROM observation_normalizations WHERE observation_id = 'dup-obs-sg'
    `).get() as { canonicalKey: string | null; quality: string; excludedReason: string | null };
    /* AI 建议条目与内置「尿比重」同名，只保留内置候选，不再触发多义守门 */
    assert.equal(row.canonicalKey, "urine_specific_gravity");
    assert.notEqual(row.quality, "low");
    assert.notEqual(row.quality, "excluded");
    assert.equal(row.excludedReason, null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
