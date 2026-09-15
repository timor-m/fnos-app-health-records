# 报告补充记录

报告详情 → 报告原件下方 → **补充记录** → **添加**。

## 使用

- 一份报告可持续追加多条记录；支持纯文字、纯图片、图文组合，不允许空记录。
- 每条最多 10000 字、9 张图片，每张最多 40 MB；支持 JPEG、PNG、WebP、HEIC/HEIF。
- 图片可通过文件选择、触屏照片选择或桌面拖入添加。按张上传并显示进度；失败项可单独重试，保存失败不会清空编辑内容。
- 编辑时可修改文字、添加/移除图片、前后排序；点击缩略图可缩放、翻页和下载原图。
- 查看者只能查看记录及图片；管理者可维护。权限继承报告所属成员，每次请求重新校验；回收站报告只能查看，恢复后可编辑。
- 删除记录需要确认，采用软删除，图片随报告彻底删除进入文件清理队列。第一版没有单独的记录恢复入口；需要恢复时可使用删除前的完整备份。
- 单独移除附件会进入现有延迟清理队列（默认 10 分钟），文件暂时存在不代表仍可通过接口读取。

补充记录是用户提供的资料，不属于报告原件；不会生成报告页面、OCR / AI 任务、指标、诊断、用药或形态发现。药品识别等未来功能本次不实现。

## 图片环境

复用当前本地图片处理环境中的缩略图与 HEIC 解码能力，只执行图片渲染，不执行文字识别。没有安装图片处理环境时仍可保存文字，图片上传会明确提示处理失败；请到运行环境设置安装或修复本地 OCR 环境后重试。

HEIC 原图保留原始格式，同时生成浏览器可读的 JPEG 预览；浏览器下载时仍取得 HEIC 原文件。普通图片直接使用原图预览。附件尺寸字段暂为空，不把缩略图尺寸误当成原图尺寸。

## 存储与生命周期

```text
<当前档案存储目录>/report-notes/<报告 ID 哈希>/<记录 ID>/
  original/     随机附件 ID 命名的原图
  thumbnails/   JPEG 缩略图
  previews/     HEIC 的 JPEG 预览
```

文件名、SHA256、大小、类型和顺序保存在附件表。客户端不能指定存储路径；图片须通过有成员权限的接口访问，不提供匿名静态地址。

上传暂存复用 `upload-staging`，按当前用户与随机上传凭据隔离，跨报告不可复用。保存成功后正式文件独立保存，暂存载荷进入延迟清理队列；元数据短期保留以支持丢失响应后的幂等重试。未保存暂存目录在后续上传时按 7 天过期策略清理。

完整备份包含两张表、原图、缩略图、HEIC 预览及其校验和。恢复旧版不含补充记录的备份时，默认恢复为零条记录；恢复新版备份可继续访问图片。fnOS 档案迁移与旧副本校验清理包含 `report-notes`；Docker 自动跟随已有 `/data` 映射，不增加专属设置。

审计操作：`report.note.create/update/delete`、`report.note.asset.upload/delete`。只记录操作者、时间、报告/记录 ID 和附件数量，不记录正文、原文件名或图片内容。

## 数据库与接口

新增 `report_notes` 和 `report_note_assets`，通过外键关联报告、记录和创建者；报告彻底删除级联删除数据，应用先将附件加入文件清理队列。已有报告、原件和提取结果不改写。

当前以 `packages/server/database/report-notes-draft.ts` 保存未编号的增量结构，并接入完整 schema。旧库缺表时先备份再幂等补齐，已有迁移不修改。当前应用 0.2.8、schema v17 不因本功能递增；正式发布前必须统一为本轮结构变化编号，并验证正式旧版本升级。

以下路径均在当前部署环境的 `/api` 前缀下：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/reports/:id/notes` | 时间顺序的记录列表及 `canManage` |
| POST | `/reports/:id/notes` | 保存新记录；稳定客户端 ID 支持幂等重试 |
| PATCH | `/reports/:id/notes/:noteId` | 更新文字和完整有序附件清单；校验 `updatedAt` 防止覆盖并发编辑 |
| DELETE | `/reports/:id/notes/:noteId` | 软删除记录 |
| POST | `/reports/:id/notes/uploads` | 单张 multipart `file` 暂存及图片渲染 |
| GET | `/reports/:id/notes/uploads/:token` | 上传者自己的暂存预览，`variant=original` 下载原图 |
| GET | `/reports/:id/notes/:noteId/assets/:assetId` | `variant=thumbnail/preview/original`，每次验证权限 |

保存请求的 `assets` 为 `{ id }`（保留的附件）或 `{ uploadToken }`（已上传图片）的有序数组，未保留的原附件视为移除。正文通过普通文本呈现，不渲染用户 HTML。

## 验证与边界

- 服务测试：旧库补表备份、索引/外键、文字与图片 CRUD、排序、权限变化、非法 MIME/文件大小/路径、重复图片、并发编辑、重试、文件清理、回收站及备份恢复。
- UI 逻辑测试：空记录、文件选择限制、上传重试、保存失败保留输入、编辑及排序请求、共享查看器与响应式结构。
- 本地浏览器用独立合成数据验证 PC、390px 窄屏与短视口：新增、四种真实图片格式、预览翻页、图文编辑、移除图片、删除确认。
- 命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run validate:release`、`git diff --check`。
- 未进行本轮 fnOS 真机安装、Docker 容器、实际手机软键盘和摄像头回归；本地短视口仅验证保存区域的布局，不能替代实机键盘测试。

本次只保留记录面板和编辑器两个组件，复用现有查看器、确认弹窗、上传传输、图片渲染、成员权限和文件清理；未增加通用资源备注框架、单独的权限体系、识别队列或报告列表装饰。

## 实现文件索引

| 范围 | 文件 |
| --- | --- |
| 数据结构 | `packages/server/database/report-notes-draft.ts`、`schema.ts`、`client.ts` |
| 领域与接口 | `packages/server/services/report-note.service.ts`、`packages/server/routes/api/reports/[id]/notes*` |
| 共享类型与限制 | `packages/shared/report-notes.ts`、`upload-limits.ts` |
| 上传复用 | `packages/server/utils/read-upload-file.ts`、原有 staged 文件上传路由、`upload.service.ts`、前端 `utils/api.ts` |
| 生命周期 | `records.service.ts`、`file-gc.service.ts`、`storage-migration.service.ts` |
| 页面与样式 | `ReportNotesPanel.vue`、`ReportNoteEditor.vue`、`ReportDetail.vue`、`styles.css` |
| 回归测试 | `report-note.service.test.ts`、`report-note-ui.test.ts`、`storage-migration.test.ts` |
| 文档与发布摘要 | 本文、`README.md`、`CHANGELOG.md`、`template.config.json` |

2026-09-14 本地验收：全量 663 项测试通过；类型检查、前后端构建、发布/迁移/字典校验及差异空白检查通过。未运行 FPK 打包或 Docker 镜像构建，本次没有发布、升版、tag 或提交操作。
