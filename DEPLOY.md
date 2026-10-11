# 云服务器 Docker 部署（HTTPS + 证书自动续期）

## 方案说明

```
GitHub push
   └─> GitHub Actions：构建镜像 → 推送到 GHCR → SSH 到服务器
         └─> 服务器：docker compose 拉起新镜像 + Caddy
用户 ──HTTPS──> Caddy（80/443/3000/3001，全服务器唯一入口）
                 ├─ zhiaifree.cn        → nginx（Astro 静态站点）
                 ├─ zhiaifree.cn:3000   → Node 项目 1（容器名 nodeapp1）
                 └─ zhiaifree.cn:3001   → Node 项目 2（容器名 nodeapp2）
```

在原有 nginx 容器前面加了一个 **Caddy** 反向代理容器，由它负责 HTTPS：

- **证书自动申请**：首次启动时自动向 Let's Encrypt 申请免费证书（ACME HTTP-01 验证）
- **证书自动续期**：Caddy 在证书过期前（约剩余 30 天时）**进程内自动续期**，无需 cron、无需任何手动操作
- **HTTP 自动跳转 HTTPS**
- 证书保存在 `caddy_data` 数据卷中，容器重启/重建后不会重复申请

部署架构与配置文件：

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 构建 Astro 静态站点镜像（nginx），未改动 |
| `docker-compose.yml` | 编排 web（站点）+ caddy（HTTPS 网关）；服务器通过 `WEB_IMAGE` / `CADDY_IMAGE` 变量使用 GHCR 预构建镜像 |
| `Caddyfile` | Caddy 配置（域名、反向代理、压缩、安全头） |
| `.github/workflows/deploy.yml` | push 到 main 自动构建镜像并部署到服务器（含 compose 配置同步、部署后健康检查） |
| `.env.example` | 域名配置模板 |

> **为什么 Caddy 镜像要走 GHCR 转存**：国内云服务器直连 Docker Hub 拉取镜像经常超时/极慢（曾导致一次部署假成功——容器没起来但 CI 显示绿色）。因此 CI 每次构建时会把 `caddy:2-alpine` 转存为 `ghcr.io/<仓库>:caddy-2-alpine`，服务器全部镜像统一从 GHCR 拉取。部署脚本使用显式错误检查和健康检查（Caddy 必须在 80 端口响应，否则 CI 直接报红并输出容器日志）。

> 注意：`.env` 在 `.gitignore` 中不会被推送。**服务器上的 `.env` 由部署脚本每次自动生成**（域名来自 GitHub Secrets 中的 `DOMAIN`），本地 `.env` 只用于本地测试。

## 一次性配置（首次部署前）

### 1. 服务器准备

- 服务器已安装 **Docker 和 Docker Compose 插件**（`docker compose version` 能正常输出）
- 云服务器安全组放行 **80/TCP、443/TCP**（443/UDP 可选，用于 HTTP/3），80 端口是证书验证必需的
- 服务器能正常拉取 `ghcr.io` 镜像（现有部署流程已在用，无需额外配置）

### 2. 域名解析

需要一个域名（Let's Encrypt 不支持给裸 IP 签发受信任证书），添加 **A 记录**指向云服务器公网 IP，`ping 你的域名` 能返回服务器 IP 即可。

> 服务器在中国大陆则域名需 ICP 备案；境外（含香港）不需要。

### 3. GitHub Secrets

到仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
|--------|-----|
| `DOMAIN` | 你的域名，如 `blog.example.com`（`SSH_HOST` 等已有 Secret 保持不变） |

## 自动部署（日常使用）

配置完成后，日常部署就是正常推代码：

```bash
git add . && git commit -m "..." && git push
```

GitHub Actions 会自动完成：构建镜像 → 推送 GHCR → 上传 compose 配置到服务器 `~/blog` → 生成 `.env` → `docker compose pull && up -d` → 清理旧镜像和旧的 `astro-blog` 容器。

首次部署后查看证书申请情况：

```bash
# 在服务器上
cd ~/blog && docker compose logs -f caddy
# 看到 certificate obtained successfully 即成功
```

之后浏览器访问 `https://你的域名`，HTTP 自动 301 跳转 HTTPS。

> 部署失败时先看 GitHub Actions 的日志，脚本里的报错信息会指明缺什么（如未设置 DOMAIN Secret、服务器未装 compose 插件等）。

## 多项目共用 HTTPS 网关（Node.js 等新项目接入）

