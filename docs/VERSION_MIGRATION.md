# 版本与数据库迁移落地规范

本文档定义健康档案应用的版本发布、本地 SQLite 数据库迁移和提交变更流程。凡是功能迭代涉及数据库表、字段、索引、约束或结构化数据含义变化，都必须按本文档补充迁移记录。完整应用发布步骤见 [应用发布与数据库升级流程](./RELEASE_PROCESS.md)。

## 目标

- 应用升级可追踪：记录应用从哪个版本升级到哪个版本。
- 数据库按需迁移：只有数据库结构或数据语义变化时才提升 schema 版本。
- 启动前完成迁移：应用首次启动时先检查版本差异，迁移成功后再开放业务 API 和页面。
- 失败可恢复：迁移前自动备份 SQLite，迁移失败时停止进入应用，保留错误信息。
- 提交流程可检查：数据库变更必须带迁移脚本、测试和变更说明。

## 版本模型

应用版本和数据库版本分开管理。

| 类型 | 来源 | 递增条件 | 示例 |
| --- | --- | --- | --- |
| 应用版本 | 根目录 `package.json` | 任意发布版本 | `0.1.0` -> `0.1.1` |
| 数据库版本 | `packages/server/database/migrations.ts` | 表结构、索引、约束、数据语义变化 | schema v6 -> v7 |

应用版本升级不一定触发数据库迁移。例如只调整 UI、文案、图标或打包配置时，只更新应用版本和 changelog，不提升 schema 版本。

## 数据库变更判定

以下变更必须新增数据库迁移：

- 新增、删除、重命名表。
- 新增、删除、重命名字段。
- 修改字段类型、默认值、CHECK 约束、NOT NULL 约束。
- 新增、删除、修改索引或唯一约束。
- 调整外键关系或级联策略。
- 改变字段存储语义，例如 `title` 从固定拼接改为 AI 生成标题。
- 需要批量修正历史数据，并且修正结果会影响业务逻辑。

以下变更通常不需要数据库迁移：

- 纯前端样式、交互和文案。
- API 返回字段的展示格式调整，但底层存储不变。
- OCR/AI prompt 调整，且不改变入库字段结构。
- 新增非持久化运行状态。

## 目录约定

```text
packages/server/database/
  schema.ts          # 最新完整 schema，用于新库初始化和最终校验
  migrations.ts     # 迁移注册表，按 version 升序维护
  client.ts         # 启动检查、备份、迁移执行和状态查询
```

后续如果迁移数量变多，可以把 `migrations.ts` 拆成目录：

```text
packages/server/database/migrations/
  0001_initial_health_records_schema.ts
  0002_add_pdf_source_page_columns.ts
  0003_add_report_extractions.ts
```

拆分后仍必须保留一个统一注册表，确保执行顺序稳定。

## 迁移脚本规范

每个迁移必须包含：

- `version`：整数，严格递增，不允许复用。
- `name`：英文短名，说明迁移目的。
- `checksum`：迁移内容标识。开发期可用手写标识，发布稳定后不得随意修改。
- `up(db)`：只负责从上一个 schema 版本升级到当前版本。

迁移必须满足：

- 幂等：重复执行不应破坏数据，优先使用 `IF NOT EXISTS`、字段存在检查和唯一键保护。
- 小步提交：一次迁移只做一个清晰主题。
- 不修改历史迁移：已发布迁移只能新增后续版本修正。
- 未发布版本允许收口：只有在目标应用版本和 schema 从未向用户分发时，才允许继续完善该未发布迁移及最新完整 schema；一旦安装包、tag 或正式测试包已交付给外部用户，该 schema 即视为已发布，后续结构变化必须新增版本。
- 避免丢数据：删除字段或重建表前必须写明数据搬迁策略。
- 禁止静默吞错：迁移失败必须抛错，交给启动流程记录失败。

示例：

```ts
{
  version: 7,
  name: "add_report_content_fingerprint",
  checksum: "manual:007-add-report-content-fingerprint",
  up: (db) => {
    const columns = tableColumnNames(db, "reports");
    if (!columns.has("content_fingerprint")) {
      db.exec("ALTER TABLE reports ADD COLUMN content_fingerprint TEXT");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS reports_content_fingerprint_idx
        ON reports(member_id, content_fingerprint)
    `);
  }
}
```

## 启动升级链路

应用安装完成后，服务端首次启动时执行以下流程：

```text
打开 SQLite
  -> 开启 foreign_keys、WAL、busy_timeout
  -> 检查是否为空库
      -> 空库：执行最新 schema，写入全部 migration 记录和应用版本记录
  -> 非空库：读取当前 schema version
      -> 当前版本 > 代码支持版本：拒绝启动，避免降级破坏数据
      -> 当前版本 = 代码支持版本：只检查应用版本记录
      -> 当前版本 < 代码支持版本：
          -> 迁移前备份 SQLite
          -> 按 version 升序执行缺失迁移
          -> 写入 schema_migrations
          -> 写入 app_upgrade_history
          -> 再开放业务页面和后台任务
