import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  builtinIndicators,
  builtinIndicatorVersion
} from "../domain/indicator-dictionary/builtin-indicators.ts";
import { trendPlacementFor } from "../domain/indicator-dictionary/trend-taxonomy.ts";

const rootDir = resolve(new URL("../../..", import.meta.url).pathname);

test("loads the builtin runtime catalog from the validated core JSON snapshot", () => {
  const document = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/core/indicators.json"), "utf8")
  ) as {
    revision: number;
    indicators: Array<{
      canonicalKey: string;
    }>;
  };

  assert.equal(builtinIndicatorVersion, `core-r${document.revision}`);
  assert.equal(builtinIndicators.length, document.indicators.length);
  for (const [canonicalKey, alias] of [
    ["liver_alp", "血清碱性磷酸酶"],
    ["liver_tbil", "血清总胆红素"],
    ["renal_cystatin_c", "血清胱抑素C测定"]
  ] as const) {
    assert.equal(
      builtinIndicators.find((indicator) => indicator.canonicalKey === canonicalKey)?.aliases.includes(alias),
      true,
      `missing confirmed core alias for ${canonicalKey}`
    );
  }
  assert.deepEqual(
    builtinIndicators.map((indicator) => indicator.canonicalKey),
    document.indicators.map((indicator) => indicator.canonicalKey)
  );
  const keys = new Set(builtinIndicators.map((indicator) => indicator.canonicalKey));
  for (const key of [
    "vital_systolic_bp",
    "cbc_hct",
    "urine_specific_gravity",
    "urine_protein_quantitative",
    "liver_albumin",
    "renal_egfr",
    "glucose_postprandial_2h",
    "electrolyte_chloride",
    "vascular_abi_right",
    "vascular_abi_left",
    "vascular_bapwv_right",
    "vascular_bapwv_left",
    "pulmonary_vc",
    "pulmonary_ic",
    "pulmonary_tv",
    "pulmonary_irv",
    "pulmonary_erv",
    "pulmonary_fvc",
    "pulmonary_fev1",
    "pulmonary_fev1_fvc_ratio",
    "pulmonary_fev1_vc_ratio",
    "pulmonary_pef",
    "pulmonary_fef25",
    "pulmonary_fef50",
    "pulmonary_fef75",
    "pulmonary_mmef",
    "laboratory_ldh",
    "laboratory_ck",
    "laboratory_ck_mb",
    "laboratory_amylase",
    "ophthalmology_intraocular_pressure_right",
    "ophthalmology_intraocular_pressure_left"
  ]) {
    assert.equal(keys.has(key), true, `missing common builtin indicator ${key}`);
  }
});

test("publishes confirmed specialty aliases through the remote dictionary", () => {
  const indicators = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8")
  ) as {
    revision: number;
    indicators: Array<{ canonicalKey: string; aliases: string[]; allowedUnits?: string[] }>;
  };
  const taxonomy = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/remote/taxonomy.json"), "utf8")
  ) as { revision: number };
  const keys = new Set(indicators.indicators.map((indicator) => indicator.canonicalKey));
  for (const key of [
    "tumor_afp",
    "tumor_cea",
    "tumor_ca19_9",
    "tumor_ca15_3",
    "tumor_ca242",
    "tumor_ca50",
    "tumor_nse",
    "tumor_ca72_4",
    "tumor_cyfra21_1",
    "thyroid_tpo_antibody",
    "thyroid_thyroglobulin_antibody",
    "thyroid_tsh_receptor_antibody",
    /* 自 core 迁入 remote 的专科/低频指标 */
    "tumor_psa_total",
    "tumor_psa_free",
    "tumor_psa_free_total_ratio",
    "laboratory_testosterone",
    "laboratory_prolactin",
    "laboratory_pepsinogen_i",
    "laboratory_pepsinogen_ii",
    "laboratory_pepsinogen_ratio",
    "infectious_hbv_dna",
    "infectious_hiv_agab",
    "infectious_syphilis_antibody",
    "infectious_rubella_igg",
    "infectious_hsv2_igm",
    "hemorheology_plasma_viscosity",
    "hemorheology_erythrocyte_deformability_index_tk",
    "tcd_basilar_artery_mean_flow_velocity",
    "tcd_basilar_artery_pulsatility_index",
    "gyn_endometrium_thickness",
    "inflammation_full_range_crp",
    "cardiac_nt_probnp",
    "coagulation_aptt",
    "coagulation_pt",
    "coagulation_inr",
    "coagulation_tt",
    "coagulation_fibrinogen"
  ]) {
    assert.equal(keys.has(key), true, `missing remote indicator ${key}`);
  }
  const tpo = indicators.indicators.find((item) => item.canonicalKey === "thyroid_tpo_antibody");
  assert.ok(tpo?.aliases.includes("抗甲状腺过氧化物酶抗体"));
  assert.ok(tpo?.aliases.includes("Anti-thyroid peroxidase antibody"));
  assert.ok(tpo?.aliases.includes("TPOAb"));
  const testosterone = indicators.indicators.find((item) => item.canonicalKey === "laboratory_testosterone");
  const prolactin = indicators.indicators.find((item) => item.canonicalKey === "laboratory_prolactin");
  const pepsinogenRatio = indicators.indicators.find((item) => item.canonicalKey === "laboratory_pepsinogen_ratio");
  assert.deepEqual(testosterone?.allowedUnits, ["ng/mL", "ng/dL", "μg/L"]);
  assert.equal(testosterone?.aliases.includes("TTE"), false, "ambiguous cardiac abbreviation must not be global");
  assert.deepEqual(prolactin?.allowedUnits, ["ng/mL", "μg/L"]);
  assert.equal(pepsinogenRatio?.aliases.includes("PGR"), false, "pathology PGR must not map to a gastric ratio");
  assert.equal(indicators.revision, taxonomy.revision);
});

