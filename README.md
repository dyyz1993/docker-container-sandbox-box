# Sandbox Box 📦

轻量级沙盒开发环境管理平台，集成 AI Coding Agent，支持多项目多用户并行开发。

## ✨ 功能特性

- **多沙盒隔离** — 每个沙盒独立 network/UTS/filesystem namespace，互不干扰
- **AI Agent 集成** — 内置 pi coding agent，通过工具调用在沙盒内执行命令
- **Web 管理面板** — 沙盒/项目/用户/工作区管理
- **项目维度并行** — 同一项目创建多个工作区，各自独立开发
- **用户维度隔离** — 每个用户独立沙盒环境
- **Git 集成** — 支持 Token 认证，clone/commit/push 全流程
- **Web 终端** — 每个沙盒 ttyd 终端接入
- **域名映射** — 每个沙盒自动分配子域名
- **CI/CD** — GitHub Actions 多架构自动构建，NAS 一键更新

## 🏗️ 架构

```
┌─────────────────────────────────────────┐
│           Web 管理面板 (React)            │
│  Sandboxes | Projects | Users | Agent   │
├─────────────────────────────────────────┤
│            Node.js API Server           │
│  SQLite DB | RPC Bridge | WebSocket     │
├─────────────────────────────────────────┤
│           沙盒引擎 (Shell)              │
│  unshare | nsenter | veth | nginx       │
├─────────────────────────────────────────┤
│          pi Coding Agent (RPC)          │
│  sandbox-bash extension | 19 models    │
├─────────────────────────────────────────┤
│           Docker Container              │
│  node:22 | supervisor | sshd | nginx    │
└─────────────────────────────────────────┘
```

### 隔离原理

每个沙盒通过 Linux namespace 实现隔离：

- **Network** — veth pair + 独立子网 `10.10.{id}.0/24`
- **Mount** — 两阶段 bind mount（host → home/workspace，namespace → /root, /workspace）
- **UTS** — 独立 hostname
- **PID** — 独立进程空间
- **cgroup v2** — 内存限制（512MB，优雅降级）

```
sandbox-box container
├── sandbox1 (net ns / mount ns / 10.10.1.2)
├── sandbox2 (net ns / mount ns / 10.10.2.2)
├── sandbox3 (net ns / mount ns / 10.10.3.2)
│
├── Nginx reverse proxy
│   *.sandbox.example.com → sandbox N
│
└── sshd (2201) | ttyd (7681) | CLI (sandbox)
```

## 🚀 快速部署

### 1. 创建配置文件

```bash
cat > .env << 'EOF'
SSH_PUBLIC_KEY=ssh-rsa AAAA... your-key-here
DOMAIN=example.com
SANDBOX_DOMAIN_SUFFIX=sandbox
ADMIN_PASSWORD=your-password
EOF
```

### 2. Docker 启动

```bash
docker run -d --name sandbox-box \
  --privileged \
  --cgroupns=host \
  --restart unless-stopped \
  --env-file .env \
  -p 2201:22 \
  -p 9091:80 \
  -v /path/to/scripts:/root/scripts \
  -v /path/to/data:/root/data \
  -v /path/to/logs:/var/log \
  -v /path/to/nginx:/etc/nginx/custom \
  ghcr.io/dyyz1993/docker-container-sandbox-box:latest
```

或者使用 docker-compose：

```bash
docker compose up -d
```

### 3. 访问

- **管理面板**: `http://<host>:9091/`
- **SSH**: `ssh -p 2201 root@<host>`

### 4. 更新

```bash
bash update.sh
```

脚本会自动拉取最新镜像，检测是否需要更新，重建容器并等待健康检查通过。

## 📋 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DOMAIN` | 基础域名 | — |
| `SANDBOX_DOMAIN_SUFFIX` | 沙盒子域名后缀 | `sandbox` |
| `SSH_PORT` | 容器内 SSH 端口 | `22` |
| `NGINX_PORT` | 容器内 Nginx 端口 | `80` |
| `SANDBOX_DEFAULT_PORT` | 沙盒 HTTP 预览端口 | `3100` |
| `SSH_PUBLIC_KEY` | SSH 公钥 | — |
| `ADMIN_PASSWORD` | 管理面板密码 | `sandbox2024` |
| `AUTH_SECRET` | JWT 签名密钥 | `sandbox-box-secret-key` |

## 🔧 API

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录获取 token |

