#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

name="${1:-}"
preserve="${2:-true}"

if [ -z "$name" ]; then
    echo "Usage: sandbox destroy <name>"
    exit 1
fi

if ! sandbox_exists "$name"; then
    echo "Error: sandbox '${name}' does not exist"
    exit 1
fi

pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${name}';" 2>/dev/null)
network_id=$(db_query "SELECT network_id FROM sandboxes WHERE name='${name}';" 2>/dev/null)

if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
fi

if [ -n "$network_id" ]; then
    sandbox-network.sh destroy "$network_id" 2>/dev/null || true
fi

bash "${SCRIPT_DIR}/sandbox-nginx.sh" remove "$name" 2>/dev/null || true

db_query "UPDATE sandboxes SET status='stopped', pid=0 WHERE name='${name}';"

sb_dir="$(sandbox_dir "$name")"
if [ "$preserve" = "false" ]; then
    rm -rf "$sb_dir"
    db_query "DELETE FROM sandboxes WHERE name='${name}';"
    echo "Sandbox '${name}' destroyed (data deleted)"
else
    echo "Sandbox '${name}' destroyed (data preserved at ${sb_dir})"
fi
echo "Resume with: sandbox resume ${name}"
