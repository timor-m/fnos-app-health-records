# API 错误协议与本次实施报告

## 协议与基础设施

共享定义：`packages/shared/api-error.ts`；服务端 H3 helper、兼容与分类：`packages/server/utils/api-error.ts`。

```ts
type ApiErrorPayload = {
  error: true;
  status: number;
  code: ApiErrorCode;
  message: string;
  errorId?: string;
  meta?: Record<string, unknown>;
};
```

新增业务错误可调用 `apiError(status, code, message, meta?)`，内部仍用 H3。现有调用也可以在 `createError` 的 `data.code` 指定分类。H3 v2 会过滤中文 statusText，并把构造参数放在 cause；协议使用 message，兼容适配器的 unhandled 包装。响应只输出协议字段，不直接展开 H3 data、body、stack 或 cause。

`fail(message, meta?)` 保留旧 `ok:false`、`error.message`、meta，同时提供相同的顶层 status/code/message。当前带 HTTP 状态的 fail 调用均传入对应 status；meta.code 可显式覆盖分类。

完整错误码（22 个）：

```text
REQUEST_INVALID REQUEST_BLOCKED
AUTH_REQUIRED AUTH_INPUT_INVALID PERMISSION_DENIED RATE_LIMITED
RESOURCE_NOT_FOUND RESOURCE_CONFLICT
UPLOAD_INVALID UPLOAD_CONFLICT FILE_TOO_LARGE FILE_FORMAT_UNSUPPORTED FILE_DECODE_FAILED
STORAGE_UNAVAILABLE DATABASE_UNAVAILABLE PROCESSING_NOT_READY OCR_UNAVAILABLE
AI_CONFIG_INVALID AI_UPSTREAM_ERROR REMOTE_SERVICE_ERROR PLATFORM_UNAVAILABLE INTERNAL_ERROR
```

HTTP 状态描述协议语义，code 描述故障领域，二者不是一一对应。503 可分别属于数据库、存储、OCR、平台或资源未就绪。分类优先级：显式业务 code → 旧 H3 业务错误 → 高可信系统标识 → INTERNAL_ERROR。旧业务错误保留中文，400/401/403/404/409/410/413/415/422/429 提供有限 fallback；不从 500/502/503 猜业务领域。

## 重点业务变更与映射

| 场景 | 分类及处理 |
| --- | --- |
| multipart 空体、格式异常、解析失败；单文件流中断 | 400 UPLOAD_INVALID，保留已存在的具体中文；解析失败统一提示重新选择文件 |
| requestKey、暂存清单损坏、暂存不完整、重试内容变化 | UPLOAD_CONFLICT；文件上限 FILE_TOO_LARGE；实际格式不支持 FILE_FORMAT_UNSUPPORTED |
| 源文件读取 | 保留“重新选择”提示；明确系统存储故障不再被覆盖为上传冲突 |
| ENOSPC / EDQUOT | 503 STORAGE_UNAVAILABLE，存储空间不足 |
| EACCES / EPERM / EROFS | 503 STORAGE_UNAVAILABLE，检查目录权限或挂载状态 |
| EIO | 503 STORAGE_UNAVAILABLE，存储设备读写异常 |
| EMFILE / ENFILE | 503 STORAGE_UNAVAILABLE，无法继续打开文件 |
| SQLITE_BUSY / LOCKED；精确 database is locked | 503 DATABASE_UNAVAILABLE，数据库繁忙 |
| SQLITE_READONLY / IOERR / CORRUPT | 503 DATABASE_UNAVAILABLE，分别提示不可写、读写异常、状态异常 |
| SQLITE_FULL | 503 STORAGE_UNAVAILABLE，无法保存数据 |
| Node SQLite ERR_SQLITE_ERROR + errcode | 支持基础及扩展数字结果码（低 8 位）；数据库结构与 busy_timeout 保持不变，初始化失败后关闭连接并允许重试 |
| PDF_DECODE_FAILED / IMAGE_DECODE_FAILED / INPUT_FORMAT_MISMATCH | 422 FILE_DECODE_FAILED，分别保留 PDF、图片、格式不匹配的安全中文 |
| 明确 OCR worker 不可用、退出、启动/请求超时、协议等故障 | OCR_UNAVAILABLE；输入解码失败优先归文件错误 |
| AI 地址、Key、模型与配置校验 | AI_CONFIG_INVALID，保留已有中文 |
| AI 上游状态、网络、超时 | AI_UPSTREAM_ERROR，可提供 meta.upstreamStatus；上游 429 不归本应用 RATE_LIMITED |
| 远程指标字典源全部失败 | REMOTE_SERVICE_ERROR，保留安全 SHA-256 校验失败提示，不暴露源错误原文 |
| 飞牛能力缺失或接口不可达 | PLATFORM_UNAVAILABLE；权限拒绝仍为 PERMISSION_DENIED |
| 预览图尚未生成 | 503 PROCESSING_NOT_READY，保留原中文 |
| CSRF 请求来源拒绝 | REQUEST_BLOCKED |
| 未知异常 | 500 INTERNAL_ERROR，固定中文“系统处理异常，请稍后重试；如反复出现，请将错误码反馈给开发者” |