### 沙盒管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sandboxes` | 列出所有沙盒 |
| POST | `/api/sandboxes` | 创建沙盒 |
| DELETE | `/api/sandboxes/:name` | 销毁沙盒 |
| POST | `/api/sandboxes/clone` | 克隆仓库到沙盒 |
| GET | `/api/sandboxes/:name/files` | 列出沙盒文件 |
| GET | `/api/sandboxes/:name/files/read` | 读取沙盒文件 |
| PUT | `/api/sandboxes/:name/files/write` | 写入沙盒文件 |
| GET | `/api/sandboxes/:name/stats` | 沙盒资源使用 |
| GET | `/api/sandboxes/:name/git/status` | Git 状态 |
| POST | `/api/sandboxes/:name/git/push` | Git 提交推送 |
| POST | `/api/sandboxes/:name/git/checkout` | Git 切换分支 |

### 项目与用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 列出项目 |
| POST | `/api/projects` | 创建项目 |
| DELETE | `/api/projects/:id` | 删除项目 |
| GET | `/api/users` | 列出用户 |
| POST | `/api/users` | 创建用户（自动创建沙盒） |
| DELETE | `/api/users/:id` | 删除用户（同时销毁沙盒） |

### 工作区

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/workspaces` | 列出工作区 |
| POST | `/api/workspaces` | 创建工作区（用户+项目+分支） |
| DELETE | `/api/workspaces/:name` | 删除工作区 |

### AI Agent

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/start` | 启动 Agent |
| POST | `/api/chat/stop` | 停止 Agent |
| POST | `/api/chat/prompt` | 发送消息 |
| GET | `/api/chat/messages` | 获取对话历史 |
| POST | `/api/chat/sandbox` | 切换沙盒 |
| GET | `/api/chat/status` | Agent 运行状态 |
| GET | `/api/chat/models` | 可用模型列表 |
| POST | `/api/chat/set_model` | 切换模型 |
| WebSocket | `/ws/chat` | 实时流式通信 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 系统资源统计 |
| GET | `/api/domains` | 域名映射列表 |
| GET/POST | `/api/git-config` | Git Token 配置 |
| GET | `/api/health` | 健康检查 |

## 🛠️ 命令行

### 沙盒管理

```bash
sandbox create <name>              # 创建沙盒
sandbox create <name> --port 8080  # 指定端口
sandbox destroy <name>             # 销毁（数据保留）
sandbox resume <name>              # 从保留数据恢复
sandbox list                       # 列出所有沙盒
sandbox info <name>                # 查看详情
sandbox url <name>                 # 获取沙盒 URL
sandbox health <name>              # 健康检查
```

### 沙盒内执行

```bash
sandbox <name> <command...>        # 执行命令
sandbox shell <name>               # 交互式 shell
sandbox daemon <name> <command>    # 运行守护进程
```

### 仓库操作

```bash
sandbox-clone.sh <name> <repo-url>           # 克隆仓库
sandbox-clone.sh <name> <repo-url> --branch dev  # 指定分支
```

### 更新

```bash
bash update.sh                     # 拉取最新镜像并重建
```

## 📁 目录结构

```
sandbox-box/
├── Dockerfile                      # 容器镜像定义
├── entrypoint.sh                   # 入口：SSH 配置 + 沙盒恢复
├── update.sh                       # NAS 一键更新脚本
├── docker-compose.yml              # Compose 参考配置
├── .github/workflows/build.yml     # CI 多架构自动构建
│
├── config/
│   ├── nginx/nginx.conf            # Nginx 基础配置
│   └── supervisor/supervisord.conf # 进程管理（sshd/nginx/web-ui）
│
├── scripts/
│   ├── sandbox                     # CLI 入口（路由子命令）
│   ├── sandbox-lib.sh              # 共享函数（DB/验证/日志）
│   ├── sandbox-create.sh           # 创建沙盒 + namespace 设置
│   ├── sandbox-destroy.sh          # 销毁沙盒
│   ├── sandbox-exec.sh             # 命令执行（交互/守护）
│   ├── sandbox-network.sh          # 网络管理（veth/NAT/DNS）
│   ├── sandbox-nginx.sh            # Nginx 代理配置生成
│   └── sandbox-clone.sh            # Git 仓库克隆
│
├── web-ui/
│   ├── server.js                   # API 服务（1750 行全功能）
│   ├── index.html                  # Web 管理面板
│   └── package.json                # 依赖（better-sqlite3）
│
├── pi-extension/
│   ├── index.ts                    # pi 扩展（ToolOperationsProvider）
│   ├── sandbox-bash.js             # 编译产物
│   └── package.json
│
├── sandbox-bash-extension/
│   ├── index.ts                    # 容器内 bash 工具覆盖
│   └── package.json
│
└── .pi/
    └── sandbox-box.json            # 默认 Agent 配置
```

