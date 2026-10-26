# 健康档案

健康档案，记录一家人的健康变化，串联每一次就医前后。平时记下症状、用药与接种，就诊时带齐资料，检查后对比报告，复查时接上后续——从日常记录到就医回顾，让每段健康历程都有据可查。

支持 fnOS 和 Docker 自主部署，OCR 与 AI 按需开启。AI 辅助整理资料，不替代医生诊断或治疗建议。

## 功能介绍

### 健康记录

- **报告归档与识别**：拍照上传、导入 HEIC 或多页 PDF，也可从 NAS 批量导入；按需用 OCR/AI 整理日期、结论、指标和用药，原件一并保留。
- **指标与症状跟踪**：用趋势图看清指标升降、体温起伏，沿着历次报告追踪结节、囊肿等形态变化，也把症状轻重和伴随表现记录下来。
- **用药与接种管理**：哪天服药、用量何时调整、何时暂停或停药，都能留下记录；接种记清日期、剂次和凭证，按设置提醒下一剂。
- **健康历程与复查**：把同一事项的症状、就诊、检查和用药串在一起，按流程或时间回看；复查后上传或关联已有报告，接上后续记录。
- **就诊摘要**：就诊前，把相关报告、症状、体温和服药记录汇成带来源的摘要，一键复制；也可用 AI 整理历程标题、摘要和重点。

### 处理与核对

- **原件溯源**：从指标回到来源页，定位原文证据；漏项可补、结果可改、来源可框选，有疑点的内容留待核对。
- **人工校对保护**：重新整理时按来源匹配保留人工校对；关键编辑遇到并发修改时提示冲突，避免旧表单直接覆盖新内容。
- **任务进度与重试**：OCR/AI 处理到哪一步、失败在哪里，随时可查；失败任务可以重试，不必因一次识别失败重新建立档案。
- **操作与 AI 审计**：关键增删改有记录可查，AI 用了哪个模型、消耗多少 Token、耗时多久、是否完成，也能逐次核对。

### 数据管理

- **本地存储**：档案和原件留在自己的 NAS 或 Docker 数据目录。是否启用 AI、连接本地模型还是云端服务，由自己选择。
- **关键个资脱敏**：报告文本发送云端模型前，对可识别的姓名、证件号、联系方式等个人信息进行脱敏处理。
- **成员权限隔离**：家人分别建档，按需开放查看或管理权限；系统管理员也不会自动获得所有人的私人档案访问权。
- **备份与恢复保护**：完整备份带上档案、原件和配置，通过文件校验检查完整性，恢复前再自动留一份安全备份；误删记录可在回收站保留期内找回。
## 应用截图

截图使用脱敏模拟数据，仅用于展示界面和操作流程。

### PC 端

![PC 概览](./snapshot/pc-01-overview.png)

![PC 报告详情](./snapshot/pc-02-records-detail.png)

![PC 指标趋势](./snapshot/pc-03-trends.png)

![PC 上传报告](./snapshot/pc-04-upload.png)

### 触屏端

<table>
  <tr>
    <td align="center">
      <img src="./snapshot/touch-01-overview.png" alt="触屏概览" width="280"><br>
      触屏概览
    </td>
    <td align="center">
      <img src="./snapshot/touch-09-report-detail.png" alt="触屏报告详情" width="280"><br>
      触屏报告详情
    </td>
    <td align="center">
      <img src="./snapshot/touch-10-trend-source-image.png" alt="触屏趋势来源原图" width="280"><br>
      触屏趋势来源原图
    </td>
  </tr>
</table>

## 部署方式

| 方式 | 适合场景 | 身份认证 | 入口 |
| --- | --- | --- | --- |
| fnOS 应用 | **优先通过飞牛应用中心安装和更新** | fnOS 网关账号 | [fnOS 安装与升级](./docs/INSTALL_FNOS.md) |
| Docker | 普通 Linux/NAS、无 fnOS 网关或需要独立部署 | Docker 本地账号 | [Docker 部署文档](./docs/DOCKER_DEPLOYMENT.md) |

