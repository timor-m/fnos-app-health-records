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
  rollbackRemoteIndicatorDictionary,
  updateRemoteIndicatorDictionary
} from "../services/indicator-dictionary.service.ts";
import {
  backfillBuiltinIndicatorNormalizations,
  listIndicatorNormalizationIssues,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";

const bundledRevision = JSON.parse(readFileSync(new URL("../../../dictionary/remote/indicators.json", import.meta.url), "utf8")).revision;

const admin: RequestUser = {
  id: "dictionary-admin",
  displayName: "管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const regularUser: RequestUser = {
  ...admin,
  id: "dictionary-user",
  displayName: "普通用户",
  isGatewayAdmin: false
};

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectHttpError(statusCode: number, pattern: RegExp) {
  return (error: unknown) => {
    const candidate = error as { statusCode?: unknown; message?: unknown } | null;
    return Boolean(
      candidate &&
      candidate.statusCode === statusCode &&
      typeof candidate.message === "string" &&
      pattern.test(candidate.message),
    );
  };
}

function remoteBundle(revision: number, includePendingAlias: boolean) {
  const taxonomy = {
    $schema: "../schemas/taxonomy.schema.json",
    formatVersion: 1,
    layer: "remote",
    revision,
    groups: [{
      key: "special_lab",
      name: "专项检验",
      order: 70,
      description: "远程字典测试分组",
      sectionHints: ["专项检验"],
      subgroups: []
    }],
    categories: [{
      key: "special_marker",
      name: "专项指标",
      groupKey: "special_lab",
      subgroupKey: null,
      order: 10,
      aliases: ["专项"],
      sectionHints: ["专项检验"]
    }]
  };
  const indicators = {
    $schema: "../schemas/indicators.schema.json",
    formatVersion: 1,
    layer: "remote",
    revision,
    indicators: [{
      canonicalKey: "remote_marker",
      displayName: "远程专项指标",
      categoryKey: "special_marker",
      order: 10,
      kind: "quantitative",
      valueType: "numeric",
      specimen: "serum",
      defaultUnit: "U/L",
      unitDimension: "enzyme_activity",
      aliases: includePendingAlias ? ["远程项目", "待收录项目"] : ["远程项目"],
      allowedUnits: ["U/L"],
      sectionHints: ["专项检验"],
      explanation: "用于验证远程指标字典的安装、匹配和回滚。"
    }],
    extensions: [],
    redirects: {}
  };
  const taxonomyBytes = jsonBytes(taxonomy);
  const indicatorsBytes = jsonBytes(indicators);
  return {
    taxonomyBytes,
    indicatorsBytes,
    manifest: {
      formatVersion: 1,
      revision,
      generatedAt: new Date(Date.UTC(2026, 6, 20 + revision)).toISOString(),
      files: {
        taxonomy: {
          path: "taxonomy.json",
          sha256: hash(taxonomyBytes),
          bytes: taxonomyBytes.byteLength
        },
        indicators: {
          path: "indicators.json",
          sha256: hash(indicatorsBytes),
          bytes: indicatorsBytes.byteLength
        }
      },
      signature: null
    }
  };
}

function remoteBundleUsingCoreCategory(revision: number) {
  const bundle = remoteBundle(revision, true);
  const taxonomy = JSON.parse(new TextDecoder().decode(bundle.taxonomyBytes));
  taxonomy.groups = [];
  taxonomy.categories = [];
  const indicators = JSON.parse(new TextDecoder().decode(bundle.indicatorsBytes));
  indicators.indicators[0].categoryKey = "laboratory_other";
  bundle.taxonomyBytes = jsonBytes(taxonomy);
  bundle.indicatorsBytes = jsonBytes(indicators);
  bundle.manifest.files.taxonomy = {
    ...bundle.manifest.files.taxonomy,
    sha256: hash(bundle.taxonomyBytes),
    bytes: bundle.taxonomyBytes.byteLength
  };
  bundle.manifest.files.indicators = {
    ...bundle.manifest.files.indicators,
    sha256: hash(bundle.indicatorsBytes),
    bytes: bundle.indicatorsBytes.byteLength
  };
  return bundle;
}

test("installs, upgrades and rolls back remote dictionaries while preserving unmatched-name history", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-remote-dictionary-"));
  const originalFetch = globalThis.fetch;
  process.env.STORAGE_DIR = storageDir;
  process.env.INDICATOR_DICTIONARY_URL = "https://dictionary.test/";
  let bundle = remoteBundle(1, false);
  let corruptIndicatorsHash = false;
  let redirectGiteeRaw = false;
  let failGiteeContentsApi = false;
  const failedHosts = new Set<string>();
  const requestedHosts: string[] = [];
  globalThis.fetch = (async (input) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    requestedHosts.push(url.host);
    const isGiteeContentsApi = url.pathname.startsWith("/api/v5/repos/")
      && url.pathname.includes("/contents/");
    if (failedHosts.has(url.host) && (!isGiteeContentsApi || failGiteeContentsApi)) {
      return new Response("unavailable", { status: 503 });
    }
    if (redirectGiteeRaw && url.host === "gitee.com") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://raw.giteeusercontent.com${url.pathname}`
        }
      });
    }
    const pathname = url.pathname;
    if (isGiteeContentsApi) {
      let content: Uint8Array;
      if (pathname.endsWith("/manifest.json")) {
        const manifest = structuredClone(bundle.manifest);
        if (corruptIndicatorsHash) manifest.files.indicators.sha256 = "0".repeat(64);
        content = jsonBytes(manifest);
      } else if (pathname.endsWith("/taxonomy.json")) {
        content = bundle.taxonomyBytes;
      } else if (pathname.endsWith("/indicators.json")) {
        content = bundle.indicatorsBytes;
      } else {
        return new Response("not found", { status: 404 });
      }
      return new Response(jsonBytes({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64")
      }), { status: 200 });
    }
    if (pathname.endsWith("/manifest.json")) {
      const manifest = structuredClone(bundle.manifest);
      if (corruptIndicatorsHash) manifest.files.indicators.sha256 = "0".repeat(64);
      return new Response(jsonBytes(manifest), { status: 200 });
    }
    if (pathname.endsWith("/taxonomy.json")) {
      return new Response(bundle.taxonomyBytes, { status: 200 });
    }
    if (pathname.endsWith("/indicators.json")) {
      return new Response(bundle.indicatorsBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES (?, ?, 1), (?, ?, 0)
    `).run(admin.id, admin.displayName, regularUser.id, regularUser.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('dictionary-member', '本人', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO reports (
        id, member_id, title, report_type, status, report_issued_at, created_by
      ) VALUES (
        'dictionary-report', 'dictionary-member', '专项检验', 'laboratory',
        'ready', '2026-07-28', ?
      )
    `).run(admin.id);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit
      ) VALUES (
        'dictionary-observation', 'dictionary-report', '专项检验',
        '待收录项目', '待收录项目', '12 U/L', 12, 'U/L'
      )
    `).run();

    assert.throws(
      () => getIndicatorDictionaryStatus(regularUser),
      (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error
        && (error as { statusCode: number }).statusCode === 403)
    );

    const firstCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(firstCheck.updateAvailable, true);
    assert.deepEqual(firstCheck.changes.indicators, { added: 1, updated: 0, removed: 0 });
    assert.equal(firstCheck.changes.aliases.added, 1);
    assert.equal(firstCheck.changes.taxonomy.groupsAdded, 1);
    assert.equal(firstCheck.changes.taxonomy.categoriesAdded, 1);
    const first = await updateRemoteIndicatorDictionary(admin);
    assert.equal(first.revision, 1);
    const remoteIndicatorCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_catalog
      WHERE canonical_key = 'remote_marker' AND dictionary_layer = 'remote'
    `).get() as { count: number };
    assert.equal(remoteIndicatorCount.count, 1);
    const remoteGroupCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_taxonomy_groups
      WHERE group_key = 'special_lab' AND dictionary_layer = 'remote'
    `).get() as { count: number };
    assert.equal(remoteGroupCount.count, 1);

    normalizeReportObservations("dictionary-report");
    const firstIssues = listIndicatorNormalizationIssues(admin);
    assert.equal(firstIssues.find((item) => item.rawName === "待收录项目")?.count, 1);
    const repeatedIssues = listIndicatorNormalizationIssues(admin);
    assert.equal(repeatedIssues.find((item) => item.rawName === "待收录项目")?.count, 1);

    bundle = remoteBundle(2, true);
    const secondCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(secondCheck.changes.indicators.updated, 1);
    assert.equal(secondCheck.changes.aliases.added, 1);
    assert.deepEqual(secondCheck.changes.samples.updated, ["远程专项指标"]);
    const second = await updateRemoteIndicatorDictionary(admin);
    assert.equal(second.revision, 2);
    const backfill = backfillBuiltinIndicatorNormalizations();
    assert.equal(backfill.updated, 1);
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.rawName === "待收录项目"), false);
    const normalization = db.prepare(`
      SELECT canonical_key AS canonicalKey
      FROM observation_normalizations WHERE observation_id = 'dictionary-observation'
    `).get() as { canonicalKey: string };
    assert.equal(normalization.canonicalKey, "remote_marker");

    const revisionOneSnapshot = getIndicatorDictionaryStatus(admin).snapshots.find(
      (item: any) => item.layer === "remote" && item.revision === 1
    ) as { id: string } | undefined;
    assert.ok(revisionOneSnapshot);
    const rollback = rollbackRemoteIndicatorDictionary(admin, revisionOneSnapshot.id);
    assert.equal(rollback.revision, 1);
    assert.equal(getIndicatorDictionaryStatus(admin).states.find(
      (item: any) => item.layer === "remote"
    )?.revision, 1);
    const rollbackBackfill = backfillBuiltinIndicatorNormalizations();
    assert.equal(rollbackBackfill.unmatched, 1);
    const rolledBackNormalization = db.prepare(`
      SELECT canonical_key AS canonicalKey
      FROM observation_normalizations WHERE observation_id = 'dictionary-observation'
    `).get() as { canonicalKey: string | null };
    assert.equal(rolledBackNormalization.canonicalKey, null);
    assert.equal(
      listIndicatorNormalizationIssues(admin).find((item) => item.rawName === "待收录项目")?.count,
      1
    );

    bundle = remoteBundle(2, false);
    bundle.indicatorsBytes = jsonBytes({
      ...JSON.parse(new TextDecoder().decode(bundle.indicatorsBytes)),
      indicators: [{
        ...JSON.parse(new TextDecoder().decode(bundle.indicatorsBytes)).indicators[0],
        displayName: "被错误复用 revision 的名称"
      }]
    });
    bundle.manifest.files.indicators = {
      ...bundle.manifest.files.indicators,
      sha256: hash(bundle.indicatorsBytes),
      bytes: bundle.indicatorsBytes.byteLength
    };
    await assert.rejects(
      updateRemoteIndicatorDictionary(admin),
      /revision 2 已存在不同内容/
    );
    assert.equal(getIndicatorDictionaryStatus(admin).states.find(
      (item: any) => item.layer === "remote"
    )?.revision, 1);

    bundle = remoteBundle(3, true);
    corruptIndicatorsHash = true;
    await assert.rejects(updateRemoteIndicatorDictionary(admin), /SHA-256 校验失败/);
    const finalStatus = getIndicatorDictionaryStatus(admin);
    assert.equal(finalStatus.states.find((item: any) => item.layer === "remote")?.revision, 1);
    assert.equal(finalStatus.history.some(
      (item: any) => item.status === "failed" && /SHA-256/.test(item.errorMessage || "")
    ), true);

    delete process.env.INDICATOR_DICTIONARY_URL;
    bundle = remoteBundle(4, true);
    corruptIndicatorsHash = false;
    failedHosts.add("gitee.com");
    requestedHosts.length = 0;
    const fallbackCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(
      fallbackCheck.sourceUrl,
      "app://dictionary/remote",
    );
    assert.equal(fallbackCheck.sourceKind, "bundled");
    assert.equal(fallbackCheck.latestRevision, bundledRevision);
    assert.match(fallbackCheck.sourceFailures.at(-1) || "", new RegExp(`远程 revision 4.*内置 revision ${bundledRevision}`));
    assert.deepEqual(requestedHosts.slice(0, 2), ["gitee.com", "gitee.com"]);
    assert.deepEqual(getIndicatorDictionaryStatus(admin).remoteBaseUrls, [
      "https://gitee.com/timor-m/health-records-dictionary/raw/main/",
      "https://gitee.com/api/v5/repos/timor-m/health-records-dictionary/contents/?ref=main",
      "https://timor-m.github.io/fnos-app-health-records/"
    ]);

    failedHosts.clear();
    redirectGiteeRaw = true;
    bundle = remoteBundleUsingCoreCategory(bundledRevision);
    requestedHosts.length = 0;
    const giteeCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(giteeCheck.sourceUrl, "https://gitee.com/timor-m/health-records-dictionary/raw/main/");
    assert.deepEqual(requestedHosts.slice(0, 2), ["gitee.com", "raw.giteeusercontent.com"]);

    redirectGiteeRaw = false;
    failedHosts.add("gitee.com");
    failedHosts.add("timor-m.github.io");
    failGiteeContentsApi = true;
    requestedHosts.length = 0;
    const bundledCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(bundledCheck.sourceUrl, "app://dictionary/remote");
    assert.equal(bundledCheck.sourceKind, "bundled");
    assert.equal(bundledCheck.latestRevision, bundledRevision);
    assert.deepEqual(requestedHosts.slice(0, 3), ["gitee.com", "gitee.com", "timor-m.github.io"]);
    assert.equal(bundledCheck.sourceFailures.length, 3);

    requestedHosts.length = 0;
    const bundledUpdate = await updateRemoteIndicatorDictionary(admin, {
      useBundledFallback: true,
    });
    assert.equal(bundledUpdate.sourceKind, "bundled");
    assert.equal(bundledUpdate.revision, bundledRevision);
    assert.deepEqual(requestedHosts, []);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.INDICATOR_DICTIONARY_URL;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("flags same-revision remote content drift and repairs it via forced reinstall", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-dictionary-drift-"));
  const originalFetch = globalThis.fetch;
  process.env.STORAGE_DIR = storageDir;
  process.env.INDICATOR_DICTIONARY_URL = "https://dictionary.test/";
  let bundle = remoteBundle(1, false);
  let sourcesDown = false;
  globalThis.fetch = (async (input) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (sourcesDown) return new Response("unavailable", { status: 503 });
    if (url.pathname.endsWith("/manifest.json")) {
      return new Response(jsonBytes(bundle.manifest), { status: 200 });
    }
    if (url.pathname.endsWith("/taxonomy.json")) {
      return new Response(bundle.taxonomyBytes, { status: 200 });
    }
    if (url.pathname.endsWith("/indicators.json")) {
      return new Response(bundle.indicatorsBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)
    `).run(admin.id, admin.displayName);

    await updateRemoteIndicatorDictionary(admin);

    /* 未发版期远程在同一 revision 重新发布了不同内容：检查不应报错，而是返回漂移标志 */
    const drifted = remoteBundle(1, true);
    drifted.manifest = { ...drifted.manifest, revision: 1 };
    bundle = drifted;
    const check = await checkRemoteIndicatorDictionary(admin);
    assert.equal(check.updateAvailable, false);
    assert.equal(check.revisionContentChanged, true);

    /* 未强制的同 revision 更新仍被拒绝 */
    await assert.rejects(
      updateRemoteIndicatorDictionary(admin),
      expectHttpError(409, /没有更高的 revision/),
    );

    /* 强制重装：同 revision 旧快照被替换，字典内容以远程新内容为准 */
    const reinstalled = await updateRemoteIndicatorDictionary(admin, { force: true });
    assert.equal(reinstalled.revision, 1);
    const snapshotCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_dictionary_snapshots
      WHERE layer = 'remote' AND revision = 1
    `).get() as { count: number };
    assert.equal(snapshotCount.count, 1);
    const aliasRow = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_aliases
      WHERE alias_name = '待收录项目' AND dictionary_layer = 'remote'
    `).get() as { count: number };
    assert.equal(aliasRow.count, 1);
    const driftCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(driftCheck.revisionContentChanged, false);

    /* 远程源全部不可用：返回带逐源原因的 502，而不是裸 500 */
    sourcesDown = true;
    await assert.rejects(
      checkRemoteIndicatorDictionary(admin),
      expectHttpError(502, /所有远程指标字典源均不可用/),
    );
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.INDICATOR_DICTIONARY_URL;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