备份采用统一存储分类，去除原错误中的路径、系统原文和无用途的容量探测/步骤变量。诊断包失败保留原始异常给全局分类，不再拼成带底层详情的业务 500。存储维护的旧 fail 响应也具有一致状态和错误码。

后台 OCR/AI 任务的内部码、持久化格式与重试策略不变。在处理任务列表的展示边界，将已识别异常转换为中文及公共错误码；例如内部 IMAGE_DECODE_FAILED 仍供任务逻辑使用，展示 FILE_DECODE_FAILED。补充记录图片处理同样区分解码、OCR 和存储故障。AI 增强测试保留步骤结果结构，失败步骤附公共 code；运行时异常 message 不拼上游响应原文。

## 前端与兼容

`ApiRequestError(message, {status, code, errorId, meta})` 保留所有字段，message 统一拼接：

```text
档案数据库当前繁忙，请稍后重试
错误码：DATABASE_UNAVAILABLE
```

现有 `cause.message` / toast 自动生效，无需重写页面。解析仍兼容 error.message、message、statusText、statusMessage，并支持顶层或 error 对象内的 code/errorId。无 code 的旧服务器保持中文提示，不由前端根据 HTTP 状态推测分类。非 JSON、null、网络中断使用中文，不展示原始代理页面或英文异常。fetch 上传回退 XHR 后的业务异常不会被网络提示覆盖。

全局错误处理器为未预期异常和 HTTP 5xx 生成随机 `errorId`，响应和本地日志使用同一编号；前端在错误码后显示“问题编号”。普通业务 4xx 维持原有提示。日志记录路由模板、状态、公共错误码和受限的原生错误码/SQLite 数字码，不记录 URL 查询、实际动态路径或异常原文；没有匹配路由时记为 `unmatched`。系统日志页面也显示问题编号、路由和系统码，兼容历史 path 字段。中间件阶段抛出的异常同样由全局处理器记录。既有直接返回 `fail()` 的维护响应沿用原协议，没有额外追踪系统或远程日志。

显式迁移覆盖上传、暂存上传、单文件读取、数据库存储前置检查、存储维护、CSRF、AI 配置/测试/模型列表、飞牛接口、远程字典、备份、预览未就绪、本地管理员未初始化和 OCR 设置校验。普通成员/报告/账号的输入、权限、资源不存在与冲突仍通过旧 createError fallback 兼容，不新增资源专属错误码。

## 服务故障恢复

- 数据库连接完成 PRAGMA 和迁移后才供后续请求复用；初始化失败时关闭本次连接，保留原始异常，下一次访问重新初始化。未发布 schema 的维护模式仍可进入原有显式修复流程；该流程迁移失败也会关闭连接。故障未解除时继续拒绝访问，不放行未完成迁移的连接。
- 后台任务的定时续租在回调内捕获数据库异常，记录不包含健康内容的公共错误码，下一次心跳继续尝试。短暂故障不会中断正在运行的 worker；完成、失败、中断后的心跳清理由原有 finally 负责。持续故障仍按原有任务持久化和租约恢复逻辑处理，不增加任务重试次数或更改调度策略。
- 事务异常分支通过 `rollbackAfterError(db)` 尝试回滚，始终由调用方继续抛出原始异常。SQLite 已自动回滚时不会用二次回滚异常覆盖 `SQLITE_FULL` 等原因；升级失败记录写入失败也不会替换原始错误。趋势分组保留局部 SAVEPOINT 回滚，不回滚调用方的外层事务。原有事务边界、SQL 和正常提交顺序保持不变。
- 补充记录保存失败后逐一尝试清理复制文件，清理失败不覆盖业务错误，残留交由既有暂存过期/孤儿文件清理处理。提交后的返回数据读取位于事务清理范围之外，避免读取失败时删除已经提交的图片；原有幂等重试仍可找回保存结果。

