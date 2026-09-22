# 版本与数据库迁移落地规范

本文档定义健康档案应用的版本发布、本地 SQLite 数据库迁移和提交变更流程。凡是功能迭代涉及数据库表、字段、索引、约束或结构化数据含义变化，都必须按本文档补充迁移记录。完整应用发布步骤见 [应用发布与数据库升级流程](./RELEASE_PROCESS.md)。

## 目标

- 发布授权是版本事务的前提：只有用户明确“开始发版”才递增应用或 schema 编号、冻结版本并执行发布；日常开发和内部测试不触发升版。
- 应用升级可追踪：记录应用从哪个版本升级到哪个版本。
- 数据库按需迁移：结构或语义变化先维护未发布迁移草案，在用户授权发布时统一确定 schema 编号。
- 启动前完成迁移：应用首次启动时先检查版本差异，迁移成功后再开放业务 API 和页面。
- 失败可恢复：迁移前自动备份 SQLite，迁移失败时停止进入应用，保留错误信息。
- 提交流程可检查：数据库变更必须带迁移脚本、测试和变更说明。

## 版本模型

应用版本和数据库版本分开管理。

| 类型 | 来源 | 递增条件 | 示例 |
| --- | --- | --- | --- |
| 应用版本 | 根目录 `package.json` | 任意发布版本 | `0.1.0` -> `0.1.1` |
| 数据库版本 | `packages/server/database/migrations.ts` | 表结构、索引、约束、数据语义变化 | schema v6 -> v7 |

应用版本升级不一定触发数据库迁移。例如只调整 UI、文案、图标或打包配置时，开发阶段仅更新代码和 changelog；用户授权发布后才处理应用版本，不提升 schema 版本。

## 数据库变更判定

以下变更必须准备数据库迁移，但不在每次开发时新增编号；用户授权发布时统一整理相对上一正式发布基线的迁移：

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
- 未发布版本允许收口：同一未发布迭代可继续完善迁移草案及最新完整 schema，不按功能累加编号；构建或测试包不自动等于正式发布。若测试库已落库，收口前必须设计保留数据的兼容路径，不得直接降号、删记录或清库。正式发布后的 migration 保持不可变。
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
2. 开发阶段维护本轮迁移草案；只有用户明确开始发版后才统一整理并确定迁移版本。
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
- 如果是，是否准备了迁移草案，并仅在获得发布授权后确定 migration 编号？
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

当前迭代版本为 0.2.10（Unreleased，尚未冻结或发布），本轮包含成员共享与恢复身份的未编号结构草案，目标数据库版本保持 **v17**，本轮不新增迁移编号。补充记录（`report_notes`）、补充附件（`report_note_assets`）和趋势分组关联表（`indicator_groups`、`indicator_group_members`）通过启动期幂等补表应用，补表前自动备份；v17 及以前正式迁移不变，早期测试库缺表时先备份再幂等补齐。

本轮已撤回机构内关联 UI、接口与自动规则执行逻辑；兼容表保留，不主动清理已有项目或规则数据。发版前内部测试库的 v17-v19 草案记录会进入维护修复流程，备份后按正式结构幂等补齐，不自动降号、删除历史或清库。

当前健康档案应用已经建立：

- v17 正式迁移保持不变；本轮新增的补充记录、附件和趋势分组结构不入迁移注册表，由启动期补表幂等应用，历史内部测试包落库的草案记录通过维护修复或幂等补表兼容。
- 形态变化追踪复用 v16 `morphology_findings.tracking_group_id` 和 `match_confidence`，本次闭环不新增表、字段或数据库版本。应用启动仅在本地规则版本变化时幂等重建一次追踪关系，不调用外部 AI；管理员维护操作同样只更新这两个关联字段。
- `schema_migrations`：数据库迁移记录。
- `app_upgrade_history`：应用版本升级记录。
- 启动时数据库版本检查和按需迁移。
- 迁移前 SQLite 备份目录。

后续数据库结构变更必须维护迁移草案及测试，不自动追加编号；仅在用户明确开始发版后统一处理版本事务。若其他测试环境运行过更高版本草案，应先备份并单独确认兼容处理，不能直接降号或清库。


## 成员共享与恢复身份草案（Issues #38 / #42）

`database/member-sharing-draft.ts` 增量补齐共享能力、授权版本、账号本人/默认偏好、个人隐藏和源身份待映射表。新库与旧库统一调用，schema 注册编号仍为 v17，v17 及以前迁移文件未修改。旧库缺少共享字段时先创建迁移前快照，再在保存点内完成字段及一次性历史回填；再次启动不覆盖之后的选择和权限。仅已授权、有效 manager 创建者回填共享能力；唯一本人候选回填关联，多候选标记 pending，零候选不创建档案。不降号、不删迁移历史、不清库。

应用内完整备份包含这些表；源部署标识写入 manifest，目标部署锚点放在运行根目录并在恢复中保留。使用方式见 [成员共享](./MEMBER_SHARING.md)、[备份恢复](./BACKUP_RESTORE.md) 和 [身份维护](./IDENTITY_RECOVERY.md)。本轮不发版、不推送、不操作真实用户数据库。

本轮简化账号授权后，新库不再创建共享标识字段。曾安装早期未发布草案的数据库可能保留 `account_preferences.share_lookup_code`，业务不再读取或返回该字段；保留原列及默认值以兼容旧备份，不重建表、不删除偏好或健康数据，也不修改已发布迁移。


### 回收站文件清理成员归属草案

新增未编号 `file-gc-members-draft.ts`，由 schema 初始化同时覆盖新库和旧库，旧库缺表时先备份。只建立队列与成员的联合唯一关联和成员索引，不复制队列、不回填未知历史归属。应用 0.2.10 / schema v17 保持不变，已发布迁移未修改。升级及生命周期说明见 [回收站与关联文件清理](TRASH_CLEANUP.md)。

## Issue #40 未编号草案

新增 `page-append-draft.ts`，包含补充批次、文件、草稿页、指标来源抑制记录及并发约束。应用 0.2.10 / schema v17 不变，不修改已发布迁移。已有库安装草案前备份，恢复库通过同一 schema 初始化补齐；发布授权后相对正式基线统一整理编号。草稿内文件受备份、存储迁移和 GC 引用保护，详见 [补充报告页](REPORT_PAGE_APPEND.md)。
