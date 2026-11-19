import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  checkRemoteIndicatorDictionary,
  getIndicatorDictionaryStatus,
  installRemoteDictionarySnapshotForTests,
  rollbackRemoteIndicatorDictionary,
  updateRemoteIndicatorDictionary
} from "../services/indicator-dictionary.service.ts";
import {
  activeIndicatorNormalizationVersion,
  backfillBuiltinIndicatorNormalizations,
  indicatorNameCandidates,
  listIndicatorNormalizationIssues,
  normalizeObservation,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";

test("merged thyroid and hepatitis collection names install, backfill and roll back with analyte boundaries", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "dictionary-thyroid-feedback-"));
  const previousStorage = process.env.STORAGE_DIR;
  const previousUrl = process.env.INDICATOR_DICTIONARY_URL;
  const originalFetch = globalThis.fetch;
  const current = {
    taxonomy: JSON.parse(readFileSync(new URL("../../../dictionary/remote/taxonomy.json", import.meta.url), "utf8")),
    indicators: JSON.parse(readFileSync(new URL("../../../dictionary/remote/indicators.json", import.meta.url), "utf8"))
  };
  const cases = [
    ["促甲状腺刺激激素", "mIU/L", "thyroid_tsh"],
    ["三碘甲腺原氨酸", "nmol/L", "thyroid_t3_total"],
    ["降钙素", "pg/mL", "thyroid_calcitonin"],
    ["抗促甲状腺激素受体抗体", "IU/L", "thyroid_tsh_receptor_antibody"],
    ["游离三碘甲状原氨酸", "pmol/L", "thyroid_ft3"],
    ["总三碘甲腺原氨酸", "nmol/L", "thyroid_t3_total"],
    ["甲状腺球蛋白抗原", "ng/mL", "thyroid_thyroglobulin"],
    ["抗乙型肝炎病毒核心抗体", "", "infectious_hbcab"],
    ["抗乙型肝炎病毒e抗体", "", "infectious_hbeab"],
    ["抗乙型肝炎病毒表面抗体", "", "infectious_hbsab"],
    ["乙型肝炎病毒e抗原", "", "infectious_hbeag"],
    ["乙型肝炎病毒表面抗原", "", "infectious_hbsag"]
  ] as const;
  const before = structuredClone(current);
  before.taxonomy.revision -= 1;
  before.indicators.revision -= 1;
  before.indicators.indicators = before.indicators.indicators.filter(
    (row: { canonicalKey: string }) => row.canonicalKey !== "thyroid_calcitonin"
  );
  for (const row of [...before.indicators.indicators, ...before.indicators.extensions]) {
    row.aliases = row.aliases.filter((name: string) => !cases.some(([raw]) => raw === name));
  }
  before.indicators.extensions = before.indicators.extensions.filter((row: { aliases: string[] }) => row.aliases.length > 0);
  let selected = before;
  let corrupt = false;
  process.env.STORAGE_DIR = storageDir;
  process.env.INDICATOR_DICTIONARY_URL = "https://dictionary.test/";
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://dictionary.test");
    const taxonomy = JSON.stringify(selected.taxonomy);
    const indicators = JSON.stringify(selected.indicators);
    const metadata = (path: string, value: string) => ({
      path, sha256: createHash("sha256").update(value).digest("hex"), bytes: Buffer.byteLength(value)
    });
    const manifest = {
      formatVersion: 1, revision: selected.indicators.revision,
      generatedAt: "2026-11-14T00:00:00.000Z", signature: null,
      files: { taxonomy: metadata("taxonomy.json", taxonomy), indicators: metadata("indicators.json", indicators) }
    };
    if (corrupt) manifest.files.indicators.sha256 = "0".repeat(64);
    if (url.pathname === "/manifest.json") return new Response(JSON.stringify(manifest));
    if (url.pathname === "/taxonomy.json") return new Response(taxonomy);
    if (url.pathname === "/indicators.json") return new Response(indicators);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const admin: RequestUser = {
    id: "thyroid-review-admin", displayName: "字典测试管理员", provider: "development",
    authenticated: true, isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,1)").run(admin.id, admin.displayName);
    db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('thyroid-review-member','合成成员','self',?)").run(admin.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('thyroid-review-member',?,'manager',?)").run(admin.id, admin.id);
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES('thyroid-review-report','thyroid-review-member',?,'合成检验','laboratory','ready','2026-01-01')").run(admin.id);
    for (const [index, [name, unit, key]] of cases.entries()) {
      const qualitative = key.startsWith("infectious_");
      db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,result_text,numeric_value,unit) VALUES(?,'thyroid-review-report',?,?,?,?,?)")
        .run(`thyroid-review-${index}`, qualitative ? "乙肝两对半" : "甲状腺功能", name,
          qualitative ? "阴性" : "1.25", qualitative ? null : 1.25, unit || null);
    }
    db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,result_text,unit) VALUES('legacy-isotype','thyroid-review-report','乙肝两对半','抗乙型肝炎病毒核心抗体IgM','阴性','S/CO')").run();
    // Display flags are derived by backfill; source names, values, units and evidence must stay intact.
    const rawRows = () => db.prepare(`SELECT id, report_id, section_name, item_code, item_name, normalized_name,
      result_text, numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag,
      method, evidence_json, created_at FROM observations WHERE report_id='thyroid-review-report' ORDER BY id`).all();
    const originalRows = rawRows();
    await updateRemoteIndicatorDictionary(admin);
    const baselineSnapshot = getIndicatorDictionaryStatus(admin).snapshots.find(
      (row) => row.layer === "remote" && row.revision === before.indicators.revision
    );
    assert.ok(baselineSnapshot && typeof baselineSnapshot.id === "string");
    normalizeReportObservations("thyroid-review-report");
    const issuesBefore = listIndicatorNormalizationIssues(admin);
    for (const [name] of cases) assert.ok(issuesBefore.some((issue) => issue.rawName === name), name);

    selected = current;
    const preview = await checkRemoteIndicatorDictionary(admin);
    assert.deepEqual(preview.changes.indicators, { added: 1, updated: 2, removed: 0 });
    corrupt = true;
    await assert.rejects(updateRemoteIndicatorDictionary(admin), /SHA-256/);
    corrupt = false;
    await updateRemoteIndicatorDictionary(admin);
    backfillBuiltinIndicatorNormalizations();
    for (const [index, [name, , key]] of cases.entries()) {
      const row = db.prepare("SELECT canonical_key AS canonicalKey, quality FROM observation_normalizations WHERE observation_id=?")
        .get(`thyroid-review-${index}`);
      assert.equal(row?.canonicalKey, key, name);
      assert.notEqual(row?.quality, "low", name);
    }
    assert.ok(cases.every(([name]) => !listIndicatorNormalizationIssues(admin).some((issue) => issue.rawName === name)));
    assert.deepEqual(rawRows(), originalRows, "dictionary backfill preserves original observations");

    const base = {
      id: "synthetic-boundary", reportId: "synthetic-boundary", sectionName: "甲状腺功能",
      itemCode: null, normalizedName: null, resultText: "1.25", numericValue: 1.25,
      referenceText: null, reportType: "laboratory", hospitalName: null,
      performingDepartment: null, reportingDepartment: null
    };
    for (const [itemName, unit, key] of [
      ["游离三碘甲状腺原氨酸", "pmol/L", "thyroid_ft3"],
      ["降钙素原", "ng/mL", "inflammation_procalcitonin"],
      ["甲状腺素", "nmol/L", "thyroid_t4_total"]
    ]) assert.equal(normalizeObservation({ ...base, itemName, unit }).canonicalKey, key, itemName);
    assert.notEqual(normalizeObservation({ ...base, itemName: "反三碘甲腺原氨酸", unit: "ng/mL" }).canonicalKey, "thyroid_t3_total");
    assert.notEqual(normalizeObservation({ ...base, itemName: "CT", unit: "pg/mL" }).canonicalKey, "thyroid_calcitonin");
    assert.equal(normalizeObservation({ ...base, itemName: "降钙素", unit: "ng/mL" }).quality, "low");
    assert.equal(normalizeObservation({ ...base, itemName: "甲状腺球蛋白抗体", unit: "IU/mL" }).canonicalKey, "thyroid_thyroglobulin_antibody");
    assert.equal(normalizeObservation({ ...base, itemName: "甲状腺球蛋白抗原", unit: "IU/mL" }).quality, "low");
    assert.equal(normalizeObservation({ ...base, itemName: "甲状腺TPO抗体-I", unit: "IU/mL" }).canonicalKey, null,
      "unverified assay suffix must not be stripped or registered as an alias");
    assert.equal(normalizeObservation({ ...base, itemName: "TPOAb", unit: "IU/mL" }).canonicalKey, "thyroid_tpo_antibody");
    for (const [itemName, , key] of cases.filter(([, , key]) => key.startsWith("infectious_"))) {
      const qualitative = normalizeObservation({ ...base, sectionName: "乙肝两对半", itemName,
        resultText: "阴性", numericValue: null, unit: null });
      assert.equal(qualitative.canonicalKey, key, itemName);
      assert.equal(qualitative.quality, "excluded", "qualitative serology must not become a numeric trend");
      const index = normalizeObservation({ ...base, sectionName: "乙肝两对半", itemName, unit: "S/CO" });
      assert.equal(index.canonicalKey, key, itemName);
      assert.equal(index.quality, "excluded", "assay indices must not become concentration trends");
    }
    assert.notEqual(normalizeObservation({ ...base, sectionName: "乙肝两对半", itemName: "抗乙型肝炎病毒核心抗体IgM", unit: "S/CO" }).canonicalKey,
      "infectious_hbcab", "IgM-specific antibodies remain distinct from the generic core antibody");
    const quantitativeAntigen = normalizeObservation({ ...base, sectionName: "乙肝两对半", itemName: "乙型肝炎病毒表面抗原", unit: "IU/mL" });
    assert.equal(quantitativeAntigen.quality, "excluded", "qualitative catalog entries must not admit quantitative trends");
    assert.equal(quantitativeAntigen.canonicalValue, null, "incompatible units must not produce a converted value");
    assert.equal(quantitativeAntigen.canonicalUnit, null);

    const currentVersion = activeIndicatorNormalizationVersion();
    const oldVersion = currentVersion.replace(/^indicator-normalization-p\d+/, "indicator-normalization-p14");
    assert.notEqual(oldVersion, currentVersion, "rule changes must invalidate persisted matches");
    db.prepare(`UPDATE observation_normalizations SET canonical_key='infectious_hbcab',
      indicator_id=(SELECT id FROM indicator_catalog WHERE canonical_key='infectious_hbcab'),
      canonical_name='乙型肝炎核心抗体', quality='excluded', matched_by='alias',
      alias_source='builtin', source_origin='item_name', version=? WHERE observation_id='legacy-isotype'`).run(oldVersion);
    backfillBuiltinIndicatorNormalizations();
    const repaired = db.prepare("SELECT canonical_key AS canonicalKey, version FROM observation_normalizations WHERE observation_id='legacy-isotype'").get();
    assert.equal(repaired?.canonicalKey, null, "old generic IgM matches are reviewed again without a dictionary revision change");
    assert.equal(repaired?.version, currentVersion);

    rollbackRemoteIndicatorDictionary(admin, baselineSnapshot.id);
    backfillBuiltinIndicatorNormalizations();
    for (const [name] of cases) assert.ok(listIndicatorNormalizationIssues(admin).some((issue) => issue.rawName === name), name);
    assert.deepEqual(rawRows(), originalRows, "rollback preserves original observations");
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    if (previousStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorage;
    if (previousUrl === undefined) delete process.env.INDICATOR_DICTIONARY_URL;
    else process.env.INDICATOR_DICTIONARY_URL = previousUrl;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("antibody isotypes remain part of identity across suffixes, brackets, codes and AI fallback names", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "dictionary-isotype-identity-"));
  const previousStorage = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;
  try {
    getDatabase();
    installRemoteDictionarySnapshotForTests();
    const generic = "抗乙型肝炎病毒核心抗体";
    const base = {
      id: "synthetic-isotype", reportId: "synthetic-isotype", sectionName: "乙肝两对半",
      itemCode: "HBcAb", normalizedName: "乙型肝炎核心抗体", resultText: "阴性", numericValue: null,
      unit: "S/CO", referenceText: null, reportType: "laboratory", hospitalName: null,
      performingDepartment: null, reportingDepartment: null
    };
    assert.equal(normalizeObservation({ ...base, itemName: generic }).canonicalKey, "infectious_hbcab");
    for (const isotype of ["IgM", "igm", "IgG", "IgG4"]) {
      for (const itemName of [`${generic}${isotype}`, `${generic}(${isotype})`, `${isotype}${generic}`]) {
        assert.ok(!indicatorNameCandidates(itemName).includes(generic), itemName);
        assert.ok(!indicatorNameCandidates(itemName).includes(isotype.toLowerCase()), itemName);
        assert.equal(normalizeObservation({ ...base, itemName }).canonicalKey, null, itemName);
        assert.equal(normalizeObservation({ ...base, itemName, itemCode: null, normalizedName: null,
          resultText: "1.25", numericValue: 1.25, unit: "g/L" }).canonicalKey, null,
        "a specific antibody must not become a standalone immunoglobulin through a split isotype code");
      }
    }
    assert.equal(normalizeObservation({ ...base, itemName: generic, itemCode: "HBcAb-IgM" }).canonicalKey, null);
    for (const [itemName, key] of [
      ["风疹病毒抗体(IgG)", "infectious_rubella_igg"],
      ["单纯疱疹病毒II型抗体(IgM)", "infectious_hsv2_igm"],
      ["IgM", "immunology_igm"], ["IgG", "immunology_igg"]
    ]) {
      const result = normalizeObservation({ ...base, itemName, itemCode: null, normalizedName: null,
        unit: itemName.startsWith("Ig") ? "g/L" : null,
        resultText: itemName.startsWith("Ig") ? "1.25" : "阴性",
        numericValue: itemName.startsWith("Ig") ? 1.25 : null });
      assert.equal(result.canonicalKey, key, itemName);
    }
  } finally {
    closeDatabaseForTests();
    if (previousStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorage;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
