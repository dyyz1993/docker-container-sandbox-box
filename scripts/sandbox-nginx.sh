#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

CONF_DIR="/etc/nginx/conf.d"

cmd_add() {
    local name=$1
    local sandbox_ip=$2
    local port="${3:-${SANDBOX_DEFAULT_PORT}}"
    local domain
    domain="$(sandbox_domain "$name")"

    cat > "${CONF_DIR}/sandbox-${name}.conf" << EOF
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://${sandbox_ip}:${port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

    nginx -t -q 2>/dev/null && nginx -s reload 2>/dev/null
    log "nginx route added: ${domain} -> ${sandbox_ip}:${port}"
}

cmd_remove() {
    local name=$1
    rm -f "${CONF_DIR}/sandbox-${name}.conf"
    nginx -t -q 2>/dev/null && nginx -s reload 2>/dev/null
    log "nginx route removed: ${name}"
}

cmd_list() {
    echo "Active nginx sandbox routes:"
    for f in "${CONF_DIR}"/sandbox-*.conf; do
        [ -f "$f" ] || continue
        grep -oP 'server_name \K[^;]+' "$f" 2>/dev/null || true
    done
}

case "${1:-}" in
    add)    cmd_add "$2" "$3" "${4:-}" ;;
    remove) cmd_remove "$2" ;;
    list)   cmd_list ;;
    *)
        echo "Usage: sandbox-nginx.sh {add|remove|list}"
        exit 1
        ;;
esac
