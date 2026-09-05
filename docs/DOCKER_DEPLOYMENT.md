# Docker 部署

Docker 版本与 fnOS 版本使用同一套业务代码和数据库格式。Docker 直接暴露根路径 `/`，使用独立本地管理员登录；fnOS 版本仍通过系统网关复用 fnOS 账号，不受 Docker 登录方式影响。

官方镜像发布到 Docker Hub。Docker Hub 用户名与 GitHub 仓库所有者不是同一个配置项：

```text
docker.io/timorm/fnos-app-health-records
```

GitHub Actions 使用 Docker Hub Access Token 发布镜像。发布者需要在 Docker Hub 创建公开仓库 `timorm/fnos-app-health-records`，并在 GitHub 仓库的 Actions Secrets 中配置 `DOCKERHUB_USERNAME=timorm` 和 `DOCKERHUB_TOKEN`；`DOCKERHUB_TOKEN` 应使用 Docker Hub 的 Access Token，不要填写账号密码。若后续迁移到其他 Docker Hub 命名空间，可通过 GitHub Actions Variables 中的 `DOCKERHUB_IMAGE` 覆盖默认值。

Compose 也支持通过 `.env` 覆盖镜像名：

```dotenv
DOCKERHUB_IMAGE=timorm/fnos-app-health-records
HEALTH_RECORDS_VERSION=0.2.2
```

公开仓库可以匿名执行 `docker compose pull`；私有仓库需要先执行 `docker login`。

支持 `linux/amd64` 和 `linux/arm64`。镜像不内置完整 OCR Python 依赖，避免基础镜像过大；OCR 环境会在首次安装时写入 `/data` 持久化存储。运行镜像已预装 ONNXRuntime/OpenCV 在 ARM64 无头环境下需要的图像运行库（包括 `libxcb1`），避免 OCR 安装自检因缺少 `libxcb.so.1` 失败。

## 首次安装

需要 Docker Engine 24+ 和 Docker Compose v2。先下载仓库中的 `docker-compose.yml`，然后在同一目录创建默认导入目录：

```bash
mkdir -p reports
```

启动服务：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

默认访问地址为 `http://服务器地址:3334/`，默认用户名和密码都是 `admin`。首次登录后必须设置一个 8-128 个字符的新密码，完成前不能访问报告数据。管理员只会在空数据库首次启动时创建。登录后可在“我的 -> 账号安全”修改自己的密码，也可以直接重置其他本地账号；重置会撤销目标账号的全部登录会话，并要求对方下次登录后修改密码。

管理员也可以在“我的 -> 账号安全 -> 本地账号管理”添加普通本地账号。新账号的临时密码统一为 `admin`，首次登录同样会强制修改密码。管理员重置普通账号时也会恢复为该临时密码。以上账号仅存在于 Docker/本地模式，fnOS 应用模式继续使用 fnOS 网关账号和密码，不提供这套账号管理。

管理员忘记密码时可以在 Docker 主机上离线重置。先停止服务，避免应用与重置命令同时写入 SQLite，然后执行：

```bash
docker compose stop health-records
umask 077
RESET_FILE="$(mktemp /tmp/health-records-admin-password.XXXXXX)"
trap 'rm -f "$RESET_FILE"' EXIT
printf '%s\n' '替换为新的至少8位强密码' > "$RESET_FILE"
docker compose run --rm --no-deps \
  -v "$RESET_FILE:/tmp/reset-password.txt:ro" \
  health-records node scripts/reset-local-admin-password.mjs \
  --password-file /tmp/reset-password.txt --username admin
docker compose start health-records
```

重置会撤销全部现有会话，并要求管理员下次登录后修改密码；不会修改报告、成员或 fnOS 网关账号。旧版本如果设置了 `LOCAL_ADMIN_USERNAME` 或 `LOCAL_ADMIN_PASSWORD`，仍可继续使用，但新部署不需要这些配置。

查看状态和日志：

```bash
curl http://127.0.0.1:3334/healthz
docker compose logs --tail=200 health-records
```

容器进程以非 root 用户运行。应用完整数据统一保存在容器 `/data`：默认使用命名卷 `fnos-health-records-data`，也可以通过 `DATA_HOST_PATH` 映射到 NAS 主机目录。`/reports` 只用于读取 NAS 上已有的源报告，不保存应用数据库或处理结果。

## 从 NAS 目录导入报告