## 🤖 pi Coding Agent 集成

### 容器内模式

容器内通过 `sandbox-bash-extension` 自动将 bash 命令路由到活跃沙盒。

Agent 通过 RPC 模式启动，Web 面板通过 WebSocket 实时通信：

```
Web 面板 ←→ WebSocket ←→ Node.js RPC Bridge ←→ pi agent (RPC mode)
                                                        │
                                                        ↓
                                              sandbox <name> bash -c '...'
```

### 远程模式（本地 Mac → 远程沙盒）

`pi-extension/` 提供完整的远程沙盒代理，通过 SSH 将所有内置工具代理到远程沙盒。

```bash
# 安装到项目
mkdir -p .pi/extensions
cp -r pi-extension/ .pi/extensions/sandbox-box/

# 启动
pi -e ./pi-extension                # local 模式
pi -e ./pi-extension --sandbox-box  # remote 模式

# 运行时切换
/sandbox-box          # 查看状态
/sandbox-box remote   # 切到远程沙盒
/sandbox-box local    # 切回本地
```

### 配置

创建 `.pi/sandbox-box.json`：

```json
{
  "mode": "remote",
  "host": "192.168.0.29",
  "port": 2201,
  "sandboxPrefix": "pi-",
  "destroyOnExit": false
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `mode` | `"local"` | 启动模式 |
| `host` | `"192.168.0.29"` | sandbox-box SSH 地址 |
| `port` | `2201` | SSH 端口 |
| `sandboxPrefix` | `"pi-"` | 沙盒名前缀 |
| `destroyOnExit` | `false` | 退出时是否销毁沙盒 |

### 代理工具清单

| 工具 | 代理方式 | 远程命令 |
|------|---------|---------|
| bash | `registerTool` 覆盖 | `sandbox <name> bash -c '...'` |
| read | `ToolOperationsProvider` | `sandbox <name> cat '<path>'` |
| write | `ToolOperationsProvider` | `sandbox <name> tee '<path>'` |
| edit | read + write 组合 | — |
| grep | `ToolOperationsProvider` | `sandbox <name> rg --json '...'` |
| find | `ToolOperationsProvider` | `sandbox <name> find ...` |
| ls | `ToolOperationsProvider` | `sandbox <name> ls/stat/test` |

MCP 工具保持本地运行（访问外部 API，不涉及沙盒文件）。

## 🔒 安全

- 所有 API 需要认证（Bearer Token，HMAC-SHA256 签名，24h 过期）
- 每个沙盒独立 network namespace，网络隔离
- 路径校验防止目录遍历（`..` 检测 + 路径 normalize 校验）
- Shell 参数过滤（`sanitizeForShell` 移除危险字符）
- 沙盒名正则校验（`^[a-zA-Z0-9_-]+$`）
- SSH 公钥认证
- Git Token 加密存储，推送时自动注入凭证
- 文件读取大小限制（5MB）

## 🔄 自动恢复

容器重启时，`entrypoint.sh` 自动：

1. 扫描 SQLite 数据库中 `status='running'` 的沙盒
2. 重建 namespace（unshare --net --pid --mount --uts）
3. 恢复网络（veth pair + NAT + DNS）
4. 重新生成 Nginx 代理配置
5. 启动 ttyd Web 终端
6. 启动 HTTP 预览服务
7. 恢复 Git 凭证
8. 从 `start.sh` 恢复守护进程

## 🌐 HTTPS 配置

使用 Nginx Proxy Manager 配置通配符域名：

1. 将 `*.sandbox.example.com` 指向宿主机
2. NPM 添加 Proxy Host，转发到 `sandbox-box:9091`
3. 启用 SSL（Let's Encrypt 或自定义证书）
4. 通过 `https://<name>.sandbox.example.com:8443` 访问沙盒

## 🏗️ CI/CD

GitHub Actions 工作流（`.github/workflows/build.yml`）：

- **触发条件**: push 到 `main` 分支、版本 tag、手动触发
- **多架构构建**: `linux/amd64` + `linux/arm64`
- **镜像标签**: `latest`、`sha-<commit>`、语义化版本
- **缓存**: GitHub Actions Cache（`cache-from/to: gha`）
- **健康检查**: 构建后自动启动容器验证

## 📝 已知限制

- cgroup v2 内存限制在部分 NAS 平台（如极空间 ZSpace）不可用，功能已实现但优雅降级
- Docker Compose v2.21.0 不支持 `cgroupns` 字段，请使用 `docker run --cgroupns=host`
- 部分 NAS 设备主机 SSH 不可用，需通过容器 SSH（端口 2201）管理

## 📜 License

MIT