### Docker 快速开始

```bash
mkdir -p reports
docker compose pull
docker compose up -d
```

默认访问 `http://服务器地址:3334/`，首次登录账号为 `admin/admin`，首次登录后必须修改密码。完整目录映射、Ollama、HTTPS 反向代理、升级和回滚说明见 [Docker 部署文档](./docs/DOCKER_DEPLOYMENT.md)。

## 文档导航

- [fnOS 安装与升级](./docs/INSTALL_FNOS.md)
- [Docker 部署](./docs/DOCKER_DEPLOYMENT.md)
- [配置说明](./docs/CONFIGURATION.md)
- [多文件报告导入](./docs/REPORT_IMPORT.md)
- [健康记录与健康历程](./docs/HEALTH_EVENT_EPISODE.md)
- [趋势分组筛选](./docs/TREND_GROUPS.md)
- [备份、恢复与迁移](./docs/BACKUP_RESTORE.md)
- [常见问题排查](./docs/TROUBLESHOOTING.md)
- [指标字典维护](./dictionary/README.md)
- [AI 能力架构](./docs/AI_ARCHITECTURE.md)
- [fnOS 开发规范](./docs/FNOS_DEVELOPMENT.md)
- [版本与数据库迁移规范](./docs/VERSION_MIGRATION.md)
- [应用发布流程](./docs/RELEASE_PROCESS.md)

## 隐私与安全

原件默认保存在本地 NAS 或 Docker 数据目录。AI 输入会在发送前过滤患者姓名、证件号、电话、地址、邮箱和精确出生日期；是否启用 AI 或视觉模型由管理员决定。文本脱敏不覆盖视觉复核发送的页面原图，也不保证过滤全部个人信息。健康报告、OCR 正文、AI 输入和备份文件都属于敏感数据，不应上传到公开 Issue、论坛或群聊。

fnOS 应用使用 fnOS 网关账号和系统授权目录；Docker 使用独立本地账号和容器挂载目录，两种模式互不共享登录流程。

## 开发与测试

```bash
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

开发者发布、fnOS 打包、Docker 镜像和数据库迁移要求见 [应用发布流程](./docs/RELEASE_PROCESS.md)。

## 问题反馈与进度

遇到应用 BUG，**推荐优先在应用内提交反馈**：进入「我的」→「反馈与进度」→「提交反馈」。请描述出现的问题和复现步骤；需要说明界面情况时，可附上截图，并在提交前使用涂鸦或打码遮挡隐私信息。反馈会附带应用版本及运行环境信息，方便定位问题。

提交后会生成反馈编号。你可以在「反馈与进度」查看处理进展、补充说明，以及确认修复结果。如需在 QQ 群紧急跟进，请提供反馈编号，便于对应同一个问题；不要在群聊中发送报告原件、OCR 正文、检查结果、成员信息或凭据。

## 项目链接

- 开源仓库：[github.com/timor-m/fnos-app-health-records](https://github.com/timor-m/fnos-app-health-records)
- Docker Hub：[timorm/fnos-app-health-records](https://hub.docker.com/r/timorm/fnos-app-health-records)
- QQ 交流群：`1085626763`
- 微信交流群：进入应用「我的」→「关于」查看加群二维码；仅在后台提供有效二维码时显示，请求失败或二维码过期时自动隐藏。

交流群可用于安装交流、功能建议和指标字典反馈。应用 BUG 请优先使用上述应用内入口；群聊中只提供反馈编号、脱敏后的错误信息或未命中指标名称，不要发送报告原件、OCR 正文、结果值或成员信息。

<img src="./snapshot/qq-group-qr.jpeg" alt="健康档案 QQ 交流群二维码" width="260">

## 项目目录

```text
packages/ui/                 Vue 页面、组件和样式
packages/server/             SQLite、API、报告、OCR 和 AI 服务
packages/ocr-worker/         OCR 与 PDF 处理 Worker
dictionary/                  核心及远程指标字典
scripts/                     开发、校验、构建和发布脚本
docs/                        用户、开发和运维文档
```
