#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

db_init

name=""
mount_path=""
port="${SANDBOX_DEFAULT_PORT}"

while [ $# -gt 0 ]; do
    case "$1" in
        --mount)  mount_path="$2"; shift 2 ;;
        --port)   port="$2"; shift 2 ;;
        *)        name="$1"; shift ;;
    esac
done

if [ -z "$name" ]; then
    echo "Usage: sandbox create <name> [--mount /path] [--port 3100]"
    exit 1
fi

if sandbox_is_running "$name"; then
    echo "Error: sandbox '${name}' is already running"
    exit 1
fi

sb_dir="$(sandbox_dir "$name")"
mkdir -p "${sb_dir}/home" "${sb_dir}/workspace" "${sb_dir}/.npm-global"

if [ -n "$mount_path" ] && [ -d "$mount_path" ]; then
    mount --bind "$mount_path" "${sb_dir}/workspace" 2>/dev/null || true
fi

unshare --net --pid --mount --fork --mount-proc bash -c "
    mount --make-private /
    mount --bind ${sb_dir}/home /root
    mount --bind ${sb_dir}/workspace /workspace
    export HOME=/root
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    exec sleep infinity
" &
sb_pid=$!

sleep 0.3
if ! kill -0 "$sb_pid" 2>/dev/null; then
    echo "Error: failed to create namespace for sandbox '${name}'" >&2
    exit 1
fi

network_id=$(db_query "SELECT COALESCE(MAX(network_id),0)+1 FROM sandboxes;" 2>/dev/null || echo 1)
ns_ip=$(bash "${SCRIPT_DIR}/sandbox-network.sh" create "$network_id" "$sb_pid")

domain="$(sandbox_domain "$name")"

db_query "INSERT OR REPLACE INTO sandboxes (name, pid, status, network_id, domain, port, mount_path)
    VALUES ('${name}', ${sb_pid}, 'running', ${network_id}, '${domain}', ${port}, '${mount_path}');"

bash "${SCRIPT_DIR}/sandbox-nginx.sh" add "$name" "$ns_ip" "$port"

if [ -d /sys/fs/cgroup ]; then
    mkdir -p "/sys/fs/cgroup/sandbox-${name}" 2>/dev/null || true
    echo "max 512M" > "/sys/fs/cgroup/sandbox-${name}/memory.max" 2>/dev/null || true
    echo "$sb_pid" > "/sys/fs/cgroup/sandbox-${name}/cgroup.procs" 2>/dev/null || true
fi

start_sh="${sb_dir}/start.sh"
if [ -f "$start_sh" ]; then
    log "resuming services for sandbox '${name}'"
    nsenter -t "$sb_pid" -m -n -p -u -- bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /workspace 2>/dev/null || cd /root; bash ${sb_dir}/start.sh" < /dev/null &>/dev/null &
fi

echo "Sandbox '${name}' created"
echo "  PID:     ${sb_pid}"
echo "  IP:      ${ns_ip}"
echo "  Domain:  ${domain}"
echo "  Port:    ${port}"
echo "  Dir:     ${sb_dir}"
echo ""
echo "Usage: sandbox ${name} <command>"
