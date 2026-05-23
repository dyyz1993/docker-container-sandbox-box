# Sandbox Box 生产可用待办清单

## 已完成
- [x] Docker 容器部署（GitHub CI 自动构建镜像）
- [x] sandbox CLI 工具（create/destroy/exec/list/resume/shell/url）
- [x] 沙盒网络隔离（unshare + veth pair + NAT + DNS）
- [x] Nginx 域名自动代理
- [x] HTTPS 域名访问（*.sandbox.19930810.xyz:8443）
- [x] Web Terminal（ttyd，terminal.sandbox.19930810.xyz:8443）
- [x] 5个沙盒同端口创建验证
- [x] 销毁+恢复验证

## 待修复（生产阻断）
- [ ] sandbox-network.sh 的 source guard 未提交到源码（每次 scp 后需手动 sed）
- [ ] sandbox-create.sh 里 workspace bind mount 未生效（unshare 后 mount namespace 隔离导致）
- [ ] sandbox-destroy.sh 参数位置 bug（$2 应该是 $1）
- [ ] nsenter 启动的后台进程在 nsenter 退出时被杀（setsid 方案不稳定）
- [ ] for 循环变量展开问题（Mac bash 和容器 bash 变量传递问题）

## 待实现（生产必需）
- [ ] sandbox exec 的后台进程保活方案（写启动脚本到沙盒内）
- [ ] sandbox resume 时自动恢复之前运行的服务（记录启动命令到元数据）
- [ ] 容器重启后自动恢复所有沙盒（entrypoint 里扫描 DB 恢复）
- [ ] 沙盒健康检查（sandbox health 检测进程和网络状态）
- [ ] 沙盒资源限制（cgroup 限制 CPU/内存，防止单个沙盒吃光资源）
- [ ] 日志持久化（沙盒操作日志写入文件）
- [ ] auto-update.sh（类似 shanbox 的自动更新脚本）
- [ ] 极空间 docker-compose.yml 里 scripts 目录的文件需要在容器重启后自动同步

## 验证清单（最终验收）
- [ ] sandbox create → sandbox exec → 域名访问（完整链路）
- [ ] 5个沙盒同端口同时运行，5个域名各自返回不同内容
- [ ] sandbox destroy → sandbox resume → 启动服务 → 域名恢复访问
- [ ] 容器重启后 sandbox list 显示所有沙盒并自动恢复
- [ ] Web Terminal 可以操作 sandbox CLI
- [ ] cgroup 限制生效（单个沙盒内存不超过限制）

## 技术方案
1. workspace mount: 改用沙盒初始化时在 namespace 内 bind mount
2. 后台进程保活: 在沙盒目录下保存 start.sh 脚本，resume 时自动执行
3. 容器重启恢复: entrypoint.sh 扫描 DB，对每个 status=running 的沙盒重新创建 namespace
4. cgroup: 使用 systemd-run 或手动创建 cgroup v2 限制
5. 所有脚本修复推送到 GitHub CI 重建
