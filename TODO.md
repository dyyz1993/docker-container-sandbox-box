# Sandbox Box 生产可用清单

## 已完成 ✓
- [x] Docker 容器部署（GitHub CI 自动构建镜像）
- [x] sandbox CLI 工具（create/destroy/exec/list/resume/shell/url/daemon/health）
- [x] 沙盒网络隔离（unshare + veth pair + NAT + DNS）
- [x] Nginx 域名自动代理
- [x] HTTPS 域名访问（*.sandbox.19930810.xyz:8443）
- [x] Web Terminal（ttyd，terminal.sandbox.19930810.xyz:8443）
- [x] Mount namespace 隔离（两阶段 bind mount：host→home/workspace, namespace→/root, namespace→/workspace）
- [x] 文件系统隔离验证（5个沙盒各自独立内容）
- [x] sandbox daemon 模式（长驻进程 + start.sh 持久化）
- [x] sandbox resume 自动恢复服务（从 start.sh 逐行恢复）
- [x] 容器重启恢复（entrypoint 扫描 DB 重建 namespace + 网络 + nginx + 服务）
- [x] sandbox health 健康检查（进程/网络/nginx/端口）
- [x] sandbox destroy cmd_destroy 参数 bug 修复（$2→$1）
- [x] sandbox-network.sh source guard
- [x] 操作日志（sandbox-lib.sh log 写入 /var/log/sandbox-box.log）
- [x] cgroup v2 资源限制（graceful fallback，容器环境不支持时静默跳过）
- [x] DB schema 迁移（services 字段自动 ALTER TABLE）
- [x] CI 自动构建（GitHub Actions → ghcr.io）

## 验证通过 ✓
- [x] 5个沙盒同端口同时运行，5个域名各自返回不同内容
- [x] sandbox create → sandbox exec → 域名访问（完整链路）
- [x] sandbox destroy → sandbox resume → 服务自动恢复 → 域名恢复访问
- [x] sandbox health 健康检查通过
- [x] daemon 进程持久化 + resume 恢复

## 已知限制（非阻断）
- cgroup 资源限制在极空间 Docker 环境不可用（容器未开启 cgroup 委派），功能已实现但 graceful fallback
- 极空间主机 SSH 不可用，部署依赖 SCP 到容器端口 2201