回归用例：`packages/server/tests/service-failure-recovery.test.ts`，使用临时数据库、模拟时钟和合成文件，覆盖初始化重试、版本拒绝、维护修复失败恢复、自动回滚、SAVEPOINT 与外层事务、真实 SQLite 容量上限、提交后读取失败，以及任务执行中/结束后恢复存储的路径，共 10 项通过。另用真实 Node 子进程和定时器验证短暂只读故障：进程正常退出，任务完成且 attempts 保持 1。

消融实验：移除初始化保护、回滚保护、续租保护时，对应各 2 项测试重新失败；移除提交后清理边界时，1 项测试重新失败。恢复后 8 项全部通过。最终审查又补充 SAVEPOINT 自动回滚及外层事务保持用例，自动回滚用例在修复前失败。保留现有连接管理和调度流程，只复用一个回滚辅助函数，没有引入新的事务框架、任务状态或恢复队列。应用版本保持 0.2.9、schema 保持 v17，无结构或迁移变更；本轮条目进入无编号 Unreleased，既有发布摘要和部署方式不变。

## 请求可用性与上传修复

- `request-user.ts` 复用同一次请求的身份；fnOS 用户、身份绑定及本人档案已存在且资料未变化时只读。必要的资料/权限同步和初始档案创建仍按事务提交，失败不降级放行。Docker 会话每次新请求仍校验过期、撤销、禁用和角色，仅超过五分钟时更新 last_seen；附带更新时间遇到数据库或存储不可用时不阻断已验证会话。
- 分页 NaN/Infinity、AI 配置的非法对象/数组元素/绑定和通知、提醒的非对象请求返回 400，拒绝保存前完成校验。继续兼容旧 AI 表单及绑定清空语义；复用现有 `isRecord`，未引入通用校验框架。
- 上传先验证成员管理权限与请求编号；存在回执时只读取并计算内容摘要，不创建报告目录。名称、顺序、旋转、来源、成员或文件内容变化仍返回 409，已删除报告也不返回虚假成功。首次上传仍在事务内二次检查回执，保留跨进程竞争保护。
- `withMultipartUpload` 用 Busboy 解析 multipart，以管道背压流式写入存储卷 `uploads/incoming-*`，同时统计真实请求字节和文件字节。报告接口维持单文件 40 MiB、请求 205 MiB；单文件接口请求 42 MiB；备份请求 1 GiB。超限返回 413、断流/格式错误返回 400、写盘失败保留存储分类，等待写流结束后清理临时目录。单文件调用方仍会读取最多 40 MiB 的文件以兼容现有处理接口；不再缓冲整个 multipart。
- 备份先校验管理员权限再读取上传；校验及恢复解压目录复用存储卷 backups 目录，分别使用 `.check-*` / `.restore-*`，避免创建安全备份时误清理。备份校验、恢复前安全备份和身份重绑定流程保留。文件接收成功后仍需要足够空间容纳解压、恢复及安全备份，本次没有改写同步压缩/恢复流程。

新增 `request-resilience.test.ts`、`multipart-upload.test.ts` 及错误日志关联测试，覆盖只读数据库、权限更新、会话撤销/禁用/过期、错误参数不污染配置、只读报告目录下幂等重试、原有 multipart 正常上传、中文文件名、旋转、实际字节超限、断流清理、写盘错误、备份恢复和未授权请求不读流。128 MiB 合成流式接收探针通过，结束后临时目录为空；这不是实际 fnOS/Docker 内存压测。

