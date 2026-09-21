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
| Node SQLite ERR_SQLITE_ERROR + errcode | 支持基础及扩展数字结果码（低 8 位）；不改数据库结构、连接或 busy_timeout |
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

errorId 仅存在于共享响应类型、UI 类型和 ApiRequestError 中。当前服务端不生成或输出，前端可解析未来字段但不显示；没有新增远程日志、日志上传或追踪系统。继续使用现有 writeLog 脱敏与轮转，请求日志中间件不变；全局日志保留分类与堆栈帧，省略可能夹带报告或上游原文的异常 message。

显式迁移覆盖上传、暂存上传、单文件读取、数据库存储前置检查、存储维护、CSRF、AI 配置/测试/模型列表、飞牛接口、远程字典、备份、预览未就绪、本地管理员未初始化和 OCR 设置校验。普通成员/报告/账号的输入、权限、资源不存在与冲突仍通过旧 createError fallback 兼容，不新增资源专属错误码。

## 测试、消融与边界

新增/扩展测试：

- error-handler：旧状态 fallback、显式 code 优先级、H3 包装、未知异常隐私、文件系统、SQLite 字符串/数字扩展码、解码、OCR、AI 429、循环 cause、fail 兼容。
- upload-api-error：真实 H3 multipart 空体/损坏请求、大小上限、流中断。
- upload.service：处理失败展示公共码且不修改持久化内部码。
- UI api：四种旧提示字段、新旧协议、meta、隐藏 errorId、非 JSON/null、网络失败。
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

- `npm test`：751 通过，0 失败。
- `npm run test:ui`：5 个测试文件，22 通过，0 失败。
- `npm run typecheck`：通过。
- `npm run build`：Vite 与 Nitro 均通过；Vite 有 chunk 大小提示，无构建失败。
- `git diff --check`：通过。
- lint：package.json 未配置 lint 脚本，未执行。
- 未进行正式发布检查、FPK 打包或容器部署；本次没有发布授权，版本和迁移不变。

最终审查发现并处理了：multipart 裸 500、备份路径和系统原文泄露、AI/飞牛上游原文透传、OCR 设置 catch 将系统错误转成输入错误、维护 fail 缺少分类、上传 XHR 回退遮蔽业务错误。新增用例验证 AI 429 与 PDF/图片解码分类不会混淆。治理后的 HTTP 错误统一具有公共错误码；业务成功响应中的历史任务诊断仍保留原有内部结构，不能据此宣称整个历史数据/诊断日志系统已完成全面敏感信息审计。
