#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"
source "${SCRIPT_DIR}/sandbox-network.sh" 2>/dev/null || true

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

unshare --net --pid --fork --mount-proc bash -c "
    mount --bind ${sb_dir}/home /root 2>/dev/null || true
    export HOME=/root
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    exec sleep infinity
" &
sb_pid=$!

network_id=$(db_query "SELECT COALESCE(MAX(network_id),0)+1 FROM sandboxes;" 2>/dev/null || echo 1)
ns_ip=$(sandbox-network.sh create "$network_id" "$sb_pid")

domain="$(sandbox_domain "$name")"

db_query "INSERT OR REPLACE INTO sandboxes (name, pid, status, network_id, domain, port, mount_path)
    VALUES ('${name}', ${sb_pid}, 'running', ${network_id}, '${domain}', ${port}, '${mount_path}');"

bash "${SCRIPT_DIR}/sandbox-nginx.sh" add "$name" "$ns_ip" "$port"

echo "Sandbox '${name}' created"
echo "  PID:     ${sb_pid}"
echo "  IP:      ${ns_ip}"
echo "  Domain:  ${domain}"
echo "  Port:    ${port}"
echo "  Dir:     ${sb_dir}"
echo ""
echo "Usage: sandbox ${name} <command>"
