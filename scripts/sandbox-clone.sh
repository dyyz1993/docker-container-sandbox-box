#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

db_init

name=""
repo_url=""
branch=""

while [ $# -gt 0 ]; do
    case "$1" in
        --branch)  branch="$2"; shift 2 ;;
        *)         name="$1"; repo_url="$2"; shift 2 ;;
    esac
done

if [ -z "$name" ] || [ -z "$repo_url" ]; then
    echo "Usage: sandbox clone <name> <repo-url> [--branch main]"
    exit 1
fi

validate_name "$name"

# Clone repo command (used in both new and existing sandbox paths)
clone_cmd="git clone ${branch:+-b ${branch}} '${repo_url}' /workspace"
if [ -n "$branch" ]; then
    clone_cmd="git clone -b ${branch} '${repo_url}' /workspace"
fi

if sandbox_is_running "$name"; then
    echo "Sandbox '${name}' is already running, executing clone in existing sandbox..."
    escaped_name=$(db_escape "$name")
    sb_pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${escaped_name}';" 2>/dev/null)

    nsenter -t "$sb_pid" -m -n -p -u -- \
        bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /workspace 2>/dev/null || true; rm -rf /workspace/.* /workspace/* 2>/dev/null; ${clone_cmd}; cd /workspace && git checkout ${branch:+${branch}} 2>/dev/null || true" < /dev/null 2>&1

    ns_ip=$(db_query "SELECT '' || (((network_id-1)/254)) || '.' || (((network_id-1)%254)+1) || '.2' FROM sandboxes WHERE name='${escaped_name}';" 2>/dev/null || echo "")
    domain="$(sandbox_domain "$name")"

    echo "Repo cloned into existing sandbox '${name}'"
    echo "  PID:     ${sb_pid}"
    echo "  IP:      ${ns_ip}"
    echo "  Domain:  ${domain}"
    echo "  Repo:    ${repo_url}"
    echo "  Branch:  ${branch:-default}"
    echo ""
    echo "Usage: sandbox ${name} <command>"
    exit 0
fi

if sandbox_exists "$name"; then
    echo "Sandbox '${name}' exists but is stopped, starting it first..."
    bash "${SCRIPT_DIR}/sandbox-create.sh" "$name" || true
fi

# Create sandbox first
sb_dir="$(sandbox_dir "$name")"
mkdir -p "${sb_dir}/home" "${sb_dir}/workspace" "${sb_dir}/.npm-global"
mkdir -p "${sb_dir}/home/workspace" "${sb_dir}/home/.npm-global"
ln -sf /root/workspace "${sb_dir}/home/.workspace_link" 2>/dev/null || true
mount --bind "${sb_dir}/workspace" "${sb_dir}/home/workspace" 2>/dev/null || true

unshare --net --pid --mount --uts --fork bash -c "
    mount -t proc proc /proc 2>/dev/null || true
    mount --make-private /
    mount --bind ${sb_dir}/home /root
    mkdir -p /workspace 2>/dev/null || true
    mount --bind /root/workspace /workspace 2>/dev/null || true
    hostname ${name} 2>/dev/null || true
    export HOME=/root
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    git config --global user.email 'sandbox@sandbox-box.local'
    git config --global user.name 'Sandbox Box'
    exec sleep infinity
" &
sb_pid=$!

sleep 0.5
if ! kill -0 "$sb_pid" 2>/dev/null; then
    echo "Error: failed to create namespace for sandbox '${name}'" >&2
    exit 1
fi

network_id=$(db_query "SELECT COALESCE(MAX(network_id),0)+1 FROM sandboxes;" 2>/dev/null || echo 1)
ns_ip=$(bash "${SCRIPT_DIR}/sandbox-network.sh" create "$network_id" "$sb_pid")

domain="$(sandbox_domain "$name")"

escaped_name=$(db_escape "$name")
escaped_domain=$(db_escape "$domain")

db_query "INSERT OR REPLACE INTO sandboxes (name, pid, status, network_id, domain, port, mount_path)
    VALUES ('${escaped_name}', ${sb_pid}, 'running', ${network_id}, '${escaped_domain}', ${SANDBOX_DEFAULT_PORT}, '');"

bash "${SCRIPT_DIR}/sandbox-nginx.sh" add "$name" "$ns_ip" "${SANDBOX_DEFAULT_PORT}"

if [ -d /sys/fs/cgroup ]; then
    mkdir -p "/sys/fs/cgroup/sandbox-${name}" 2>/dev/null \
    && echo 536870912 > "/sys/fs/cgroup/sandbox-${name}/memory.max" 2>/dev/null \
    && echo "$sb_pid" > "/sys/fs/cgroup/sandbox-${name}/cgroup.procs" 2>/dev/null \
    || log "cgroup limits not available for '${name}'"
fi

nsenter -t "$sb_pid" -m -n -p -u -- \
    setsid bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ttyd -p 7681 -W bash" < /dev/null &>/dev/null &
log "ttyd started in sandbox '${name}' on port 7681"

nsenter -t "$sb_pid" -m -n -p -u -- \
    setsid bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /workspace && python3 -m http.server ${SANDBOX_DEFAULT_PORT:-3100}" < /dev/null &>/dev/null &
log "http preview server started in sandbox '${name}' on port ${SANDBOX_DEFAULT_PORT:-3100}"

sleep 0.5

log "Cloning repo into sandbox '${name}'..."
nsenter -t "$sb_pid" -m -n -p -u -- \
    bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; rm -rf /workspace/.* /workspace/* 2>/dev/null; ${clone_cmd} && cd /workspace && git checkout ${branch:+${branch}} 2>/dev/null || true" < /dev/null 2>&1
log "Clone complete for '${name}'"

echo "$name" > /root/data/active-sandbox
log "active sandbox set to '${name}'"

echo "Sandbox '${name}' created with repo cloned"
echo "  PID:     ${sb_pid}"
echo "  IP:      ${ns_ip}"
echo "  Domain:  ${domain}"
echo "  Repo:    ${repo_url}"
echo "  Branch:  ${branch:-default}"
echo ""
echo "Usage: sandbox ${name} <command>"