Compose 默认把 `docker-compose.yml` 同目录下的 `./reports` 只读挂载到容器 `/reports`。把报告放入该目录后，以管理员登录，进入“上传报告”，点击“从 NAS 导入”即可浏览和选择。列表会按需显示图片缩略图，点击可放大查看，PDF 可预览第一页。支持 HEIC、JPEG、PNG、WebP 和 PDF；一次最多 24 个文件，单个文件最大 40 MB，合计最大 200 MB。

从旧版本升级时，如果之前使用 Compose 默认的 `./imports` 目录，请先迁移目录：

```bash
docker compose stop health-records
mv imports reports
docker compose up -d --force-recreate
```

如果不希望移动旧目录，也可以在 `.env` 中设置 `REPORTS_HOST_PATH=./imports`，继续把旧目录映射到容器 `/reports`。旧变量 `IMPORT_HOST_PATH` 仍兼容，但新部署建议使用 `REPORTS_HOST_PATH`。

若报告已在 NAS 的其他目录，不需要复制到 `./reports`。在 Compose 所在目录创建 `.env`：

```dotenv
REPORTS_HOST_PATH=/mnt/nas/health-reports
DATA_HOST_PATH=/mnt/nas/health-records
```

首次使用 `DATA_HOST_PATH` 前，创建目录并授予容器用户 UID 1000 写权限：

```bash
mkdir -p /mnt/nas/health-reports /mnt/nas/health-records
docker run --rm \
  -v /mnt/nas/health-records:/data \
  alpine:3.22 \
  chown -R 1000:1000 /data
```

已有部署如果要把原命名卷迁移到 `DATA_HOST_PATH`，先停止应用并复制数据，再启动新映射：

```bash
docker compose stop health-records
mkdir -p /mnt/nas/health-records
docker run --rm \
  -v fnos-health-records-data:/source:ro \
  -v /mnt/nas/health-records:/target \
  alpine:3.22 \
  sh -c 'cp -a /source/. /target/ && chown -R 1000:1000 /target'
docker compose up -d --force-recreate
```

然后重建容器使挂载生效：

```bash
docker compose up -d --force-recreate
docker compose exec health-records sh -c 'ls -la /reports | head'
```

`REPORTS_HOST_PATH` 和 `DATA_HOST_PATH` 都是 Docker 主机上的路径，不是容器路径。前者通过 `:ro` 只读挂载，后者需要可写。SMB/NFS 目录应先挂载到 Docker 主机，再把挂载点配置给 Compose。不要挂载 `/`、整个 `/mnt` 或包含无关私人文件的宽泛目录；建议分别建立健康报告源目录和应用数据目录。容器以 UID 1000 的非 root 用户运行，两个目录及其父目录必须允许该用户读取和遍历；`DATA_HOST_PATH` 还必须允许写入。

如需暴露多个目录，可在 `docker-compose.yml` 中增加多个只读挂载，并把 `IMPORT_ROOTS` 改为容器内路径的 JSON 数组，例如：

```yaml
services:
  health-records:
    environment:
      IMPORT_ROOTS: '["/reports","/archive"]'
    volumes:
      - /mnt/nas/health-reports:/reports:ro
      - /mnt/nas/old-reports:/archive:ro
```

目录浏览和导入仅向应用管理员开放。服务端会解析真实路径并限制在配置根目录内，拒绝 `..` 和越界符号链接；导入时按块复制并校验实际文件签名及 SHA-256。原件进入 `/data/reports` 后不再依赖源路径，删除、移动或卸载源目录不会影响已导入档案，应用也不会修改源文件。

## OCR 安装

登录后进入“我的 -> 运行与识别”，点击“安装 OCR 环境”。安装程序会在 `/data/ocr-venv` 创建 Python 虚拟环境，并下载 RapidOCR、PyMuPDF、Pillow 等依赖。该目录位于数据卷中，重建或升级容器后仍会保留。

首次安装需要访问 Python 包源，耗时和空间占用取决于设备架构与网络。若安装失败，在同一页面查看 OCR 安装诊断和日志。镜像已经包含 Python 3.11、`venv` 以及 OCR Worker 所需系统基础环境。ARM64 容器会自动安装并使用 ONNXRuntime；升级前已安装的 ARM64 OpenVINO 环境会被识别为不兼容，需要在“运行与识别”中重新安装一次。

