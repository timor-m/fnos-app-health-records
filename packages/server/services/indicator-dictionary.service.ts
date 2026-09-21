import { createHash, createPublicKey, verify } from "node:crypto";
import { createError } from "h3";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import coreIndicators from "../../../dictionary/core/indicators.json" with { type: "json" };
import coreTaxonomy from "../../../dictionary/core/taxonomy.json" with { type: "json" };
import remoteIndicators from "../../../dictionary/remote/indicators.json" with { type: "json" };
import remoteTaxonomy from "../../../dictionary/remote/taxonomy.json" with { type: "json" };
import indicatorsSchema from "../../../dictionary/schemas/indicators.schema.json" with { type: "json" };
import manifestSchema from "../../../dictionary/schemas/manifest.schema.json" with { type: "json" };
import taxonomySchema from "../../../dictionary/schemas/taxonomy.schema.json" with { type: "json" };
import { getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { configuredRequestTimeout, fetchWithTimeout } from "../utils/outbound-request";

type DictionaryLayer = "core" | "remote";
type DictionaryOperation = "core_sync" | "remote_update" | "rollback";
type DictionaryManifest = {
  formatVersion: number;
  revision: number;
  generatedAt: string;
  files: Record<"taxonomy" | "indicators", { path: string; sha256: string; bytes: number }>;
  signature: null | { algorithm: "ed25519"; keyId: string; value: string };
};
type TaxonomyDocument = {
  formatVersion: number;
  layer: DictionaryLayer;
  revision: number;
  groups: Array<{
    key: string;
    name: string;
    order: number;
    description: string;
    sectionHints: string[];
    subgroups: Array<{
      key: string;
      name: string;
      order: number;
      description: string;
      sectionHints: string[];
    }>;
  }>;
  categories: Array<{
    key: string;
    name: string;
    groupKey: string;
    subgroupKey: string | null;
    order: number;
    aliases: string[];
    sectionHints: string[];
  }>;
};
type IndicatorDefinition = {
  canonicalKey: string;
  displayName: string;
  categoryKey: string;
  order: number;
  kind: "quantitative" | "categorical";
  valueType: "numeric" | "text" | "positive_negative" | "ordinal";
  specimen: string | null;
  defaultUnit: string | null;
  unitDimension: string;
  aliases: string[];
  allowedUnits: string[];
  sectionHints: string[];
  trendSourcePreference?: {
    preferredSections: string[];
    discouragedSections: string[];
    discouragedPenalty?: number;
  };
  referenceRange?: {
    low: number | null;
    high: number | null;
    note?: string;
  };
  explanation: string;
};
type IndicatorsDocument = {
  formatVersion: number;
  layer: DictionaryLayer;
  revision: number;
  indicators: IndicatorDefinition[];
  extensions: Array<{ canonicalKey: string; aliases: string[]; sectionHints: string[] }>;
  redirects: Record<string, string>;
};
type DictionaryDocuments = {
  taxonomy: TaxonomyDocument;
  indicators: IndicatorsDocument;
};
type RemoteDictionaryBundle = {
  sourceUrl: string;
  sourceKind: "network" | "bundled";
  sourceFailures: string[];
  manifest: DictionaryManifest;
  signatureVerified: boolean;
  documents: DictionaryDocuments | null;
};
export type IndicatorDictionaryChangeSummary = {
  indicators: { added: number; updated: number; removed: number };
  aliases: { added: number; removed: number };
  taxonomy: { groupsAdded: number; groupsRemoved: number; categoriesAdded: number; categoriesRemoved: number };
  redirects: { added: number; removed: number };
  samples: { added: string[]; updated: string[]; removed: string[] };
};
type SnapshotRow = {
  id: string;
  layer: DictionaryLayer;
  revision: number;
  contentSha256: string;
  manifestJson: string | null;
  taxonomyJson: string;
  indicatorsJson: string;
  sourceUrl: string | null;
  createdAt: string;
};

const defaultRemoteBaseUrls = [
  "https://gitee.com/timor-m/health-records-dictionary/raw/main/",
  "https://gitee.com/api/v5/repos/timor-m/health-records-dictionary/contents/?ref=main",
  "https://timor-m.github.io/fnos-app-health-records/"
];
const maxManifestBytes = 256 * 1024;
const maxDictionaryFileBytes = 8 * 1024 * 1024;
const requestTimeoutMs = configuredRequestTimeout("DICTIONARY_REQUEST_TIMEOUT_MS", 30_000);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateManifestSchema = ajv.compile(manifestSchema);
const validateTaxonomySchema = ajv.compile(taxonomySchema);
const validateIndicatorsSchema = ajv.compile(indicatorsSchema);
let coreSyncRunning = false;

function assertAdministrator(user: RequestUser) {
  if (!isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标字典" });
  }
}

const protectedAliasQualifiers = /高切|中切|低切|空腹|餐后|随机|卧位|立位|吸气|呼气|左侧|右侧|双侧|直接|间接|总量|定性|定量|绝对值|百分比|百分率|百分数|比例|比率|^[GT]$|^Ig[GMAED]$/i;

function compactAlias(value: string) {
  const normalized = value.normalize("NFKC");
  const brackets = [...normalized.matchAll(/[（(]([^（）()]*)[）)]/g)];
  const preserveQualifiedBracket = brackets.some((match) =>
    protectedAliasQualifiers.test(match[1] || ""),
  );
  const withoutUnqualifiedBrackets = preserveQualifiedBracket
    ? normalized
    : normalized.replace(/[（(].*?[）)]/g, "");
  return withoutUnqualifiedBrackets
    .replace(/[(]\s*([GT])\s*[)]/gi, "§$1§")
    .toLocaleLowerCase("zh-CN")
    .replace(/§([gt])§/g, "($1)")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function documentContentHash(documents: DictionaryDocuments) {
  return sha256(`${JSON.stringify(documents.taxonomy)}\n${JSON.stringify(documents.indicators)}`);
}

function indicatorAliases(documents: DictionaryDocuments) {
  const aliases = new Map<string, Set<string>>();
  for (const indicator of documents.indicators.indicators) {
    aliases.set(indicator.canonicalKey, new Set(indicator.aliases.map(compactAlias)));
  }
  for (const extension of documents.indicators.extensions) {
    const current = aliases.get(extension.canonicalKey) || new Set<string>();
    for (const alias of extension.aliases) current.add(compactAlias(alias));
    aliases.set(extension.canonicalKey, current);
  }
  return aliases;
}

function dictionaryChangeSummary(
  previous: DictionaryDocuments | null,
  next: DictionaryDocuments
): IndicatorDictionaryChangeSummary {
  const previousIndicators = new Map((previous?.indicators.indicators || []).map((item) => [item.canonicalKey, item]));
  const nextIndicators = new Map(next.indicators.indicators.map((item) => [item.canonicalKey, item]));
  const added = [...nextIndicators.keys()].filter((key) => !previousIndicators.has(key));
  const removed = [...previousIndicators.keys()].filter((key) => !nextIndicators.has(key));
  const updated = [...nextIndicators.keys()].filter((key) => {
    const before = previousIndicators.get(key);
    return before && JSON.stringify(before) !== JSON.stringify(nextIndicators.get(key));
  });
  const previousAliases = previous ? indicatorAliases(previous) : new Map<string, Set<string>>();
  const nextAliases = indicatorAliases(next);
  let aliasesAdded = 0;
  let aliasesRemoved = 0;
  for (const [key, aliases] of nextAliases) {
    const before = previousAliases.get(key) || new Set<string>();
    aliasesAdded += [...aliases].filter((alias) => !before.has(alias)).length;
  }
  for (const [key, aliases] of previousAliases) {
    const after = nextAliases.get(key) || new Set<string>();
    aliasesRemoved += [...aliases].filter((alias) => !after.has(alias)).length;
  }
  const previousGroups = new Set((previous?.taxonomy.groups || []).map((item) => item.key));
  const nextGroups = new Set(next.taxonomy.groups.map((item) => item.key));
  const previousCategories = new Set((previous?.taxonomy.categories || []).map((item) => item.key));
  const nextCategories = new Set(next.taxonomy.categories.map((item) => item.key));
  const previousRedirects = new Set(Object.keys(previous?.indicators.redirects || {}));
  const nextRedirects = new Set(Object.keys(next.indicators.redirects));
  const displayName = (key: string) => nextIndicators.get(key)?.displayName
    || previousIndicators.get(key)?.displayName
    || key;
  return {
    indicators: { added: added.length, updated: updated.length, removed: removed.length },
    aliases: { added: aliasesAdded, removed: aliasesRemoved },
    taxonomy: {
      groupsAdded: [...nextGroups].filter((key) => !previousGroups.has(key)).length,
      groupsRemoved: [...previousGroups].filter((key) => !nextGroups.has(key)).length,
      categoriesAdded: [...nextCategories].filter((key) => !previousCategories.has(key)).length,
      categoriesRemoved: [...previousCategories].filter((key) => !nextCategories.has(key)).length
    },
    redirects: {
      added: [...nextRedirects].filter((key) => !previousRedirects.has(key)).length,
      removed: [...previousRedirects].filter((key) => !nextRedirects.has(key)).length
    },
    samples: {
      added: added.slice(0, 8).map(displayName),
      updated: updated.slice(0, 8).map(displayName),
      removed: removed.slice(0, 8).map(displayName)
    }
  };
}

function schemaError(name: string, errors: typeof validateManifestSchema.errors) {
  const detail = errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  return `${name} 校验失败：${detail || "结构无效"}`;
}

function validateDocuments(layer: DictionaryLayer, documents: DictionaryDocuments) {
  if (!validateTaxonomySchema(documents.taxonomy)) {
    throw new Error(schemaError("taxonomy.json", validateTaxonomySchema.errors));
  }
  if (!validateIndicatorsSchema(documents.indicators)) {
    throw new Error(schemaError("indicators.json", validateIndicatorsSchema.errors));
  }
  if (documents.taxonomy.layer !== layer || documents.indicators.layer !== layer) {
    throw new Error(`字典层级必须为 ${layer}`);
  }
  if (documents.taxonomy.revision !== documents.indicators.revision) {
    throw new Error("taxonomy.json 与 indicators.json revision 不一致");
  }
  const categoryKeys = new Set(documents.taxonomy.categories.map((item) => item.key));
  if (layer === "remote") {
    for (const category of (coreTaxonomy as unknown as TaxonomyDocument).categories) {
      categoryKeys.add(category.key);
    }
  }
  const keys = new Set<string>();
  for (const indicator of documents.indicators.indicators) {
    if (keys.has(indicator.canonicalKey)) throw new Error(`重复指标 Key：${indicator.canonicalKey}`);
    if (!categoryKeys.has(indicator.categoryKey)) {
      throw new Error(`指标 ${indicator.canonicalKey} 引用了不存在的分类 ${indicator.categoryKey}`);
    }
    keys.add(indicator.canonicalKey);
  }
}

function activeSnapshot(layer: DictionaryLayer) {
  return getDatabase().prepare(`
    SELECT s.id, s.layer, s.revision, s.content_sha256 AS contentSha256,
      s.manifest_json AS manifestJson, s.taxonomy_json AS taxonomyJson,
      s.indicators_json AS indicatorsJson, s.source_url AS sourceUrl,
      s.created_at AS createdAt
    FROM indicator_dictionary_state state
    JOIN indicator_dictionary_snapshots s ON s.id = state.active_snapshot_id
    WHERE state.layer = ?
  `).get(layer) as SnapshotRow | undefined;
}

function snapshotDocuments(row: SnapshotRow): DictionaryDocuments {
  return {
    taxonomy: JSON.parse(row.taxonomyJson) as TaxonomyDocument,
    indicators: JSON.parse(row.indicatorsJson) as IndicatorsDocument
  };
}

function effectiveDocuments() {
  const core = activeSnapshot("core");
  if (!core) throw new Error("核心指标字典尚未物化");
  const remote = activeSnapshot("remote");
  return {
    core: snapshotDocuments(core),
    coreSnapshot: core,
    remote: remote ? snapshotDocuments(remote) : null,
    remoteSnapshot: remote || null
  };
}

function materializeActiveDictionary() {
  const db = getDatabase();
  const active = effectiveDocuments();
  const layers = [
    { layer: "core" as const, snapshot: active.coreSnapshot, documents: active.core },
    ...(active.remote && active.remoteSnapshot
      ? [{ layer: "remote" as const, snapshot: active.remoteSnapshot, documents: active.remote }]
      : [])
  ];
  const groups = new Map<string, {
    layer: DictionaryLayer;
    revision: number;
    snapshotId: string;
    group: TaxonomyDocument["groups"][number];
  }>();
  const subgroups = new Map<string, {
    layer: DictionaryLayer;
    revision: number;
    snapshotId: string;
    groupKey: string;
    subgroup: TaxonomyDocument["groups"][number]["subgroups"][number];
  }>();
  const categories = new Map<string, { name: string }>();
  for (const current of layers) {
    for (const group of current.documents.taxonomy.groups) {
      if (groups.has(group.key)) throw new Error(`远程字典重复定义分组 ${group.key}`);
      groups.set(group.key, {
        layer: current.layer,
        revision: current.snapshot.revision,
        snapshotId: current.snapshot.id,
        group
      });
      for (const subgroup of group.subgroups) {
        if (subgroups.has(subgroup.key)) throw new Error(`远程字典重复定义子分组 ${subgroup.key}`);
        subgroups.set(subgroup.key, {
          layer: current.layer,
          revision: current.snapshot.revision,
          snapshotId: current.snapshot.id,
          groupKey: group.key,
          subgroup
        });
      }
    }
    for (const category of current.documents.taxonomy.categories) {
      if (categories.has(category.key)) throw new Error(`远程字典重复定义分类 ${category.key}`);
      if (!groups.has(category.groupKey)) throw new Error(`分类 ${category.key} 引用了不存在的分组 ${category.groupKey}`);
      if (category.subgroupKey && subgroups.get(category.subgroupKey)?.groupKey !== category.groupKey) {
        throw new Error(`分类 ${category.key} 的子分组不属于 ${category.groupKey}`);
      }
      categories.set(category.key, { name: category.name });
    }
  }
  const definitions = new Map<string, {
    layer: DictionaryLayer;
    revision: number;
    snapshotId: string;
    definition: IndicatorsDocument["indicators"][number];
    aliases: string[];
  }>();
  for (const current of layers) {
    for (const definition of current.documents.indicators.indicators) {
      if (definitions.has(definition.canonicalKey)) {
        throw new Error(`远程字典不得覆盖已有指标 ${definition.canonicalKey}`);
      }
      definitions.set(definition.canonicalKey, {
        layer: current.layer,
        revision: current.snapshot.revision,
        snapshotId: current.snapshot.id,
        definition,
        aliases: [...definition.aliases]
      });
    }
  }
  if (active.remote) {
    for (const extension of active.remote.indicators.extensions) {
      const target = definitions.get(extension.canonicalKey);
      if (!target) throw new Error(`远程扩展引用不存在的指标 ${extension.canonicalKey}`);
      target.aliases.push(...extension.aliases);
    }
    for (const [source, target] of Object.entries(active.remote.indicators.redirects)) {
      if (definitions.has(source)) throw new Error(`重定向来源仍是有效指标 ${source}`);
      if (!definitions.has(target)) throw new Error(`重定向目标不存在 ${target}`);
    }
  }

  const effectiveVersion = [
    `core-r${active.coreSnapshot.revision}`,
    active.remoteSnapshot ? `remote-r${active.remoteSnapshot.revision}` : null
  ].filter(Boolean).join("+");
  db.prepare("DELETE FROM indicator_taxonomy_categories").run();
  db.prepare("DELETE FROM indicator_taxonomy_subgroups").run();
  db.prepare("DELETE FROM indicator_taxonomy_groups").run();
  const insertGroup = db.prepare(`
    INSERT INTO indicator_taxonomy_groups (
      group_key, name, item_order, description, section_hints_json,
      dictionary_layer, dictionary_revision, dictionary_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const current of groups.values()) {
    insertGroup.run(
      current.group.key,
      current.group.name,
      current.group.order,
      current.group.description,
      JSON.stringify(current.group.sectionHints),
      current.layer,
      current.revision,
      current.snapshotId
    );
  }
  const insertSubgroup = db.prepare(`
    INSERT INTO indicator_taxonomy_subgroups (
      subgroup_key, group_key, name, item_order, description, section_hints_json,
      dictionary_layer, dictionary_revision, dictionary_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const current of subgroups.values()) {
    insertSubgroup.run(
      current.subgroup.key,
      current.groupKey,
      current.subgroup.name,
      current.subgroup.order,
      current.subgroup.description,
      JSON.stringify(current.subgroup.sectionHints),
      current.layer,
      current.revision,
      current.snapshotId
    );
  }
  const insertCategory = db.prepare(`
    INSERT INTO indicator_taxonomy_categories (
      category_key, name, group_key, subgroup_key, item_order,
      aliases_json, section_hints_json, dictionary_layer,
      dictionary_revision, dictionary_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const current of layers) {
    for (const category of current.documents.taxonomy.categories) {
      insertCategory.run(
        category.key,
        category.name,
        category.groupKey,
        category.subgroupKey,
        category.order,
        JSON.stringify(category.aliases),
        JSON.stringify(category.sectionHints),
        current.layer,
        current.snapshot.revision,
        current.snapshot.id
      );
    }
  }
  const upsertIndicator = db.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, specimen, default_unit, value_type,
      trend_enabled, explanation, source, ai_managed, builtin_version,
      category_key, item_order, observation_kind, unit_dimension,
      allowed_units_json, section_hints_json, trend_source_preference_json, reference_range_json,
      dictionary_layer, dictionary_revision, dictionary_snapshot_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(canonical_key) DO UPDATE SET
      display_name = excluded.display_name,
      category = excluded.category,
      specimen = excluded.specimen,
      default_unit = excluded.default_unit,
      value_type = excluded.value_type,
      trend_enabled = excluded.trend_enabled,
      explanation = excluded.explanation,
      source = 'builtin',
      ai_managed = 0,
      builtin_version = excluded.builtin_version,
      category_key = excluded.category_key,
      item_order = excluded.item_order,
      observation_kind = excluded.observation_kind,
      unit_dimension = excluded.unit_dimension,
      allowed_units_json = excluded.allowed_units_json,
      section_hints_json = excluded.section_hints_json,
      trend_source_preference_json = excluded.trend_source_preference_json,
      reference_range_json = excluded.reference_range_json,
      dictionary_layer = excluded.dictionary_layer,
      dictionary_revision = excluded.dictionary_revision,
      dictionary_snapshot_id = excluded.dictionary_snapshot_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  const existingIndicator = db.prepare(`
    SELECT id FROM indicator_catalog WHERE canonical_key = ?
  `);
  db.prepare("DELETE FROM indicator_aliases WHERE source = 'builtin'").run();
  const insertAlias = db.prepare(`
    INSERT INTO indicator_aliases (
      id, indicator_id, alias_name, normalized_alias, scope, source, confidence, enabled,
      dictionary_layer, dictionary_revision, dictionary_snapshot_id, updated_at
    ) VALUES (?, ?, ?, ?, 'global', 'builtin', 1, 1, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  for (const [canonicalKey, current] of definitions) {
    const definition = current.definition;
    const category = categories.get(definition.categoryKey);
    if (!category) throw new Error(`指标 ${canonicalKey} 的分类不存在`);
    const existing = existingIndicator.get(canonicalKey) as { id: string } | undefined;
    const indicatorId = existing?.id || createId("indicator");
    upsertIndicator.run(
      indicatorId,
      canonicalKey,
      definition.displayName,
      category.name,
      definition.specimen,
      definition.defaultUnit,
      definition.valueType === "ordinal" ? "text" : definition.valueType,
      definition.kind === "quantitative" ? 1 : 0,
      definition.explanation,
      effectiveVersion,
      definition.categoryKey,
      definition.order,
      definition.kind,
      definition.unitDimension,
      JSON.stringify(definition.allowedUnits),
      JSON.stringify(definition.sectionHints),
      JSON.stringify(definition.trendSourcePreference ?? {}),
      JSON.stringify(definition.referenceRange ?? {}),
      current.layer,
      current.revision,
      current.snapshotId
    );
    const aliases = new Map<string, string>();
    for (const alias of [definition.displayName, ...current.aliases]) {
      const normalized = compactAlias(alias);
      if (normalized && !aliases.has(normalized)) aliases.set(normalized, alias);
    }
    for (const [normalized, alias] of aliases) {
      insertAlias.run(
        createId("alias"),
        indicatorId,
        alias,
        normalized,
        current.layer,
        current.revision,
        current.snapshotId
      );
    }
  }
  const keys = [...definitions.keys()];
  const placeholders = keys.map(() => "?").join(",");
  db.prepare(`
    DELETE FROM indicator_catalog
    WHERE source = 'builtin' AND canonical_key NOT IN (${placeholders})
  `).run(...keys);
  return {
    indicators: definitions.size,
    aliases: Number((db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_aliases WHERE source = 'builtin'
    `).get() as { count: number }).count),
    version: effectiveVersion
  };
}

function beginUpdate(input: {
  operation: DictionaryOperation;
  layer: DictionaryLayer;
  actorUserId: string | null;
  sourceUrl: string | null;
  toRevision: number;
}) {
  const current = activeSnapshot(input.layer);
  const id = createId("dictionary_update");
  getDatabase().prepare(`
    INSERT INTO indicator_dictionary_updates (
      id, operation, layer, from_revision, to_revision, status, source_url, actor_user_id
    ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?)
  `).run(
    id,
    input.operation,
    input.layer,
    current?.revision ?? null,
    input.toRevision,
    input.sourceUrl,
    input.actorUserId
  );
  return id;
}

function failUpdate(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  getDatabase().prepare(`
    UPDATE indicator_dictionary_updates
    SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(message.slice(0, 1000), id);
  if (error && typeof error === "object") {
    Object.assign(error, { dictionaryUpdateHistoryRecorded: true });
  }
}

function recordRemoteDownloadFailure(user: RequestUser, error: unknown) {
  if (error && typeof error === "object"
    && "dictionaryUpdateHistoryRecorded" in error) return;
  const current = activeSnapshot("remote");
  const message = error instanceof Error ? error.message : String(error);
  getDatabase().prepare(`
    INSERT INTO indicator_dictionary_updates (
      id, operation, layer, from_revision, to_revision, status,
      source_url, actor_user_id, error_message, finished_at
    ) VALUES (?, 'remote_update', 'remote', ?, NULL, 'failed', ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    createId("dictionary_update"),
    current?.revision ?? null,
    (() => {
      try {
        return remoteBaseUrls()[0]?.toString() || null;
      } catch {
        return null;
      }
    })(),
    user.id,
    message.slice(0, 1000)
  );
}

function activateDocuments(input: {
  operation: DictionaryOperation;
  layer: DictionaryLayer;
  documents: DictionaryDocuments;
  manifest: DictionaryManifest | null;
  sourceUrl: string | null;
  actorUserId: string | null;
  /* 未发版期显式修复：允许以同 revision 的新内容替换该层已有快照（管理员强制重装）。
     正式发版后远程内容在同一 revision 下不应变化，此开关仅服务开发期。 */
  allowSameRevisionReplace?: boolean;
}) {
  validateDocuments(input.layer, input.documents);
  const revision = input.documents.indicators.revision;
  const contentSha256 = documentContentHash(input.documents);
  const existingRevision = getDatabase().prepare(`
    SELECT content_sha256 AS contentSha256
    FROM indicator_dictionary_snapshots
    WHERE layer = ? AND revision = ?
    LIMIT 1
  `).get(input.layer, revision) as { contentSha256: string } | undefined;
  if (
    existingRevision &&
    existingRevision.contentSha256 !== contentSha256 &&
    !input.allowSameRevisionReplace
  ) {
    throw createError({
      statusCode: 409,
      statusMessage:
        `${input.layer} 字典 revision ${revision} 已存在不同内容，revision 必须递增；` +
        "未发版开发期请先执行 npm run dictionary:reset-core 显式重建 core 字典",
    });
  }
  const replacingSameRevision = Boolean(
    input.allowSameRevisionReplace &&
    existingRevision &&
    existingRevision.contentSha256 !== contentSha256,
  );
  const updateId = beginUpdate({
    operation: input.operation,
    layer: input.layer,
    actorUserId: input.actorUserId,
    sourceUrl: input.sourceUrl,
    toRevision: revision
  });
  const db = getDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    if (replacingSameRevision) {
      /* state 引用着旧快照且无 ON DELETE 行为，须先清 state 再删快照；同事务内失败可整体回滚 */
      db.prepare("DELETE FROM indicator_dictionary_state WHERE layer = ?").run(input.layer);
      db.prepare(
        "DELETE FROM indicator_dictionary_snapshots WHERE layer = ? AND revision = ?",
      ).run(input.layer, revision);
    }
    const existing = db.prepare(`
      SELECT id FROM indicator_dictionary_snapshots
      WHERE layer = ? AND revision = ? AND content_sha256 = ?
    `).get(input.layer, revision, contentSha256) as { id: string } | undefined;
    const snapshotId = existing?.id || createId("dictionary_snapshot");
    if (!existing) {
      db.prepare(`
        INSERT INTO indicator_dictionary_snapshots (
          id, layer, revision, format_version, content_sha256, manifest_json,
          taxonomy_json, indicators_json, source_url, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        input.layer,
        revision,
        input.documents.indicators.formatVersion,
        contentSha256,
        input.manifest ? JSON.stringify(input.manifest) : null,
        JSON.stringify(input.documents.taxonomy),
        JSON.stringify(input.documents.indicators),
        input.sourceUrl,
        input.actorUserId
      );
    }
    db.prepare(`
      INSERT INTO indicator_dictionary_state (
        layer, active_snapshot_id, revision, content_sha256, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(layer) DO UPDATE SET
        active_snapshot_id = excluded.active_snapshot_id,
        revision = excluded.revision,
        content_sha256 = excluded.content_sha256,
        updated_at = CURRENT_TIMESTAMP
    `).run(input.layer, snapshotId, revision, contentSha256);
    const summary = materializeActiveDictionary();
    db.prepare(`
      UPDATE indicator_dictionary_updates
      SET snapshot_id = ?, status = 'completed', summary_json = ?,
        error_message = NULL, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(snapshotId, JSON.stringify(summary), updateId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, ?, 'indicator_dictionary', ?, ?)
    `).run(
      createId("audit"),
      input.actorUserId,
      input.operation === "rollback" ? "dictionary.rollback" : "dictionary.update",
      snapshotId,
      JSON.stringify({ layer: input.layer, revision, sourceUrl: input.sourceUrl, ...summary })
    );
    db.exec("COMMIT");
    return { snapshotId, revision, contentSha256, ...summary };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original materialization failure.
    }
    failUpdate(updateId, error);
    throw error;
  }
}

export function ensureCoreDictionaryMaterialized() {
  if (coreSyncRunning) return;
  const documents = {
    taxonomy: coreTaxonomy as unknown as TaxonomyDocument,
    indicators: coreIndicators as unknown as IndicatorsDocument
  };
  const contentSha256 = documentContentHash(documents);
  const current = activeSnapshot("core");
  if (current?.revision === documents.indicators.revision && current.contentSha256 === contentSha256) return;
  coreSyncRunning = true;
  try {
    activateDocuments({
      operation: "core_sync",
      layer: "core",
      documents,
      manifest: null,
      sourceUrl: "app://dictionary/core",
      actorUserId: null
    });
  } finally {
    coreSyncRunning = false;
  }
}

/**
 * 测试与本地维护用：把 dictionary/remote 源文件作为 remote 层快照直接物化。
 * 运行时装机仍只物化 core；remote 层始终要求管理员显式安装，
 * 该入口仅供测试搭建与线上快照一致的字典环境，不经过网络下载校验。
 */
export function installRemoteDictionarySnapshotForTests() {
  ensureCoreDictionaryMaterialized();
  return activateDocuments({
    operation: "remote_update",
    layer: "remote",
    documents: {
      taxonomy: remoteTaxonomy as unknown as TaxonomyDocument,
      indicators: remoteIndicators as unknown as IndicatorsDocument
    },
    manifest: null,
    sourceUrl: "app://dictionary/remote",
    actorUserId: null
  });
}

export function activeIndicatorDictionaryVersion() {
  ensureCoreDictionaryMaterialized();
  const core = activeSnapshot("core");
  const remote = activeSnapshot("remote");
  return [
    core ? `core-r${core.revision}` : "core-unavailable",
    remote ? `remote-r${remote.revision}` : null
  ].filter(Boolean).join("+");
}

function parseRemoteBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("远程指标字典地址必须使用 HTTPS");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function remoteBaseUrls() {
  const configuredMultiple = process.env.INDICATOR_DICTIONARY_URLS?.trim();
  const configuredSingle = process.env.INDICATOR_DICTIONARY_URL?.trim();
  const values = configuredMultiple
    ? configuredMultiple.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean)
    : configuredSingle ? [configuredSingle] : defaultRemoteBaseUrls;
  const urls = new Map<string, URL>();
  for (const value of values) {
    const url = parseRemoteBaseUrl(value);
    urls.set(url.toString(), url);
  }
  if (!urls.size) throw new Error("未配置远程指标字典地址");
  return [...urls.values()];
}

function hasConfiguredRemoteBaseUrls() {
  return Boolean(
    process.env.INDICATOR_DICTIONARY_URLS?.trim()
    || process.env.INDICATOR_DICTIONARY_URL?.trim(),
  );
}

function isGiteeContentsApi(url: URL) {
  return url.hostname === "gitee.com"
    && url.pathname.startsWith("/api/v5/repos/")
    && url.pathname.includes("/contents/");
}

function responseMaximumBytes(url: URL, maximumBytes: number) {
  return isGiteeContentsApi(url)
    ? Math.min(maxDictionaryFileBytes * 2, Math.max(maximumBytes, Math.ceil(maximumBytes * 4 / 3) + 4096))
    : maximumBytes;
}

async function fetchBytes(url: URL, maximumBytes: number) {
  let requestUrl = url;
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    response = await fetchWithTimeout(requestUrl, {
      headers: { Accept: "application/json" },
      redirect: "manual"
    }, {
      timeoutMs: requestTimeoutMs,
      timeoutCode: "DICTIONARY_TIMEOUT",
      timeoutMessage: "远程指标字典请求超时",
      networkCode: "DICTIONARY_NETWORK_ERROR",
      networkMessage: "无法连接远程指标字典"
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("远程指标字典重定向缺少目标地址");
    const redirectedUrl = new URL(location, requestUrl);
    const sameOrigin = redirectedUrl.origin === requestUrl.origin;
    const officialGiteeRaw = requestUrl.hostname === "gitee.com"
      && redirectedUrl.hostname === "raw.giteeusercontent.com";
    if (redirectedUrl.protocol !== "https:" || (!sameOrigin && !officialGiteeRaw)) {
      throw new Error(`远程指标字典拒绝不受信任的重定向：${redirectedUrl.host}`);
    }
    requestUrl = redirectedUrl;
    response = null;
  }
  if (!response) throw new Error("远程指标字典重定向次数过多");
  if (!response.ok) throw new Error(`远程指标字典请求失败（HTTP ${response.status}）`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  const apiResponse = isGiteeContentsApi(requestUrl);
  const maximumResponseBytes = responseMaximumBytes(requestUrl, maximumBytes);
  if (declaredLength > maximumResponseBytes) throw new Error("远程指标字典文件超过大小限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumResponseBytes) throw new Error("远程指标字典文件超过大小限制");
  if (!apiResponse) {
    if (bytes.byteLength > maximumBytes) throw new Error("远程指标字典文件超过大小限制");
    return bytes;
  }
  /* Contents API 返回文件元数据和 Base64 内容，解码后继续执行 manifest 哈希校验。 */
  const payload = parseJson<{ type?: string; encoding?: string; content?: string }>(bytes, "Gitee Contents API 响应");
  if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error("Gitee Contents API 未返回有效文件内容");
  }
  const encoded = payload.content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("Gitee Contents API 返回的文件内容不是有效 Base64");
  }
  const decoded = new Uint8Array(Buffer.from(encoded, "base64"));
  if (decoded.byteLength > maximumBytes) throw new Error("远程指标字典文件超过大小限制");
  return decoded;
}

function parseJson<T>(bytes: Uint8Array, label: string) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function dictionaryFileUrl(baseUrl: URL, path: string) {
  if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..")) {
    throw new Error(`字典文件路径无效：${path}`);
  }
  const url = new URL(path, baseUrl);
  for (const [key, value] of baseUrl.searchParams) url.searchParams.set(key, value);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`字典文件路径越界：${path}`);
  }
  return url;
}

function verifyManifestSignature(manifest: DictionaryManifest) {
  const publicKeyValue = process.env.DICTIONARY_SIGNING_PUBLIC_KEY?.replaceAll("\\n", "\n").trim();
  if (!manifest.signature) {
    if (publicKeyValue) throw new Error("远程字典缺少必需的签名");
    return false;
  }
  if (!publicKeyValue) throw new Error("远程字典带有签名，但应用未配置验证公钥");
  const unsigned = {
    formatVersion: manifest.formatVersion,
    revision: manifest.revision,
    generatedAt: manifest.generatedAt,
    files: manifest.files
  };
  const valid = verify(
    null,
    Buffer.from(JSON.stringify(unsigned)),
    createPublicKey(publicKeyValue),
    Buffer.from(manifest.signature.value, "base64")
  );
  if (!valid) throw new Error("远程字典签名验证失败");
  return true;
}

async function fetchRemoteBundleFrom(
  baseUrl: URL,
  includeFiles: boolean,
): Promise<RemoteDictionaryBundle> {
  const manifestBytes = await fetchBytes(dictionaryFileUrl(baseUrl, "manifest.json"), maxManifestBytes);
  const manifest = parseJson<DictionaryManifest>(manifestBytes, "manifest.json");
  if (!validateManifestSchema(manifest)) {
    throw new Error(schemaError("manifest.json", validateManifestSchema.errors));
  }
  const signatureVerified = verifyManifestSignature(manifest);
  if (!includeFiles) {
    return {
      sourceUrl: baseUrl.toString(),
      sourceKind: "network",
      sourceFailures: [],
      manifest,
      signatureVerified,
      documents: null,
    };
  }
  const taxonomyBytes = await fetchBytes(
    dictionaryFileUrl(baseUrl, manifest.files.taxonomy.path),
    Math.min(maxDictionaryFileBytes, manifest.files.taxonomy.bytes)
  );
  const indicatorsBytes = await fetchBytes(
    dictionaryFileUrl(baseUrl, manifest.files.indicators.path),
    Math.min(maxDictionaryFileBytes, manifest.files.indicators.bytes)
  );
  for (const [label, bytes, metadata] of [
    ["taxonomy.json", taxonomyBytes, manifest.files.taxonomy],
    ["indicators.json", indicatorsBytes, manifest.files.indicators]
  ] as const) {
    if (bytes.byteLength !== metadata.bytes) throw new Error(`${label} 文件大小与 manifest 不一致`);
    if (sha256(bytes) !== metadata.sha256) throw new Error(`${label} SHA-256 校验失败`);
  }
  const documents = {
    taxonomy: parseJson<TaxonomyDocument>(taxonomyBytes, "taxonomy.json"),
    indicators: parseJson<IndicatorsDocument>(indicatorsBytes, "indicators.json")
  };
  validateDocuments("remote", documents);
  if (documents.indicators.revision !== manifest.revision) {
    throw new Error("远程字典 revision 与 manifest 不一致");
  }
  return {
    sourceUrl: baseUrl.toString(),
    sourceKind: "network",
    sourceFailures: [],
    manifest,
    signatureVerified,
    documents,
  };
}

function bundledRemoteBundle(sourceFailures: string[]): RemoteDictionaryBundle {
  const documents: DictionaryDocuments = {
    taxonomy: structuredClone(remoteTaxonomy) as unknown as TaxonomyDocument,
    indicators: structuredClone(remoteIndicators) as unknown as IndicatorsDocument,
  };
  validateDocuments("remote", documents);
  const taxonomyBytes = new TextEncoder().encode(JSON.stringify(documents.taxonomy));
  const indicatorsBytes = new TextEncoder().encode(JSON.stringify(documents.indicators));
  const manifest: DictionaryManifest = {
    formatVersion: 1,
    revision: documents.indicators.revision,
    generatedAt: "1970-01-01T00:00:00.000Z",
    files: {
      taxonomy: {
        path: "taxonomy.json",
        sha256: sha256(taxonomyBytes),
        bytes: taxonomyBytes.byteLength,
      },
      indicators: {
        path: "indicators.json",
        sha256: sha256(indicatorsBytes),
        bytes: indicatorsBytes.byteLength,
      },
    },
    signature: null,
  };
  return {
    sourceUrl: "app://dictionary/remote",
    sourceKind: "bundled",
    sourceFailures,
    manifest,
    signatureVerified: false,
    documents,
  };
}

async function fetchRemoteBundle(
  includeFiles: boolean,
  options?: { useBundledFallback?: boolean },
) {
  if (options?.useBundledFallback) {
    if (hasConfiguredRemoteBaseUrls()) {
      throw createError({
        statusCode: 409,
        statusMessage: "自定义远程字典不能切换为应用内置快照",
      });
    }
    return bundledRemoteBundle([]);
  }
  const failures: string[] = [];
  for (const baseUrl of remoteBaseUrls()) {
    try {
      const bundle = await fetchRemoteBundleFrom(baseUrl, includeFiles);
      if (!hasConfiguredRemoteBaseUrls() && includeFiles) {
        const bundled = bundledRemoteBundle(failures);
        if (bundled.manifest.revision > bundle.manifest.revision) {
          return bundledRemoteBundle([
            ...failures,
            `${baseUrl.host}：远程 revision ${bundle.manifest.revision} 低于应用内置 revision ${bundled.manifest.revision}`,
          ]);
        }
      }
      return { ...bundle, sourceFailures: failures };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${baseUrl.host}：${message}`);
    }
  }
  if (!hasConfiguredRemoteBaseUrls() && includeFiles) {
    return bundledRemoteBundle(failures);
  }
  throw createError({
    statusCode: 502, data: { code: "REMOTE_SERVICE_ERROR" },
    statusMessage: failures.some(message => message.endsWith("SHA-256 校验失败"))
      ? "所有远程指标字典源均不可用（SHA-256 校验失败）"
      : "所有远程指标字典源均不可用",
  });
}

export async function checkRemoteIndicatorDictionary(user: RequestUser) {
  assertAdministrator(user);
  ensureCoreDictionaryMaterialized();
  const remote = activeSnapshot("remote");
  const bundle = await fetchRemoteBundle(true);
  const previous = remote ? snapshotDocuments(remote) : null;
  /* 未发版期远程内容可能在同一 revision 下被重新发布：不作为错误抛出，
     而是显式返回标志，由界面给出强制重装入口。 */
  const revisionContentChanged = Boolean(
    remote &&
    remote.revision === bundle.manifest.revision &&
    remote.contentSha256 !== documentContentHash(bundle.documents!),
  );
  return {
    currentRevision: remote?.revision ?? null,
    latestRevision: bundle.manifest.revision,
    updateAvailable: !remote || bundle.manifest.revision > remote.revision,
    revisionContentChanged,
    generatedAt: bundle.manifest.generatedAt,
    signatureVerified: bundle.signatureVerified,
    sourceUrl: bundle.sourceUrl,
    sourceKind: bundle.sourceKind,
    sourceFailures: bundle.sourceFailures,
    changes: dictionaryChangeSummary(previous, bundle.documents!)
  };
}

export async function updateRemoteIndicatorDictionary(
  user: RequestUser,
  options?: { force?: boolean; useBundledFallback?: boolean },
) {
  assertAdministrator(user);
  ensureCoreDictionaryMaterialized();
  try {
    const bundle = await fetchRemoteBundle(true, {
      useBundledFallback: options?.useBundledFallback,
    });
    const current = activeSnapshot("remote");
    const forceReinstall = Boolean(
      options?.force && current && bundle.manifest.revision === current.revision,
    );
    if (current && bundle.manifest.revision < current.revision) {
      throw createError({ statusCode: 409, statusMessage: "远程字典 revision 低于当前版本，如需旧版本请使用回滚" });
    }
    if (current && bundle.manifest.revision === current.revision && !forceReinstall) {
      throw createError({ statusCode: 409, statusMessage: "远程字典没有更高的 revision" });
    }
    const changes = dictionaryChangeSummary(current ? snapshotDocuments(current) : null, bundle.documents!);
    const result = activateDocuments({
      operation: "remote_update",
      layer: "remote",
      documents: bundle.documents!,
      manifest: bundle.manifest,
      sourceUrl: bundle.sourceUrl,
      actorUserId: user.id,
      allowSameRevisionReplace: forceReinstall
    });
    return {
      ...result,
      signatureVerified: bundle.signatureVerified,
      sourceKind: bundle.sourceKind,
      sourceFailures: bundle.sourceFailures,
      changes,
    };
  } catch (error) {
    recordRemoteDownloadFailure(user, error);
    throw error;
  }
}

export function rollbackRemoteIndicatorDictionary(user: RequestUser, snapshotId: string) {
  assertAdministrator(user);
  ensureCoreDictionaryMaterialized();
  const target = getDatabase().prepare(`
    SELECT id, layer, revision, content_sha256 AS contentSha256,
      manifest_json AS manifestJson, taxonomy_json AS taxonomyJson,
      indicators_json AS indicatorsJson, source_url AS sourceUrl,
      created_at AS createdAt
    FROM indicator_dictionary_snapshots
    WHERE id = ? AND layer = 'remote'
  `).get(snapshotId) as SnapshotRow | undefined;
  if (!target) throw createError({ statusCode: 404, statusMessage: "远程字典快照不存在" });
  const current = activeSnapshot("remote");
  if (current?.id === target.id) {
    throw createError({ statusCode: 409, statusMessage: "该快照已经处于生效状态" });
  }
  return activateDocuments({
    operation: "rollback",
    layer: "remote",
    documents: snapshotDocuments(target),
    manifest: target.manifestJson ? JSON.parse(target.manifestJson) as DictionaryManifest : null,
    sourceUrl: target.sourceUrl,
    actorUserId: user.id
  });
}

export function getIndicatorDictionaryStatus(user: RequestUser) {
  assertAdministrator(user);
  ensureCoreDictionaryMaterialized();
  const db = getDatabase();
  const states = db.prepare(`
    SELECT state.layer, state.revision, state.content_sha256 AS contentSha256,
      state.active_snapshot_id AS snapshotId, state.updated_at AS updatedAt,
      snapshot.source_url AS sourceUrl
    FROM indicator_dictionary_state state
    JOIN indicator_dictionary_snapshots snapshot ON snapshot.id = state.active_snapshot_id
    ORDER BY CASE state.layer WHEN 'core' THEN 0 ELSE 1 END
  `).all();
  const history = db.prepare(`
    SELECT updates.id, updates.operation, updates.layer,
      updates.from_revision AS fromRevision, updates.to_revision AS toRevision,
      updates.snapshot_id AS snapshotId, updates.status, updates.source_url AS sourceUrl,
      updates.error_message AS errorMessage, updates.created_at AS createdAt,
      updates.finished_at AS finishedAt, users.display_name AS actorName
    FROM indicator_dictionary_updates updates
    LEFT JOIN users ON users.id = updates.actor_user_id
    ORDER BY updates.created_at DESC, updates.id DESC
    LIMIT 30
  `).all();
  const snapshots = db.prepare(`
    SELECT snapshot.id, snapshot.layer, snapshot.revision,
      snapshot.content_sha256 AS contentSha256, snapshot.source_url AS sourceUrl,
      snapshot.created_at AS createdAt,
      CASE WHEN state.active_snapshot_id = snapshot.id THEN 1 ELSE 0 END AS active
    FROM indicator_dictionary_snapshots snapshot
    LEFT JOIN indicator_dictionary_state state
      ON state.layer = snapshot.layer AND state.active_snapshot_id = snapshot.id
    ORDER BY snapshot.layer, snapshot.revision DESC, snapshot.created_at DESC
  `).all();
  const catalog = db.prepare(`
    SELECT dictionary_layer AS layer, COUNT(*) AS count
    FROM indicator_catalog
    WHERE source = 'builtin' AND dictionary_layer IS NOT NULL
    GROUP BY dictionary_layer
  `).all();
  return {
    version: activeIndicatorDictionaryVersion(),
    remoteBaseUrl: remoteBaseUrls()[0].toString(),
    remoteBaseUrls: remoteBaseUrls().map((url) => url.toString()),
    states,
    snapshots,
    history,
    catalog
  };
}
