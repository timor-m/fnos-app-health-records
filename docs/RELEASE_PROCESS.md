# 应用发布与数据库升级流程

本文档定义健康档案应用从功能开发、版本准备、fnOS 打包、安装升级到数据库迁移落库的完整流程。数据库迁移的底层规范见 [版本与数据库迁移落地规范](./VERSION_MIGRATION.md)。

## 当前版本关系

应用发布版本和数据库 schema 版本存在发布绑定关系：每一个应用版本都必须声明自己支持的目标数据库版本。但二者不是一一递增关系，应用版本可以升级而数据库版本不变。

| 项 | 当前值 | 来源 |
| --- | --- | --- |
| 应用 ID | `fnos-app-health-records` | `template.config.json` |
| 应用版本 | `0.2.13` | `package.json` |
| fnOS manifest 版本 | `0.2.13` | `scripts/prepare-package.mjs` 从 `package.json` 写入 |
| fnOS sub_version | `0.2.13.0` | `scripts/prepare-package.mjs` 生成 |
| Docker 镜像版本 | `0.2.2`、`v0.2.2` | GitHub Tag 工作流从 `package.json` 生成 |
| Docker 镜像仓库 | `docker.io/timorm/fnos-app-health-records` | Docker Hub，可通过 `DOCKERHUB_IMAGE` 覆盖 |
| 数据库 schema | `v16` | `packages/server/database/migrations.ts` 最后一个迁移版本 |
| 数据库记录表 | `schema_migrations`、`app_upgrade_history` | 服务端首次启动时初始化或迁移 |

发布前必须确认：当前应用版本支持的目标 schema 版本明确、可初始化新库、可从上一发布版本迁移。

当前 `0.2.0` 的目标数据库版本为 v16。v16 包含指标字典运行时、独立形态发现表、分类专属领域表、报告专属章节表、AI 解析单元/尝试表和 AI 提取候选追踪表；开发期的 v17-v19 仅存在于预发布阶段，已折叠回 v16 并在启动时幂等补齐。发布 v16 安装包、tag 或对外测试包后，v16 即冻结；此后任何表、字段、索引或约束变化都必须新增 v17。

## 记录什么时候建立

迁移记录分为“代码记录”和“用户设备落库记录”。

代码记录在开发阶段建立：

- 开发者修改数据库结构时，在 `packages/server/database/migrations.ts` 新增迁移版本。
- 同步更新 `packages/server/database/schema.ts` 的最新完整 schema。
- 补充测试和 changelog。
- 这些记录随代码一起打进 `.fpk`，此时还没有写入用户设备 SQLite。

用户设备落库记录在服务端首次启动时建立：

- fnOS 安装向导只保存服务端口，不执行数据库迁移。
- fnOS 升级回调目前不执行数据库迁移。
- 应用服务启动后，`packages/server/middleware/01-database.ts` 调用 `getDatabase()`。
- `getDatabase()` 打开 SQLite，检查当前 schema 版本，并在业务 API 和后台任务可用前完成初始化或迁移。
- 空库会一次性创建最新 schema，并写入全部 `schema_migrations` 和一条 `app_upgrade_history`。
- 旧库会先备份，再按缺失版本顺序迁移，最后写入迁移记录和应用升级记录。

所以发布包里携带的是“可执行迁移计划”，真正的迁移记录是在用户安装或升级后第一次启动应用时写入本地 SQLite 的。

## 发布类型

### 普通功能发布

适用于 UI、交互、接口逻辑、OCR/AI prompt、打包配置等不改变数据库结构和持久化语义的变更。

要求：

- 更新 `package.json` 版本。
- 更新 `CHANGELOG.md`。
- 更新 `template.config.json` 的 `releaseNotes`。
- 不提升数据库 schema 版本。
- 仍要验证新安装和旧版本升级后可启动。

示例：

```text
应用 0.1.1
schema 仍为 v6
无数据库迁移
```

### 数据库变更发布

适用于新增表、字段、索引、约束或改变结构化数据语义的变更。

要求：

- 更新 `package.json` 版本。
- 在 `migrations.ts` 新增 schema 版本。
- 更新 `schema.ts` 最新完整 schema。
- 更新 `CHANGELOG.md`，写明 schema 变化。
- 更新 `template.config.json` 的 `releaseNotes`。
- 增加迁移测试，覆盖旧版本库升级到新版本库。
- 真机验证旧版本升级。