test("covers reviewed collection names without merging counts, ratios or ambiguous abbreviations", () => {
  const core = JSON.parse(readFileSync(resolve(rootDir, "dictionary/core/indicators.json"), "utf8"));
  const remote = JSON.parse(readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8"));
  const rows = [...core.indicators, ...remote.indicators];
  const keysFor = (name: string) => new Set([
    ...rows.filter((row) => row.displayName === name || row.aliases.includes(name)),
    ...remote.extensions.filter((row: { aliases: string[] }) => row.aliases.includes(name))
  ].map((row) => row.canonicalKey));
  for (const [name, key] of [
    ["有核红细胞比率", "cbc_nucleated_rbc_percentage"],
    ["红细胞平均体积", "cbc_mcv"],
    ["有核红细胞计数", "cbc_nucleated_rbc_count"],
    ["甘胆酸", "laboratory_cholic_acid"],
    ["血氨", "laboratory_ammonia"],
    ["异常凝血酶原", "tumor_des_gamma_carboxy_prothrombin"],
    ["降钙素原", "inflammation_procalcitonin"]
  ]) assert.deepEqual([...keysFor(name)], [key], name);
  const dcp = rows.find((row) => row.canonicalKey === "tumor_des_gamma_carboxy_prothrombin");
  assert.deepEqual(dcp.allowedUnits, ["mAU/mL"], "do not treat mass units as arbitrary assay units");
  const procalcitonin = rows.find((row) => row.canonicalKey === "inflammation_procalcitonin");
  assert.deepEqual(procalcitonin.allowedUnits, ["ng/mL", "μg/L"]);
  assert.equal(keysFor("PCT").has(procalcitonin.canonicalKey), false);
  assert.equal(keysFor("降钙素").has(procalcitonin.canonicalKey), false);
});

test("keeps postprandial timing and unconverted unit boundaries in remote additions", () => {
  const remote = JSON.parse(readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8"));
  for (const [key, name, forbidden, units] of [
    ["lipid_non_hdl_c", "非高密度脂蛋白胆固醇", ["HDL-C", "LDL-C"], ["mmol/L", "mg/dL"]],
    ["c_peptide_postprandial_2h", "C肽餐后2小时", ["C肽", "空腹C肽", "餐后1小时C肽"], ["ng/mL", "μg/L", "nmol/L", "pmol/L"]],
    ["insulin_postprandial_2h", "胰岛素餐后2小时", ["胰岛素", "INS", "空腹胰岛素", "餐后1小时胰岛素"], ["μIU/mL", "mIU/L", "pmol/L"]]
  ] as const) {
    const row = remote.indicators.find((item: { canonicalKey: string }) => item.canonicalKey === key);
    assert.ok(row.aliases.includes(name));
    assert.equal(row.kind, "quantitative");
    assert.equal(row.defaultUnit, null, "older clients must preserve raw units rather than relabel unconverted values");
    assert.deepEqual(row.allowedUnits, [...units]);
    for (const alias of forbidden) assert.equal(row.aliases.includes(alias), false, alias);
  }
});

test("adds explicit echo and lipid measurements without widening ambiguous aliases", () => {
  const remote = JSON.parse(readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8"));
  const byKey = (key: string) => remote.indicators.find((row: { canonicalKey: string }) => row.canonicalKey === key);
  const ratio = byKey("lipid_ldl_hdl_ratio");
  assert.ok(ratio.aliases.includes("低密度脂蛋白/高密度脂蛋白比值"));
  assert.equal(ratio.unitDimension, "ratio");
  assert.equal(ratio.defaultUnit, null);
  for (const name of ["LDL-C", "HDL-C", "TC/HDL-C", "动脉硬化指数"]) {
    assert.equal(ratio.aliases.includes(name), false);
  }
  const diameter = byKey("cardiac_lvidd");
  assert.ok(diameter.aliases.includes("舒张期左室前后径"));
  assert.equal(diameter.defaultUnit, "mm");
  assert.deepEqual(diameter.allowedUnits, ["mm", "cm"]);
  for (const name of ["LVIDs", "左室收缩末期内径", "左室后壁厚", "FS"]) {
    assert.equal(diameter.aliases.includes(name), false);
  }
  assert.ok(byKey("urine_color").aliases.includes("尿颜色"));
  assert.equal(byKey("urine_color").kind, "categorical");
  assert.ok(byKey("cardiac_lvef").aliases.includes("EF"));
});

test("covers explicit quantitative, thyroid and side-specific collection aliases", () => {
  const core = JSON.parse(readFileSync(resolve(rootDir, "dictionary/core/indicators.json"), "utf8"));
  const remote = JSON.parse(readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8"));
  const rows = [...core.indicators, ...remote.indicators, ...remote.extensions];
  for (const [name, key] of [
    ["甲胎蛋白测定(定量)", "tumor_afp"], ["癌胚抗原测定(定量)", "tumor_cea"],
    ["嗜酸性粒细胞百分数", "cbc_eosinophil_percentage"],
    ["嗜碱性粒细胞百分数", "cbc_basophil_percentage"],
    ["单核细胞百分数", "cbc_monocyte_percentage"],
    ["血清游离三碘甲状原氨酸", "thyroid_ft3"], ["血清游离甲状腺素", "thyroid_ft4"],
    ["血清促甲状腺激素", "thyroid_tsh"], ["血清甲状腺素", "thyroid_t4_total"],
    ["血清三碘甲状原氨酸", "thyroid_t3_total"],
    ["神经元特异烯醇化酶", "tumor_nse"], ["糖链抗原125测定", "tumor_ca125"],
    ["眼压-右眼", "ophthalmology_intraocular_pressure_right"]
  ]) {
    const keys = new Set(rows.filter((row) => row.aliases.includes(name)).map((row) => row.canonicalKey));
    assert.deepEqual([...keys], [key], name);
  }
  assert.equal(rows.some((row) => row.aliases.includes("QT/QTc")), false);
});

test("derives trend placement from the core taxonomy JSON", () => {
  assert.deepEqual(trendPlacementFor({ category: "血常规" }), {
    groupKey: "laboratory",
    groupName: "检验检查",
    groupOrder: 80,
    subgroupKey: "blood",
    subgroupName: "血常规",
    subgroupOrder: 10
  });
  assert.equal(trendPlacementFor({ sectionName: "甲功五项" }).subgroupKey, "thyroid");
  assert.equal(trendPlacementFor({ sectionName: "胸部CT检查" }).groupKey, "imaging");
  assert.equal(trendPlacementFor({ sectionName: "生化检验" }).subgroupKey, "laboratory_other");
});

test("passes schema and cross-file dictionary validation", () => {
  const output = execFileSync(process.execPath, ["scripts/dictionary/validate.mjs"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.match(output, /Dictionary validation passed/);
});

test("builds compact Pages JSON and hashes the published bytes", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "health-records-dictionary-pages-"));
  try {
    execFileSync(process.execPath, [
      "scripts/dictionary/build-pages.mjs",
      `--output=${outputDir}`
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const manifestContent = readFileSync(resolve(outputDir, "manifest.json"), "utf8");
    assert.equal(manifestContent.trim(), JSON.stringify(JSON.parse(manifestContent)));

    const manifest = JSON.parse(manifestContent) as {
      revision: number;
      files: Record<string, { path: string; sha256: string; bytes: number }>;
    };
    const sourceIndicators = JSON.parse(
      readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8")
    ) as { revision: number };
    assert.equal(manifest.revision, sourceIndicators.revision);
    for (const file of Object.values(manifest.files)) {
      const content = readFileSync(resolve(outputDir, file.path));
      assert.equal(content.byteLength, file.bytes);
      assert.equal(createHash("sha256").update(content).digest("hex"), file.sha256);
      assert.equal(content.toString("utf8").trim(), JSON.stringify(JSON.parse(content.toString("utf8"))));
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