## AI 与 Ollama 地址

容器访问宿主机上的服务时不能使用 `127.0.0.1`。Compose 已配置 `host.docker.internal`，宿主机 Ollama 的 OpenAI-compatible 地址应使用：

```text
http://host.docker.internal:11434/v1
```

访问局域网其他机器上的 Provider 时，填写该机器的实际局域网 IP。Ollama 还需要监听容器可访问的网卡，并由主机防火墙允许对应来源；不要把 Ollama 端口直接暴露到公网。

## HTTPS 反向代理

建议通过 HTTPS 反向代理提供外部访问。代理负责 TLS，并完整传递原始 Host 和协议。Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name health.example.com;

    client_max_body_size 1g;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3334;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

同时将 Compose 中的 `TRUST_PROXY` 设置为 `1`：

```bash
TRUST_PROXY=1 docker compose up -d
```

只有服务确实位于可信反向代理之后时才启用该选项。应用会据此识别 HTTPS、下发 Secure Cookie，并使用转发后的客户端地址执行登录限流。代理还应允许大文件上传和长时间流式下载，避免备份恢复出现 HTTP 413、500 或网关超时。

## 升级与回滚

正式环境建议固定版本，不要长期依赖 `latest`：

```bash
HEALTH_RECORDS_VERSION=<version> docker compose pull
HEALTH_RECORDS_VERSION=<version> docker compose up -d
```

升级到新版本：

```bash
HEALTH_RECORDS_VERSION=<version> docker compose pull
HEALTH_RECORDS_VERSION=<version> docker compose up -d
```

应用启动时会按数据库 schema 自动迁移，并在需要时创建迁移前备份。升级前仍建议在“我的 -> 备份与恢复”创建并下载一份完整备份。

回滚前必须确认旧镜像支持当前数据库 schema。若新版本已经执行不可向下兼容的迁移，不要直接启动旧镜像；应先保留当前数据卷，再使用升级前的完整备份恢复到独立卷或新实例中验证。

## 数据备份

首选应用内的“完整备份”，它包含一致性数据库快照、原件、配置和 AI 密钥，并带 SHA-256 清单。

默认使用命名卷时，也可以在维护窗口备份整个 Docker 卷。先停止应用，避免复制写入中的 SQLite：

```bash
docker compose stop health-records
docker run --rm \
  -v fnos-health-records-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar -C /data -czf /backup/fnos-health-records-data.tar.gz .
docker compose start health-records
```

卷归档包含医疗资料和密钥，应加密保存并限制访问。恢复整个卷会覆盖当前数据，只应在已验证归档且应用停止的情况下操作。

如果设置了 `DATA_HOST_PATH`，应用数据已经直接位于 Docker 主机目录，只需在停止容器后备份该目录，例如：

```bash
docker compose stop health-records
tar -C /mnt/nas/health-records -czf health-records-data.tar.gz .
docker compose start health-records
```

## 常见问题

- 登录页提示“本地管理员尚未初始化”：重启容器并查看日志。新部署不需要管理员密码文件；如果是旧部署，请确认旧版环境变量没有配置无效的管理员密码。
- 忘记本地管理员密码：按首次安装章节后的离线重置步骤操作；不要在服务运行时直接编辑 SQLite。
- 登录后仍返回未认证：检查浏览器是否接受 Cookie；HTTPS 代理场景确认 `TRUST_PROXY=1` 且 `X-Forwarded-Proto=https`。
- 上传返回 413 或 500：先检查反向代理上传大小、请求体缓冲、临时目录空间和超时，再检查应用日志。
- 大备份下载长时间无响应：关闭代理响应缓冲，延长读取超时，并确认代理支持 Range 请求和流式响应。
- 宿主机 Ollama 无法连接：确认地址不是 `127.0.0.1`，并检查 Ollama 监听地址、主机防火墙和 `host.docker.internal` 解析。
- “从 NAS 导入”看不到文件：确认 `REPORTS_HOST_PATH` 指向 Docker 主机上的真实源报告目录，重建过容器，并检查容器 UID 1000 对目录有读取和遍历权限；应用只显示支持格式的文件。
- 数据目录权限异常：官方镜像以 Node 镜像内置的 `node` 用户运行。使用命名卷通常无需手工处理；设置 `DATA_HOST_PATH` 后，需保证应用数据目录可由容器 UID 1000 读写。