消融：依次移除身份写入跳过、分页校验、提前读取回执、实际请求字节限制和错误编号后，对应用例均重新失败；恢复后 44 项定向用例通过。删除重复的对象判断，复用现有身份上下文、数据库事务、文件摘要、上传服务和备份目录工具；仅增加三个上传入口共用的 multipart 接收函数及标准解析依赖，没有新增队列、全局身份缓存或追踪框架。

## 测试、消融与边界

新增/扩展测试：

- error-handler：旧状态 fallback、显式 code 优先级、H3 包装、未知异常隐私、文件系统、SQLite 字符串/数字扩展码、解码、OCR、AI 429、循环 cause、fail 兼容。
- upload-api-error：真实 H3 multipart 空体/损坏请求、大小上限、流中断。
- upload.service：处理失败展示公共码且不修改持久化内部码。
- UI api：四种旧提示字段、新旧协议、meta、可见 errorId、非 JSON/null、网络失败。
- AI runtime/settings：保留上游状态分类，公开 message 不含上游原文。
- records：真实目录权限失败返回 503、STORAGE_UNAVAILABLE 且无路径/系统原文，备份清理断言保留。

消融检查：没有引入第二套异常类、错误码到 HTTP 状态的一一映射、页面级错误处理框架或大规模字符串猜测；去除备份专属容量探测和失去用途的步骤跟踪，保留统一分类器后完整回归验证。旧 H3 调用仅添加 data.code 的地方不强制改写为新 helper。

应用版本仍为 0.2.9、schema 仍为 v17；无迁移、tag 或发布。CHANGELOG 当前 Unreleased 已记录。template.config.json 中部署与目标 schema 描述仍准确，未作发布冻结。

本次不全面重构后台任务历史、诊断导出或既有日志；历史数据库中已经保存的旧错误原文不会被批量重写。未知第三方错误、未列入的系统码仍回落 INTERNAL_ERROR，防止误分类。外部代理绕过应用返回的非 JSON 错误没有服务端 code，前端只显示安全中文。未使用真实健康数据或真实付费上游进行故障注入，fnOS 实机挂载、Docker 与真实 OCR/AI 服务联调仍属于部署验收范围。

## 修改文件清单

- `CHANGELOG.md`
- `docs/API_ERRORS.md`
- `packages/server/database/client.ts`
- `packages/server/error-handler.ts`
- `packages/server/middleware/00-archive-storage.ts`
- `packages/server/middleware/00-maintenance.ts`
- `packages/server/middleware/01-csrf.ts`
- `packages/server/routes/api/ai/models.get.ts`
- `packages/server/routes/api/ai/test-enhanced.post.ts`
- `packages/server/routes/api/ocr/settings.put.ts`
- `packages/server/routes/api/uploads.post.ts`
- `packages/server/routes/api/uploads/staged.post.ts`
- `packages/server/services/ai-runtime.service.ts`
- `packages/server/services/ai-settings.service.ts`
- `packages/server/services/auth.service.ts`
- `packages/server/services/diagnostic-export.service.ts`
- `packages/server/services/fnos-open-api.service.ts`
- `packages/server/services/indicator-dictionary.service.ts`
- `packages/server/services/ocr-runtime.service.ts`
- `packages/server/services/records.service.ts`
- `packages/server/services/report-note.service.ts`
- `packages/server/services/staged-upload.service.ts`
- `packages/server/services/upload.service.ts`
- `packages/server/tests/ai-runtime.service.test.ts`
- `packages/server/tests/ai-settings.service.test.ts`
- `packages/server/tests/error-handler.test.ts`
- `packages/server/tests/records.service.test.ts`
- `packages/server/tests/upload-api-error.test.ts`
- `packages/server/tests/upload.service.test.ts`
- `packages/server/utils/api-error.ts`
- `packages/server/utils/api-response.ts`
- `packages/server/utils/read-upload-file.ts`
- `packages/shared/api-error.ts`
- `packages/ui/src/pages/settings/AiSettingsPage.vue`
- `packages/ui/src/types/api.ts`
- `packages/ui/src/utils/api.ts`
- `packages/ui/tests/api.test.ts`

## 最终验证结果

