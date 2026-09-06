import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { updateRemoteIndicatorDictionary } from "../services/indicator-dictionary.service.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";
import { buildProcessingJobDiagnostics } from "../services/processing-job-diagnostics.service.ts";
import { listTrendSeries } from "../services/records.service.ts";

type GoldenObservation = {
  id: string;
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
};

const observations = JSON.parse(readFileSync(
  new URL("./fixtures/p0-latest-report-observations.json", import.meta.url),
  "utf8"
)) as GoldenObservation[];

const processingDiagnosticsGolden = JSON.parse(readFileSync(
  new URL("./fixtures/p3-processing-diagnostics-golden.json", import.meta.url),
  "utf8"
)) as {
  archivedReport: {
    persistedObservations: number;
    trendReadyObservations: number;
    trendSeries: number;
  };
};

const remoteTaxonomyBytes = readFileSync(
  new URL("../../../dictionary/remote/taxonomy.json", import.meta.url)
);
const remoteIndicatorBytes = readFileSync(
  new URL("../../../dictionary/remote/indicators.json", import.meta.url)
);
const remoteRevision = (JSON.parse(remoteIndicatorBytes.toString("utf8")) as { revision: number }).revision;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const remoteManifest = {
  formatVersion: 1,
  revision: remoteRevision,
  generatedAt: "2026-08-04T00:00:00.000Z",
  files: {
    taxonomy: {
      path: "taxonomy.json",
      sha256: sha256(remoteTaxonomyBytes),
      bytes: remoteTaxonomyBytes.byteLength
    },
    indicators: {
      path: "indicators.json",
      sha256: sha256(remoteIndicatorBytes),
      bytes: remoteIndicatorBytes.byteLength
    }
  },
  signature: null
};

