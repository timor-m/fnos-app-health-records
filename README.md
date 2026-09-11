# 健康档案

健康档案是一款面向家庭使用的健康报告归档应用，支持在 fnOS 或 Docker 中部署。它可以保存 PDF、图片和 OCR 结果，并通过可选 AI 将报告整理为可检索的档案、指标趋势和原件证据。

应用不会替代医生诊断，也不会根据报告生成疾病判断。AI 只负责辅助整理，最终应以报告原件和专业医疗意见为准。

## 功能介绍

- **报告归档**：支持拍照、多图、HEIC、JPEG、PNG、WebP 和多页 PDF，支持从 NAS 目录导入。
- **OCR 与 AI 整理**：提取医院、日期、科室、结论、建议、定量/定性指标和形态发现，长报告支持后台处理和断点恢复。
- **原件核对**：保留原始文件、PDF 单页高清图和 OCR 证据，可从指标或趋势直接定位来源页和高亮区域。
- **指标趋势**：统一常见指标名称和单位，区分百分比、绝对值、不同标本和不同检测含义，支持查看历史趋势。
- **形态变化**：独立保存影像、超声、内镜和体格检查中的结节、囊肿等发现，支持按器官、侧别和区域保守关联。
- **家庭管理**：支持多成员档案、访问权限、提醒、重复报告治理和回收站。
- **数据安全**：支持完整备份、校验、恢复、管理员操作日志和 AI 调用审计。

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
- [备份、恢复与迁移](./docs/BACKUP_RESTORE.md)
- [常见问题排查](./docs/TROUBLESHOOTING.md)
- [指标字典维护](./dictionary/README.md)
- [AI 能力架构](./docs/AI_ARCHITECTURE.md)
- [fnOS 开发规范](./docs/FNOS_DEVELOPMENT.md)
- [版本与数据库迁移规范](./docs/VERSION_MIGRATION.md)
- [应用发布流程](./docs/RELEASE_PROCESS.md)

## 隐私与安全

原件默认保存在本地 NAS 或 Docker 数据目录。AI 输入会在发送前过滤患者姓名、证件号、电话、地址、邮箱和精确出生日期；是否启用 AI 或视觉模型由管理员决定。健康报告、OCR 正文、AI 输入和备份文件都属于敏感数据，不应上传到公开 Issue、论坛或群聊。

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

## 项目链接

- 开源仓库：[github.com/timor-m/fnos-app-health-records](https://github.com/timor-m/fnos-app-health-records)
- Docker Hub：[timorm/fnos-app-health-records](https://hub.docker.com/r/timorm/fnos-app-health-records)
- QQ 交流群：`1085626763`

交流群用于安装问题、功能建议和指标字典反馈。反馈时请只提供脱敏后的错误信息和未命中指标名称，不要发送报告原件、OCR 正文、结果值或成员信息。

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