```

业务中间件必须在数据库检查完成后才继续处理请求。OCR、AI、任务队列等后台任务不得早于迁移完成启动。

## 记录表

`schema_migrations` 记录数据库结构迁移：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`app_upgrade_history` 记录应用版本升级：

```sql
CREATE TABLE app_upgrade_history (
  id TEXT PRIMARY KEY,
  from_app_version TEXT,
  to_app_version TEXT NOT NULL,
  from_schema_version INTEGER NOT NULL,
  to_schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
```

## 备份和失败处理

只要存在待执行数据库迁移，启动流程必须先备份：

```text
storage/backups/db/pre-migration-v{from}-to-v{to}-{timestamp}.sqlite
```

备份前先执行 WAL checkpoint，优先使用 SQLite `VACUUM INTO` 生成一致性备份。迁移失败时：

- 当前启动失败，不继续开放业务 API。
- `app_upgrade_history` 写入 `failed` 和错误信息。
- 保留迁移前备份文件。
- 不自动降级、不自动删除用户数据。

## 开发提交流程

涉及数据库的功能变更必须按下面顺序提交：

1. 修改或新增领域代码。
2. 新增数据库迁移版本。
3. 更新 `schema.ts` 的最新完整 schema。
4. 补充从旧版本升级到新版本的测试。
5. 补充新库初始化测试。
6. 更新 `CHANGELOG.md`，注明数据库 schema 版本变化。
7. 运行验证命令。

验证命令：

```bash
npm test
npm run typecheck
npm run build
npm run pack:app
```

提交前自检：

- 本次是否改了表、字段、索引、约束或结构化数据语义？
- 如果是，是否新增了 migration 版本？
- 是否没有修改已发布 migration？
- 是否有迁移前旧库测试？
- 是否检查了新安装空库？
- 是否确认数据库版本高于当前应用时会拒绝启动？
- 是否在 changelog 写清楚 schema 变化？

## 发布流程

每次发布前检查：

- `package.json` 应用版本正确。
- `template.config.json` 发布说明和应用介绍正确。
- `schemaVersion` 等于迁移注册表最后一个版本。
- `schema_migrations` 中没有断号或重复版本。
- fnOS 包结构校验通过。
- 真机验证新安装和旧版本升级。

应用中心提交说明中需要写明：

- 应用版本。
- 是否包含数据库迁移。
- 迁移目标 schema 版本。
- 是否需要用户提前备份。
- 已验证的升级路径。

示例：

```text
版本 0.1.2
- 数据库 schema: v6 -> v7
- 新增报告内容指纹字段，用于重复报告检测
- 升级前应用会自动备份 SQLite
- 已验证 0.1.0、0.1.1 升级到 0.1.2
```

## 当前项目状态

本轮已撤回机构内趋势相关 UI、接口与自动执行逻辑。v17/v18 已在内部测试环境落库，迁移及表结构保留用于兼容，不回改、不降级，不主动清理已有项目或规则数据。

当前健康档案应用已经建立：

- 当前目标数据库版本为 `v18`；v16 已包含 `ai_extraction_candidates` 等报告提取与治理表。0.2.7（Unreleased）的 v17 保存成员范围内的机构项目及人工关联，v18 新增 `institution_trend_auto_rules` 和 `institution_trend_auto_decisions`，保存主动确认的自动规则及手动解除决定。v17 迁移不回改；v16/v17 升级前自动备份，默认不启用规则、不修改原始指标、不调用外部 AI。旧开发期同编号迁移通过维护流程修复后再执行本轮迁移。
- 形态变化追踪复用 v16 `morphology_findings.tracking_group_id` 和 `match_confidence`，本次闭环不新增表、字段或数据库版本。应用启动仅在本地规则版本变化时幂等重建一次追踪关系，不调用外部 AI；管理员维护操作同样只更新这两个关联字段。
- `schema_migrations`：数据库迁移记录。
- `app_upgrade_history`：应用版本升级记录。
- 启动时数据库版本检查和按需迁移。
- 迁移前 SQLite 备份目录。

后续所有数据库结构变更，都必须新增迁移版本并更新本文档对应流程。