2026-09-21 合并复核发现 `error-handler.ts` 丢失 `node:crypto` 的 `randomUUID` 导入，导致错误处理器自身抛出 ReferenceError。仅补回这一行代码后，文件与合并前暂存记录一致。缺少导入时服务端 752 项通过、21 项失败且类型检查失败；恢复后重新执行 `npm test`，773 项全部通过，`npm run typecheck`、`npm run build` 及暂存/未暂存差异检查均通过。该前后对照确认导入不可省略，无需增加抽象或重复测试；版本及 schema 不变，未重新进行实机部署验证。

2026-09-20 独立复验及构建产物 HTTP 检查见 [服务异常修复测试报告](./SERVICE_ERROR_TEST_REPORT_2026-09-20.md)。该报告同时记录了非默认部署组合下新发现的首次改密路径兼容问题及尚未覆盖的实机范围。

- `npm test`：773 通过，0 失败（含两轮服务异常修复回归）。
- `npm run test:ui`：5 个测试文件，22 通过，0 失败。
- `npm run typecheck`：通过。
- `npm run build`：Vite 与 Nitro 均通过；Vite 有 chunk 大小提示，无构建失败。
- `git diff --check`：通过。
- lint：package.json 未配置 lint 脚本，未执行。
- 未进行正式发布检查、FPK 打包或容器部署；本次没有发布授权，版本和迁移不变。

最终审查发现并处理了：multipart 裸 500、备份路径和系统原文泄露、AI/飞牛上游原文透传、OCR 设置 catch 将系统错误转成输入错误、维护 fail 缺少分类、上传 XHR 回退遮蔽业务错误。新增用例验证 AI 429 与 PDF/图片解码分类不会混淆。治理后的 HTTP 错误统一具有公共错误码；业务成功响应中的历史任务诊断仍保留原有内部结构，不能据此宣称整个历史数据/诊断日志系统已完成全面敏感信息审计。

### 成员共享与恢复预检（0.2.10 Unreleased）

新增 `MEMBER_MANAGE_REQUIRED`、`MEMBER_SHARE_REQUIRED`（403），`MEMBER_LAST_MANAGER`、`MEMBER_PERMISSION_CONFLICT`、`RESTORE_PLAN_EXPIRED`（409）。成员/报告资源路径对不存在和完全无访问权限统一返回 404 `RESOURCE_NOT_FOUND`，避免猜测资源是否存在；已有查看权限但不能修改仍返回 403。授权冲突刷新成员权限后重试；恢复预检失效需重新预检并明确确认，不能自动重新恢复。


## 回收站文件清理状态

`GET /api/reports/trash-cleanup?memberId=...` 复用成员管理权限校验及统一错误协议。401/403/资源不可访问时前端清空管理状态并停止重试；数据库查询失败返回规范错误，不返回假零值；全局存储维护拦截继续生效。响应使用 `Cache-Control: private, no-store`。

成功查询的 `reasonCode` 是运行状态原因而非 API 错误码：`STORAGE_UNAVAILABLE`、`STORAGE_MIGRATION`、`SCHEDULE_UNKNOWN`、`SCHEDULE_OVERDUE`、`MAINTENANCE_RUNNING`、`MAINTENANCE_FAILED`、`FILE_RETRY`。只映射固定安全中文文案，不返回 `last_error`、路径或异常堆栈。详见 [清理状态口径](TRASH_CLEANUP.md)。

## 补充报告页 API

`POST/GET reports/:id/page-appends` 创建批次/查询本人最近批次；`POST page-appends/import` 使用现有授权目录导入；`GET/DELETE page-appends/:batchId` 查询/放弃未发布批次。子路径 `files/:fileId` POST 单文件，`pages/:pageId` GET 私有预览，`submit`、`confirm`、`retry` POST 提交选页、确认冲突和重试；retry 的 keepOcr=true 可结束已发布但失败的识别。所有操作要求当前成员管理权限并绑定原账号。

非法清单返回 400 UPLOAD_INVALID；重复键但载荷不一致、并发冲突或失效版本返回 409 UPLOAD_CONFLICT；无权访问返回 403 或对资源路径统一隐藏为 404。未发布页不会从正式原件接口读取。批次失败通过 state/error 返回安全说明，保留旧结果；不可把 HTTP 提交成功显示成 AI 已完成。
