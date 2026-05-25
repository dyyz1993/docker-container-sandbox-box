#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

name="${1:-}"

if [ -z "$name" ]; then
    echo "Usage: sandbox destroy <name>"
    exit 1
fi

if [ "${SANDBOX_PRESERVE:-}" = "true" ]; then
    preserve="true"
elif [ "${2:-}" = "preserve" ] || [ "${2:-}" = "true" ]; then
    preserve="true"
else
    preserve="false"
fi

validate_name "$name"

if ! sandbox_exists "$name"; then
    echo "Error: sandbox '${name}' does not exist"
    exit 1
fi

escaped_name=$(db_escape "$name")
pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${escaped_name}';" 2>/dev/null)
network_id=$(db_query "SELECT network_id FROM sandboxes WHERE name='${escaped_name}';" 2>/dev/null)

if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
fi

if [ -n "$network_id" ]; then
    bash "${SCRIPT_DIR}/sandbox-network.sh" destroy "$network_id" 2>/dev/null || true
fi

bash "${SCRIPT_DIR}/sandbox-nginx.sh" remove "$name" 2>/dev/null || true

sb_dir="$(sandbox_dir "$name")"
umount "${sb_dir}/home/workspace" 2>/dev/null || true
umount "${sb_dir}/workspace" 2>/dev/null || true

if [ -d "/sys/fs/cgroup/sandbox-${name}" ]; then
    rmdir "/sys/fs/cgroup/sandbox-${name}" 2>/dev/null || true
fi

db_query "UPDATE sandboxes SET status='stopped', pid=0 WHERE name='${escaped_name}';"

sb_dir="$(sandbox_dir "$name")"
if [ "$preserve" = "false" ]; then
    rm -rf "$sb_dir"
    db_query "DELETE FROM sandboxes WHERE name='${escaped_name}';"
    echo "Sandbox '${name}' destroyed (data deleted)"
else
    echo "Sandbox '${name}' destroyed (data preserved at ${sb_dir})"
    echo "Resume with: sandbox resume ${name}"
fi