示例：

```text
应用 0.1.2
schema v6 -> v7
新增 indicator_catalog、indicator_aliases、observation_normalizations
升级前自动备份 SQLite
```

### 紧急修复发布

适用于线上缺陷修复。原则上只修改必要代码。

要求：

- 如无数据库变化，不新增迁移。
- 如必须修复错误迁移，不修改已发布迁移文件，新增下一个 schema 版本进行修正。
- 发布说明明确影响范围和是否涉及数据库。

## 跨版本升级

跨版本升级必须支持。例如用户长期停留在 `0.0.1`，中间错过多个应用版本和多个数据库 schema 版本，直接升级到最新版本时，应用不能依赖“逐个安装历史应用版本”，而应该只依赖本地数据库当前 schema 版本。

正确链路：

```text
用户当前应用 0.0.1 / 数据库 schema v1
  -> 直接安装最新应用 0.3.0 / 目标 schema v9
  -> 首次启动读取当前 schema v1
  -> 迁移前备份 SQLite
  -> 顺序执行 v2、v3、v4、v5、v6、v7、v8、v9
  -> 写入 schema_migrations 和 app_upgrade_history
  -> 正常进入应用
```

因此发布版本必须保留所有历史迁移脚本。只要用户数据库版本低于当前应用支持版本，启动流程就按版本号顺序补齐缺失迁移。

跨版本升级禁止事项：

- 禁止删除历史 migration。
- 禁止修改已发布 migration 的含义。
- 禁止让迁移依赖某个中间应用版本曾经启动过。
- 禁止只测试“上一版本 -> 当前版本”。
- 禁止用应用版本推断数据库结构，必须以 `schema_migrations` 为准。

允许的处理：

- 很老的历史库如果没有 `schema_migrations`，需要在启动迁移器中识别基线版本。
- 如果历史版本存在错误 schema，新增后续修复迁移，不回改旧迁移。
- 如果某个历史版本没有写入应用版本记录，`app_upgrade_history.from_app_version` 可以为空，但 schema 迁移仍必须继续。

跨版本发布验证至少覆盖：

- 最早公开版本数据库 -> 最新版本。
- 上一个正式版本数据库 -> 最新版本。
- 中间任一包含数据库变化的版本 -> 最新版本。
- 缺少 `schema_migrations` 的早期开发库 -> 最新版本，如果这个版本曾经对外发布或已有用户数据。
- 高版本数据库 -> 低版本应用，必须拒绝启动。

## 开发阶段流程

1. 确认本次变更是否影响数据库。
2. 如果影响数据库，先设计迁移策略，包括历史数据如何处理、失败如何回滚、是否需要重建表。
3. 修改业务代码和数据访问代码。
4. 新增或更新迁移注册表。
5. 更新最新 schema。
6. 补充测试。
7. 更新文档和 changelog。

数据库变更自检：

- 是否新增了唯一递增的 migration version？
- 是否没有修改已发布 migration？
- 是否能从上一发布 schema 升级？
- 是否能新安装空库？
- 是否有迁移前备份？
- 是否没有把身份证、电话、住址写入结构化字段、搜索索引、日志或 AI 摘要？

## 版本准备流程

发布前修改：

1. 提交功能代码
   - 发布前先提交本次功能、修复和文档改动。
   - `pnpm release` 会要求工作区干净，避免把未确认改动混进版本提交。
2. `CHANGELOG.md`
   - 先在当前未发布章节写清楚变更内容。
   - 发布后版本章节会冻结为 `## x.y.z`；下一个 `## x.y.z - Unreleased` 只承载下一版本的新内容，不会沿用已发布版本的条目。
   - 写明是否包含数据库迁移。
   - GitHub Release 的“本版本变更”会直接读取当前发布版本对应的 `CHANGELOG.md` 段落，发布前必须把用户可感知的功能、修复和升级注意事项写完整。
3. `template.config.json`
   - 更新 `releaseNotes.summary`。
   - 更新 `releaseNotes.highlights`。
   - 确认 `appDescription`、分类、维护者、最低系统版本准确。
