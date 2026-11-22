# Docker 部署

需要 Docker Engine 24+ 和 Docker Compose v2，支持 x86_64、ARM64。

## 1. 准备部署文件

在服务器上执行，无需下载源码或自行构建镜像：

```bash
mkdir -p health-records/reports
cd health-records
curl -fL https://raw.githubusercontent.com/timor-m/fnos-app-health-records/v0.2.13/docker-compose.yml -o docker-compose.yml
```

创建 `.env`，指定安装版本：

```dotenv
HEALTH_RECORDS_VERSION=0.2.13
```

## 2. 启动服务

```bash
docker compose pull
docker compose up -d
docker compose ps
```

浏览器打开 **`http://服务器地址:3334/`**。

应用数据默认保存在 Docker 卷 `fnos-health-records-data`，重建容器不会丢失。不要使用 `docker compose down -v`，该命令会删除数据卷。

## 3. 首次登录与配置

1. 使用 **`admin` / `admin`** 登录，按提示修改密码。
2. 进入“我的 → 运行与识别”，点击“安装 OCR 环境”，等待安装完成。首次安装需要联网下载依赖，升级容器后会保留。
3. 如需 AI 整理报告，在应用内配置 AI 服务。宿主机上的 Ollama 地址填写 `http://host.docker.internal:11434/v1`，不要填写 `127.0.0.1`；Ollama 需允许容器访问。
4. 创建成员档案并上传报告；也可在“我的 → 备份与恢复”上传已有完整备份。

从飞牛备份恢复时，由当前 Docker 管理员接管恢复档案，可直接选择已有档案“设为本人”。**完整恢复会替换当前数据，不会追加合并**，详见 [备份与恢复](./BACKUP_RESTORE.md)。

## 按需调整

在 `.env` 中添加需要的配置，然后执行 `docker compose up -d` 生效：

| 配置示例 | 用途 |
| --- | --- |
| `HEALTH_RECORDS_PORT=8080` | 将访问端口改为 8080 |
| `REPORTS_HOST_PATH=/mnt/nas/health-reports` | 只读挂载 NAS 源报告目录；默认是 `./reports` |
| `DATA_HOST_PATH=/mnt/nas/health-records` | 新安装时改用主机目录保存应用数据；默认使用 Docker 卷 |

使用主机目录前先创建目录。容器以 UID 1000 运行，源报告目录需可读取，应用数据目录需可读写。**已有部署切换数据目录前必须迁移原数据**，操作见 [目录与数据卷迁移](./DOCKER_OPERATIONS.md#nas-目录与数据卷迁移)。

从 NAS 导入：将报告放入挂载的源目录，以管理员登录“上传报告 → 从 NAS 导入”选择文件。具体用法见 [批量导入](./REPORT_IMPORT.md)。

## 升级

1. 在“我的 → 备份与恢复”创建并下载完整备份。
2. 将 `.env` 中的 `HEALTH_RECORDS_VERSION` 改为目标版本。
3. 执行：

```bash
docker compose pull
docker compose up -d
```

保持原数据卷或数据目录配置。回滚与恢复步骤见 [备份与恢复](./BACKUP_RESTORE.md)。

## 从 feat-event 分支发布版本镜像

当前仓库推送 `feat-event` 分支时，由独立的 `Docker Image (feat-event)` 工作流完成校验、测试、Docker 启动检查及双架构镜像发布。沿用仓库的 `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` Secrets 和可选的 `DOCKERHUB_IMAGE` 变量。

镜像标签取自 `package.json` 的版本号。已发布版本为 `0.3.2`；当前开发版本为 `0.3.3`，推送 `feat-event` 时镜像标签跟随 `package.json`，不增加分支标签，也不更新 `latest`，不创建 Git tag、FPK 或 GitHub Release。工作流会核对发布前后的 `latest` digest；该流程不冻结版本，也不递增 schema 编号。已安装临时 `0.3.0` 或未发布 `0.3.1` 镜像的环境，把版本改为已发布的 `0.3.2` 后重新拉取。

在 `.env` 中设置 `HEALTH_RECORDS_VERSION=0.3.2`，然后按上述升级步骤拉取镜像并重建容器。需要固定某次构建时，使用工作流摘要中的 digest；同一应用版本再次构建会更新对应版本标签。建议先使用独立数据卷测试；已有数据升级前先创建完整备份，回退旧版按[备份与恢复](./BACKUP_RESTORE.md)处理。

## 启动异常

查看容器状态和最近日志：

```bash
docker compose ps
docker compose logs --tail=100 health-records
```

忘记密码、HTTPS 代理、目录权限和其他排障步骤见 [Docker 维护与排障](./DOCKER_OPERATIONS.md)。