Caddy 是全服务器唯一监听 80/443/3000/3001 的进程，所有项目共用它做 HTTPS。证书按域名签发、与端口无关，全部端口复用同一张自动续期的证书：

- `https://zhiaifree.cn` → 博客（web 容器）
- `https://zhiaifree.cn:3000` → Node 项目 1（约定容器名 `nodeapp1`，内部监听 3000）
- `https://zhiaifree.cn:3001` → Node 项目 2（约定容器名 `nodeapp2`，内部监听 3001）

### 接入步骤（以项目 1 为例）

1. 云服务器安全组放行 **3000/TCP**（项目 2 放行 3001/TCP）
2. 项目以 Docker 容器运行，**加入 shared-apps 网络、不映射宿主机端口**：

```bash
docker run -d --name nodeapp1 --restart unless-stopped --network shared-apps 你的node镜像
```

3. 容器内部实际监听端口需与 `Caddyfile` 中 `reverse_proxy nodeapp1:3000` 一致；不一致就改仓库里的 Caddyfile 后推送，自动部署生效。

### 注意事项

- **不要**让任何容器或进程监听/映射宿主机的 80/443/3000/3001（会与 Caddy 端口冲突导致启动失败）
- Node 容器不加 `-p` 端口映射：外部只能通过 Caddy 的 HTTPS 访问，无法绕过 TLS 直连
- 项目未启动时，对应端口访问会返回 502，属正常现象
- `shared-apps` 网络已在服务器创建（`docker network create shared-apps`），仅重建服务器时需要重新执行
- 跨项目容器互联依赖 `shared-apps` 外部网络；如果新项目想用宿主机进程（pm2/systemd）而非 Docker 运行，Caddy 需要改用 `host.docker.internal` 方式反代，届时再调整

## 证书自动续期说明

- Caddy 使用 ACME 协议，证书剩余约 **30 天** 时自动续期，全程无感，**不需要任何手动操作或定时任务**。
- 续期依赖 80/443 端口持续可达，保持安全组放行即可。
- 证书存储在 `caddy_data` 数据卷中，**不要删除该卷**，否则会重新申请证书（Let's Encrypt 有每周 5 次同名证书的限流，频繁重置可能触发限流被暂时封禁）。
- 每次代码部署会重建 web 容器但**不会**动证书数据卷，续期不受部署影响。

## 手动部署（备用）

不想走 GitHub Actions 时，在服务器上执行：

```bash
# docker-compose.yml 和 Caddyfile 可从仓库复制到 ~/blog
cd ~/blog
echo "DOMAIN=你的域名" > .env
export WEB_IMAGE=ghcr.io/zhiaifree/zhiaifree:latest
export CADDY_IMAGE=ghcr.io/zhiaifree/zhiaifree:caddy-2-alpine
docker compose pull
docker compose up -d --remove-orphans
```

## 常用命令（服务器上 `~/blog` 目录）

```bash
docker compose logs -f caddy   # 查看 Caddy 日志（证书申请/续期都会记录在这里）
docker compose ps              # 查看服务状态
docker compose down            # 停止（数据卷保留）
export WEB_IMAGE=ghcr.io/zhiaifree/zhiaifree:latest
export CADDY_IMAGE=ghcr.io/zhiaifree/zhiaifree:caddy-2-alpine
docker compose pull && docker compose up -d   # 手动更新站点

# 更换域名：改 GitHub Secrets 里的 DOMAIN 后重新部署，
# 或直接改服务器上的 .env 后执行 docker compose up -d caddy
```

## 本地测试（可选）

本地 `docker compose` 不设 `WEB_IMAGE` 时会自动构建镜像：

```bash
cp .env.example .env   # 本地测试可填 DOMAIN=localhost
docker compose up -d --build
```

`DOMAIN=localhost` 时 Caddy 用内部自签证书，浏览器会有警告，仅用于测试，不能对外服务。

## 已知注意事项

- `astro.config.mjs` 中 `site: "https://zhiaifree.github.io"` 用于生成 sitemap、RSS 和规范链接。如果你打算长期用自己的域名对外服务，建议把它改成你的正式域名（会影响 SEO 元数据，不影响页面正常访问）。目前该配置同时服务 GitHub Pages 部署，改前请确认不再依赖 GitHub Pages 的地址。
- 如果 GHCR 镜像包是私有的，服务器需要先 `docker login ghcr.io`（用有 read:packages 权限的 PAT）。