function bundledRemoteDictionaryFetch(input: string | URL | Request) {
  const requestUrl = typeof input === "string"
    ? input
    : input instanceof URL ? input.toString() : input.url;
  const pathname = new URL(requestUrl).pathname;
  if (pathname.endsWith("/manifest.json")) {
    return Promise.resolve(new Response(JSON.stringify(remoteManifest), { status: 200 }));
  }
  if (pathname.endsWith("/taxonomy.json")) {
    return Promise.resolve(new Response(remoteTaxonomyBytes, { status: 200 }));
  }
  if (pathname.endsWith("/indicators.json")) {
    return Promise.resolve(new Response(remoteIndicatorBytes, { status: 200 }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

const user: RequestUser = {
  id: "p0-golden-user",
  displayName: "回归用户",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

test("keeps the anonymized uploaded report stable under the P0 trend gate", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p0-golden-"));
  const originalFetch = globalThis.fetch;
  process.env.STORAGE_DIR = storageDir;
  process.env.INDICATOR_DICTIONARY_URL = "https://p0-golden.dictionary/";
  globalThis.fetch = bundledRemoteDictionaryFetch as typeof fetch;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(user.id, user.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('p0-golden-member', '匿名成员', 'self', ?)
    `).run(user.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('p0-golden-member', ?, 'manager', ?)
    `).run(user.id, user.id);
    db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('p0-golden-report', 'p0-golden-member', ?, 'checkup', '匿名金标体检报告', 'ready', '2025-07-14 15:20:00')
    `).run(user.id);

    const installedRemote = await updateRemoteIndicatorDictionary(user);
    assert.equal(installedRemote.revision, remoteRevision);

    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_code, item_name, normalized_name,
        result_text, numeric_value, unit, reference_low, reference_high,
        reference_text, abnormal_flag
      ) VALUES (?, 'p0-golden-report', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of observations) {
      insert.run(
        item.id,
        item.sectionName,
        item.itemCode,
        item.itemName,
        item.normalizedName,
        item.resultText,
        item.numericValue,
        item.unit,
        item.referenceLow,
        item.referenceHigh,
        item.referenceText,
        item.abnormalFlag
      );
    }

    const normalized = normalizeReportObservations("p0-golden-report");
    assert.deepEqual(normalized, {
      scanned: 162,
      normalized: 126,
      high: 94,
      medium: 32,
      // r17 字典新增 TORCH 10 项定性指标：从未匹配(low/unknown)转为已匹配的状态型排除
      low: 10,
      excluded: 26,
      unknown: 10
    });

    const trends = listTrendSeries(user, "p0-golden-member") as Array<{
      indicatorKey: string;
      quality: string;
      unit: string | null;
      pointCount: number;
      sectionName: string | null;
      excludedPoints: Array<{ itemName: string }>;
      points: Array<{
        reportId: string;
        numericValue: number;
        itemName: string;
        abnormalStatus: string;
        displayAbnormalFlag: string | null;
      }>;
    }>;
    assert.equal(trends.length, 121);
    assert.equal(trends.reduce((sum, series) => sum + series.pointCount, 0), 121);
    assert.equal(trends.some((series) => series.quality === "raw"), false);
    assert.equal(trends.some((series) => series.points.filter((point) => point.reportId === "p0-golden-report").length > 1), false);

    db.exec(`
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key, finished_at
      ) VALUES (
        'p0-golden-ai-job', 'p0-golden-report', 'ai_extract', 'completed',
        'golden-regression-v1', 'p0-golden-report:ai_extract:golden', CURRENT_TIMESTAMP
      );
    `);
    db.prepare(`
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json, input_characters
      ) VALUES (
        'p0-golden-extraction', 'p0-golden-report', 'p0-golden-ai-job',
        'offline-golden', 'offline-golden', 'offline-golden-v1', ?, '{}', '{}', ?, 0
      )
    `).run(JSON.stringify({ observations }), JSON.stringify({ observations }));
    const diagnostics = buildProcessingJobDiagnostics({
      id: "p0-golden-ai-job",
      reportId: "p0-golden-report",
      jobType: "ai_extract",
      status: "completed",
      errorCode: null,
      errorMessage: null
    }, []);
    assert.equal(
      diagnostics.metrics.persistedObservationCount,
      processingDiagnosticsGolden.archivedReport.persistedObservations
    );
    assert.equal(
      diagnostics.metrics.trendReadyObservationCount,
      processingDiagnosticsGolden.archivedReport.trendReadyObservations
    );
    assert.equal(
      diagnostics.metrics.trendSeriesCount,
      processingDiagnosticsGolden.archivedReport.trendSeries
    );

    const byKey = new Map(trends.map((series) => [series.indicatorKey, series]));
    assert.deepEqual(byKey.get("body_height")?.points.map((point) => point.numericValue), [175]);
    assert.equal(byKey.get("body_height")?.excludedPoints.filter((point) => /\/HT$/i.test(point.itemName)).length, 0);
    assert.equal(byKey.get("pulmonary_vc")?.pointCount, 1);
    assert.deepEqual(byKey.get("body_weight")?.points.map((point) => point.numericValue), [76.1]);
    assert.deepEqual(byKey.get("body_bmi")?.points.map((point) => point.numericValue), [24.8]);
    assert.equal(byKey.get("body_bmi")?.sectionName, "一般检查");
    assert.match(byKey.get("body_bmi")?.points[0]?.itemName || "", /体重指数.*BMI/i);
    const bodyCompositionExpected = new Map([
      ["body_fat_mass", 17.2],
      ["body_fat_percentage", 22.7],
      ["body_muscle_mass", 55.5],
      ["body_fat_free_mass", 58.6],
      ["body_total_water", 42.9],
      ["body_basal_metabolic_rate", 1623],
    ]);
    for (const [indicatorKey, expectedValue] of bodyCompositionExpected) {
      assert.deepEqual(
        byKey.get(indicatorKey)?.points.map((point) => point.numericValue),
        [expectedValue],
        `${indicatorKey} 必须形成唯一人体成分趋势点`,
      );
    }
    assert.deepEqual(byKey.get("cbc_hct")?.points.map((point) => point.numericValue), [50.4]);
    assert.equal(byKey.get("cbc_hct")?.sectionName, null);
    assert.deepEqual(byKey.get("qus_bone_t_score")?.points.map((point) => point.numericValue), [-1.9]);
    assert.deepEqual(byKey.get("qus_bone_z_score")?.points.map((point) => point.numericValue), [-1.7]);
    assert.equal(byKey.get("qus_bone_t_score")?.sectionName, "超声骨密度检测报告");
    assert.equal(byKey.get("qus_bone_z_score")?.sectionName, "超声骨密度检测报告");
    assert.deepEqual(
      [
        byKey.get("qus_bone_t_score")?.points[0]?.abnormalStatus,
        byKey.get("qus_bone_z_score")?.points[0]?.abnormalStatus,
      ],
      // 报告无参考范围：T 值按字典 WHO 标准（low=-1）判为计算型偏低；Z 值 -1.7 未低于字典下限 -2，不判异常
      ["computed", "unresolved"],
    );
    assert.deepEqual(
      [
        byKey.get("qus_bone_t_score")?.points[0]?.displayAbnormalFlag,
        byKey.get("qus_bone_z_score")?.points[0]?.displayAbnormalFlag,
      ],
      ["low", null],
    );
    assert.deepEqual(
      ["liver_alp", "liver_tbil", "renal_cystatin_c"].map((key) => byKey.get(key)?.pointCount),
      [1, 1, 1]
    );
    assert.deepEqual(
      [
        "laboratory_ldh",
        "laboratory_ck",
        "laboratory_ck_mb",
        "laboratory_amylase",
        "ophthalmology_intraocular_pressure_right",
        "ophthalmology_intraocular_pressure_left",
        "laboratory_testosterone",
        "laboratory_prolactin",
        "laboratory_pepsinogen_i",
        "laboratory_pepsinogen_ii",
        "laboratory_pepsinogen_ratio"
      ].map((key) => byKey.get(key)?.pointCount),
      Array(11).fill(1)
    );
    assert.deepEqual(
      [
        "hemorheology_whole_blood_viscosity_high_shear",
        "hemorheology_whole_blood_viscosity_middle_shear_50",
        "hemorheology_whole_blood_viscosity_low_shear_5",
        "hemorheology_whole_blood_viscosity_low_shear",
        "hemorheology_whole_blood_high_shear_reduced_viscosity",
        "hemorheology_whole_blood_low_shear_reduced_viscosity",
        "hemorheology_plasma_viscosity",
        "laboratory_esr",
        "hemorheology_whole_blood_high_shear_relative_index",
        "hemorheology_whole_blood_low_shear_relative_index",
        "hemorheology_esr_equation_k_value",
        "hemorheology_erythrocyte_aggregation_index",
        "hemorheology_erythrocyte_deformability_index_tk",
        "hemorheology_erythrocyte_rigidity_index"
      ].map((key) => byKey.get(key)?.pointCount),
      Array(14).fill(1)
    );
    assert.equal(byKey.get("laboratory_esr")?.unit, "mm/h");
    assert.equal(byKey.get("hemorheology_esr_equation_k_value")?.unit, null);
    assert.equal(byKey.get("hemorheology_whole_blood_high_shear_reduced_viscosity")?.unit, "mPa·s");
    assert.equal(byKey.get("hemorheology_erythrocyte_rigidity_index")?.unit, null);
    const tcdExpectedUnits = new Map([
      ["tcd_right_middle_cerebral_artery_mean_flow_velocity", "cm/s"],
      ["tcd_right_middle_cerebral_artery_pulsatility_index", null],
      ["tcd_left_middle_cerebral_artery_mean_flow_velocity", "cm/s"],
      ["tcd_left_middle_cerebral_artery_pulsatility_index", null],
      ["tcd_right_vertebral_artery_mean_flow_velocity", "cm/s"],
      ["tcd_right_vertebral_artery_pulsatility_index", null],
      ["tcd_left_vertebral_artery_mean_flow_velocity", "cm/s"],
      ["tcd_left_vertebral_artery_pulsatility_index", null],
      ["tcd_basilar_artery_mean_flow_velocity", "cm/s"],
      ["tcd_basilar_artery_pulsatility_index", null],
    ]);
    for (const [canonicalKey, canonicalUnit] of tcdExpectedUnits) {
      assert.equal(byKey.get(canonicalKey)?.pointCount, 1, canonicalKey);
      assert.equal(byKey.get(canonicalKey)?.unit, canonicalUnit, canonicalKey);
    }

    const tcdNormalizations = db.prepare(`
      SELECT o.item_name AS itemName, n.canonical_key AS canonicalKey,
             n.canonical_unit AS canonicalUnit, n.quality AS quality
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND o.section_name = '超声经颅多普勒报告单'
      ORDER BY o.id
    `).all() as Array<{
      itemName: string;
      canonicalKey: string | null;
      canonicalUnit: string | null;
      quality: string;
    }>;
    assert.equal(tcdNormalizations.length, 10);
    assert.deepEqual(
      tcdNormalizations.map((row) => row.canonicalKey),
      [...tcdExpectedUnits.keys()],
    );
    assert.deepEqual(
      tcdNormalizations.map((row) => row.canonicalUnit),
      [...tcdExpectedUnits.values()],
    );
    assert.deepEqual(
      tcdNormalizations.map((row) => row.quality),
      Array(10).fill("medium"),
      "原始 TCD 单位缺失时应使用字典默认单位并保留 medium 质量，不伪装为原报告高质量单位",
    );
    assert.equal(
      tcdNormalizations.some((row) => /(?:Vp|Vd|RI|S\/D|HR|深度)$/i.test(row.itemName)),
      false,
      "设备辅助列不得进入 TCD 趋势观察值",
    );
    const dobTrend = byKey.get(
      "infectious_h_pylori_13c_urea_breath_test_dob",
    );
    assert.equal(dobTrend?.pointCount, 1);
    assert.equal(dobTrend?.unit, "‰");
    assert.deepEqual(
      dobTrend?.points.map((point) => point.numericValue),
      [0.5],
    );
    assert.equal(
      byKey.has("infectious_h_pylori_13c_urea_breath_test_result"),
      false,
      "呼气试验定性结论不得生成数值趋势",
    );

    const ecgExpectedUnits = new Map([
      ["ecg_qt_interval", "ms"],
      ["ecg_p_axis", "°"],
      ["ecg_qrs_axis", "°"],
      ["ecg_t_axis", "°"],
      ["ecg_rv5_amplitude", "mV"],
      ["ecg_sv1_amplitude", "mV"],
    ]);
    for (const [canonicalKey, canonicalUnit] of ecgExpectedUnits) {
      assert.equal(byKey.get(canonicalKey)?.pointCount, 1, canonicalKey);
      assert.equal(byKey.get(canonicalKey)?.unit, canonicalUnit, canonicalKey);
    }
    assert.notEqual(
      byKey.get("ecg_qt_interval")?.indicatorKey,
      byKey.get("ecg_qtc_interval")?.indicatorKey,
      "QT 与 QTc 必须保持独立趋势",
    );
    assert.notEqual(
      byKey.get("ecg_qrs_axis")?.indicatorKey,
      byKey.get("ecg_qrs_duration")?.indicatorKey,
      "QRS 电轴与 QRS 时限必须保持独立趋势",
    );

    const ecgCanonicalUnits = db.prepare(`
      SELECT o.item_name AS itemName, n.canonical_unit AS canonicalUnit
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND o.item_name IN ('QT间期', 'P电轴', 'QRS电轴', 'T电轴', 'RV5', 'SV1')
      ORDER BY o.item_name
    `).all() as Array<{ itemName: string; canonicalUnit: string | null }>;
    assert.deepEqual(
      Object.fromEntries(ecgCanonicalUnits.map((row) => [row.itemName, row.canonicalUnit])),
      {
        "P电轴": "°",
        "QRS电轴": "°",
        "QT间期": "ms",
        "RV5": "mV",
        "SV1": "mV",
        "T电轴": "°",
      },
    );

    assert.notEqual(
      byKey.get("ophthalmology_intraocular_pressure_right")?.indicatorKey,
      byKey.get("ophthalmology_intraocular_pressure_left")?.indicatorKey
    );

    const compositeHeight = db.prepare(`
      SELECT COUNT(*) AS count
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND o.item_name LIKE '%/HT'
        AND n.canonical_key IS NULL
        AND n.quality = 'excluded'
        AND n.matched_by = 'functional_device_filter'
    `).get() as { count: number };
    assert.equal(compositeHeight.count, 5);

    const aiFallbackTrendLeaks = db.prepare(`
      SELECT COUNT(*) AS count
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND n.quality IN ('high', 'medium')
        AND n.source_origin = 'ai_normalized_name'
    `).get() as { count: number };
    assert.equal(aiFallbackTrendLeaks.count, 0);

    const deviceFilterGovernanceLeaks = db.prepare(`
      SELECT COUNT(*) AS count
      FROM indicator_unmatched_occurrences occurrence
      JOIN observation_normalizations n ON n.observation_id = occurrence.observation_id
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND n.matched_by = 'functional_device_filter'
    `).get() as { count: number };
    assert.equal(deviceFilterGovernanceLeaks.count, 0);

    const invalidGovernanceMetadata = db.prepare(`
      SELECT COUNT(*) AS count
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND (
          n.source_origin NOT IN (
            'item_name', 'item_code', 'combined', 'ai_normalized_name', 'none',
            'manual_confirmation', 'manual_exclusion', 'legacy'
          )
          OR n.review_status NOT IN ('unreviewed', 'confirmed', 'excluded')
          OR (n.alias_source IS NOT NULL AND n.alias_source NOT IN ('builtin', 'user', 'ai_suggestion'))
          OR (n.source_origin <> 'none' AND n.source_name IS NULL)
        )
    `).get() as { count: number };
    assert.equal(invalidGovernanceMetadata.count, 0);

    const reviewedGoldRows = db.prepare(`
      SELECT COUNT(*) AS count
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report' AND n.review_status <> 'unreviewed'
    `).get() as { count: number };
    assert.equal(reviewedGoldRows.count, 0);

    const breathTestNormalizations = db.prepare(`
      SELECT o.item_name AS itemName, n.canonical_key AS canonicalKey,
             n.canonical_unit AS canonicalUnit, n.quality AS quality
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND o.id IN ('gold-072', 'gold-149')
      ORDER BY o.id
    `).all() as Array<{
      itemName: string;
      canonicalKey: string | null;
      canonicalUnit: string | null;
      quality: string;
    }>;
    assert.deepEqual(
      breathTestNormalizations.map((row) => [
        row.itemName,
        row.canonicalKey,
        row.canonicalUnit,
        row.quality,
      ]),
      [
        [
          "DOB值",
          "infectious_h_pylori_13c_urea_breath_test_dob",
          "‰",
          "medium",
        ],
        [
          "13C呼气试验Hp检验报告",
          "infectious_h_pylori_13c_urea_breath_test_result",
          null,
          "excluded",
        ],
      ],
    );

    const normalizedUnits = db.prepare(`
      SELECT DISTINCT n.canonical_unit AS unit
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      WHERE o.report_id = 'p0-golden-report' AND LOWER(o.unit) = 'u/ml'
    `).all() as Array<{ unit: string | null }>;
    assert.equal(normalizedUnits.some((row) => row.unit === "U/mL"), true);

    const governance = db.prepare(`
      SELECT COUNT(*) AS count
      FROM indicator_unmatched_occurrences occurrence
      JOIN observations o ON o.id = occurrence.observation_id
      WHERE o.report_id = 'p0-golden-report'
    `).get() as { count: number };
    assert.equal(governance.count, 11);
    const designGatedInPool = db.prepare(`
      SELECT COUNT(*) AS count
      FROM indicator_unmatched_occurrences occurrence
      JOIN observations o ON o.id = occurrence.observation_id
      LEFT JOIN observation_normalizations n ON n.observation_id = occurrence.observation_id
      WHERE o.report_id = 'p0-golden-report'
        AND COALESCE(n.excluded_reason, '') LIKE '%不默认进入折线趋势%'
    `).get() as { count: number };
    assert.equal(designGatedInPool.count, 0, "按字典定义不进入折线趋势的定性结果不应留在治理池");
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.INDICATOR_DICTIONARY_URL;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