4. `docs/VERSION_MIGRATION.md`
   - 如果迁移策略有变化，同步更新。
5. `docs/RELEASE_PROCESS.md`
   - 如果发布流程或 fnOS 生命周期脚本变化，同步更新。
6. 本地执行 `pnpm release`
   - 交互选择版本类型。
   - 同步 `package.json`、`package-lock.json` 和本文档当前版本关系。
   - 执行 `release:ci` 完整构建校验。
   - 创建版本提交 `chore: release vX.Y.Z`。
   - 创建 tag `vX.Y.Z`。

版本绑定表必须在发布说明中体现：

```text
应用版本：0.1.2
目标 schema：v7
数据库迁移：是，v6 -> v7
自动备份：是
验证路径：0.1.0 -> 0.1.2、0.1.1 -> 0.1.2
```

## 验证流程

本地构建验证：

```bash
npm run release:ci
```

必须检查：

- `npm run release:ci` 通过。
- 该命令会依次执行发布元数据校验、数据库迁移校验、单元测试、类型检查、fnpack 下载、构建、包结构校验和 `.fpk` 打包；最终安装包按 `fnos-app-health-records-<package.version>.fpk` 命名。
- `.fnos-build/package/manifest` 中 `version` 与 `package.json` 一致。
- `.fnos-build/package/manifest` 中 `sub_version` 符合预期。
- `ICON.PNG`、`ICON_256.PNG`、`ICON_512.PNG` 尺寸正确。
- 安装向导只包含服务端口配置。
- 升级回调不误删数据。

数据库专项验证：

- 空数据目录启动，检查新库 schema 版本等于目标版本。
- 旧版本数据库启动，检查自动备份文件生成。
- 旧版本数据库启动，检查 `schema_migrations` 写入缺失版本。
- 旧版本数据库启动，检查 `app_upgrade_history` 写入 completed。
- 构造高版本数据库，确认当前应用拒绝启动。
- 迁移失败时，确认保留备份并写入 failed 记录。

Release notes 预览：

```bash
npm run release:notes
```

该命令会读取 `CHANGELOG.md` 当前版本段落、`template.config.json` 的发布摘要/亮点和数据库迁移注册表，生成与 GitHub Release 一致的 Markdown。若当前 `package.json` 版本没有对应的 changelog 段落，命令会失败，避免发布页缺少本版本变更说明。

自动化校验与发布：

- GitHub CI 在 push 和 pull request 时执行 `npm run release:ci`。
- GitHub Release 在 tag 或手动触发时执行严格发布校验、测试和打包；tag 版本必须与 `package.json` 版本一致。
- Release notes 会自动读取 `CHANGELOG.md` 当前版本段落、`package.json`、`template.config.json` 和迁移注册表，输出本版本变更、应用版本、应用 ID、目标 schema 和数据库升级说明。
- 包结构校验会确认 manifest 版本、sub_version、应用介绍、changelog 和图标尺寸。
- `vX.Y.Z` Tag 先构建 fnOS `.fpk`，再通过 Buildx 发布 `linux/amd64`、`linux/arm64` 的 GHCR 多架构镜像，最后创建同时包含 `.fpk`、镜像地址和 digest 的 GitHub Release。
- Docker 镜像标签包含精确版本 `X.Y.Z`、`vX.Y.Z`、`X.Y` 和短提交 SHA；稳定版本额外更新 `latest`。镜像版本与 `.fpk` 版本都只取自同一个 `package.json`。
- 镜像发布启用 OCI 源码、版本、许可证标签、SBOM 和 GitHub Actions provenance。发布前应确认仓库 Packages 权限允许 Actions 写入 GHCR。

本地完整发布：

```bash
pnpm release
```

`pnpm release` 只在本地使用。它会完成版本选择、版本文件更新、构建校验、版本提交和 tag。推送到 GitHub 后，Actions 不再处理版本和 tag，只根据已推送的 tag 构建 Release 产物。

fnOS 真机验证：

