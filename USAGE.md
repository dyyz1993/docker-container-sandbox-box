# Sandbox-Box 使用指南

## 快速开始

```bash
cd /Users/xuyingzhou/Project/temporary/docker-container-shanbox/sandbox-box

# 启动 pi（默认 local 模式）
pi -e ./pi-extension

# 进入 pi 后切换到远程沙盒
/sandbox-box remote

# 切回本地
/sandbox-box local

# 查看状态
/sandbox-box
```

## 架构

```
本地 Mac                        远程沙盒 (192.168.0.29:2201)
┌──────────┐                    ┌──────────────┐
│  pi agent │                    │  sandbox-box  │
│          │  ── SSH ──→        │  容器          │
│  MCP 工具 │  （仅 bash/read/   │              │
│  (本地)   │   write/edit/     │  pi-sandbox-box│
│          │   grep/find/ls)   │  (隔离沙盒)    │
└──────────┘                    └──────────────┘
```

 - **7 个内置工具** (bash/read/write/edit/grep/find/ls) → 通过 `ToolOperationsProvider` 代理到远程沙盒
- **MCP 工具** (如 kb-mcp) → 本地执行（数据在本地）
- **切换原理** — `pi.setToolOperationsProvider(provider)` 注入远程 operations，`pi.setToolOperationsProvider(undefined)` 恢复本地

## 命令参考

| 命令 | 说明 |
|---|---|
| `pi -e ./pi-extension` | 启动 pi（local 模式） |
| `/sandbox-box` | 显示当前状态 |
| `/sandbox-box remote` | 切到远程沙盒 |
| `/sandbox-box local` | 切回本地 |

## 配置

### 全局配置
```bash
echo '{
  "mode": "remote",
  "host": "192.168.0.29",
  "port": 2201,
  "sandboxPrefix": "pi-",
  "destroyOnExit": false
}' > ~/.pi/agent/sandbox-box.json
```

### 项目级配置
```bash
echo '{
  "mode": "remote",
  "host": "192.168.0.29",
  "port": 2201
}' > .pi/sandbox-box.json
```

### 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `mode` | `"local"` | 启动模式：`"local"` 或 `"remote"` |
| `host` | `"192.168.0.29"` | sandbox-box 容器 SSH 地址 |
| `port` | `2201` | SSH 端口 |
| `sandboxPrefix` | `"pi-"` | 沙盒名前缀，最终名 = 前缀 + 项目目录名 |
| `destroyOnExit` | `false` | pi 退出时是否销毁沙盒 |

## 已验证的功能

| 功能 | 状态 |
|---|---|
| bash 远程执行 | ✅ `hostname` → `2a07cc0094e0` |
| read 远程读取 | ✅ `/etc/hostname` → 容器 ID |
| ls 远程列表 | ✅ `/workspace` → 沙盒文件 |
| write 远程写入 | ✅ SSH stdin 写入 |
| MCP 知识库 | ✅ 本地运行，remote 模式下可用 |
| 状态栏显示 | ✅ `Sandbox: pi-sandbox-box @ 192.168.0.29:2201` |
| 沙盒自动创建 | ✅ 不存在时自动创建 |
| 沙盒自动连接 | ✅ 保存配置后下次启动自动连 |

## 远程沙盒信息

```
容器 SSH:  ssh -p 2201 root@192.168.0.29
沙盒名称:  pi-sandbox-box（基于项目目录名）
沙盒工作目录: /workspace
沙盒域名:  pi-sandbox-box.sandbox.19930810.xyz:8443
```

## 注意事项

1. **MCP 工具在本地运行** — kb_search 等搜索的是本地知识库，文件路径是本地路径
2. **沙盒工作目录是 `/workspace`** — remote 模式下 cwd 自动切换为 `/workspace`
3. **沙盒数据持久化** — destroy 后数据保留，resume 可恢复
4. **grep/find 性能** — find 已用远端 `find` 命令，grep 部分仍走本地 rg+远端文件

## 文件结构

```
sandbox-box/
├── pi-extension/
│   ├── index.ts          # 扩展源码（~400 行，ToolOperationsProvider 版）
│   └── package.json      # 需要 @dyyz1993/pi-coding-agent >=0.75.0
├── scripts/
│   ├── sandbox            # CLI 入口
│   ├── sandbox-lib.sh     # 共享函数
│   ├── sandbox-create.sh   # 创建沙盒
│   ├── sandbox-destroy.sh  # 销毁沙盒
│   ├── sandbox-exec.sh     # 命令执行（已修复引号问题）
│   ├── sandbox-network.sh  # 网络管理
│   └── sandbox-nginx.sh    # Nginx 代理
├── Dockerfile
├── entrypoint.sh
└── README.md
```
