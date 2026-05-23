#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

name="${1:-}"
shift || true
cmd="$*"

if [ -z "$name" ] || [ -z "$cmd" ]; then
    echo "Usage: sandbox <name> <command>"
    echo "       sandbox daemon <name> <command>"
    echo "       sandbox shell <name>"
    exit 1
fi

ensure_running "$name"

pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${name}';")
sb_dir="$(sandbox_dir "$name")"

if [[ "$cmd" == *"&" ]]; then
    cmd_clean="${cmd%&}"
    cmd_clean="${cmd_clean% }"

    start_sh="${sb_dir}/start.sh"
    if [ ! -f "$start_sh" ] || ! grep -qF "$cmd_clean" "$start_sh" 2>/dev/null; then
        echo "$cmd_clean" >> "$start_sh"
    fi

    nsenter -t "$pid" -m -n -p -u -- \
        setsid bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export NPM_CONFIG_PREFIX=${sb_dir}/.npm-global; cd /workspace 2>/dev/null || cd /root; ${cmd_clean}" < /dev/null &>/dev/null &
    echo "Daemon started in sandbox '${name}'"
else
    exec nsenter -t "$pid" -m -n -p -u -- \
        /bin/bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export NPM_CONFIG_PREFIX=${sb_dir}/.npm-global; cd /workspace 2>/dev/null || cd /root; exec $cmd"
fi