- 新安装可启动。
- 从上一版本升级可启动。
- 端口配置保留。
- 数据目录保留。
- 报告列表、详情、原图、OCR/AI 任务正常。
- 应用停止后可恢复。
- 卸载选择“保留数据”时数据保留。
- 卸载选择“删除数据”时数据清理。
- “我的 -> 备份与恢复”可创建、下载、校验、上传外部备份恢复和删除完整应用备份；恢复前会自动生成安全备份，恢复后提示刷新或重新打开应用。

Docker 发布验证：

- 空数据卷默认使用 `admin/admin` 初始化本地管理员，首次登录强制修改密码；管理员重置账号后使用临时密码 `admin`，下次登录再次强制修改。
- 容器进程使用非 root 用户，`/data` 卷可写，重启和重建容器后数据与 OCR 环境保留。
- 匿名请求和伪造 `X-Trim-*` 请求不能获得成员或管理员权限，登录限流、CSRF、退出和会话过期行为正常。
- `/healthz` 健康检查正常，根路径 UI、上传、备份下载与恢复可直接访问。
- 固定版本升级后数据库迁移正常；回滚测试使用独立卷或升级前备份，不直接覆盖生产卷。
- 在 `linux/amd64`、`linux/arm64` 真机分别完成 OCR 安装和最小识别测试。
- Docker 安装和运维步骤见 [Docker 部署](./DOCKER_DEPLOYMENT.md)。

## 打包流程

当前打包链路：

```text
npm run build
  -> 构建前端 .ui-dist
  -> 构建服务端 .server-dist
npm run prepare:package
  -> 生成 .fnos-build/package
  -> 写入 manifest/version/sub_version
  -> 复制服务端、UI、OCR worker、图标和生命周期脚本
npm run pack:app
  -> 生成 dist/app.tgz
  -> 回写 manifest checksum
  -> 校验 fnOS 包结构
npm run pack:fpk
  -> 使用 fnpack 生成 dist/fnos-app-health-records-<version>.fpk
```

注意：

- `prepare-package` 不执行数据库迁移。
- `pack:app` 不执行数据库迁移。
- `.fpk` 安装完成后，数据库迁移在服务端首次启动时执行。

## 应用中心提交内容

提交应用中心前，发布说明必须包含：

- 应用名称和版本。
- 适配 fnOS 最低版本。
- 主要新增功能。
- 是否包含数据库迁移。
- 目标 schema 版本。
- 是否自动备份 SQLite。
- 已验证升级路径。
- 已知风险或兼容说明。

示例：

```text
健康档案 0.1.2

新增：
- 增加重复报告内容指纹。
- 优化报告详情页处理状态。

数据库：
- 目标 schema v7。
- 从 schema v6 自动迁移到 v7。
- 迁移前自动备份 SQLite 到 backups/db。

验证：
- 已验证新安装。
- 已验证 0.1.0、0.1.1 升级到 0.1.2。
- 已验证保留数据卸载后重新安装。
```

## 发布后检查

发布安装后检查：

- 进入“我的 -> 运行与识别”，确认数据库状态为“正常”。
- 确认 schema 版本为目标版本。
- 检查数据目录占用显示正常。
- 进入“我的 -> 备份与恢复”，创建一份完整备份，确认文件名包含应用标识、`backup` 和时间戳，并可下载和校验；恢复测试前保留当前数据快照，验证已有备份恢复与外部备份上传恢复都会先生成安全备份。
- 上传一份图片报告，确认任务、OCR、AI 和通知正常。
- 从旧数据升级时，确认历史报告可打开，原图可查看。
- 检查日志中无启动迁移错误。

如果用户反馈升级失败，优先收集：

- 应用版本。
- 目标 schema 版本。
- 当前数据库 `schema_migrations` 最大版本。
- `app_upgrade_history` 最近一条记录。
- `TRIM_PKGVAR/info.log` 中启动错误。
- `storage/backups/db` 中最近备份文件。
- 如果用户执行过完整备份或恢复，收集 `storage/backups/full` 中对应备份文件名和恢复前安全备份 ID。

## 禁止事项

- 禁止为了修复问题直接修改用户 SQLite。
- 禁止修改已发布 migration 的含义。
- 禁止跳过迁移测试直接发布。
- 禁止在安装回调中执行耗时数据库迁移。
- 禁止在迁移失败后继续启动 OCR/AI 后台任务。
- 禁止自动降级数据库。
