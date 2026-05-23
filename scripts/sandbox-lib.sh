#!/bin/bash

SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-/root/data/sandboxes}"
SANDBOX_DB="${SANDBOX_DB:-/root/data/sandbox.db}"
SANDBOX_DOMAIN="${DOMAIN:-19930810.xyz}"
SANDBOX_SUFFIX="${SANDBOX_DOMAIN_SUFFIX:-sandbox}"
SANDBOX_DEFAULT_PORT="${SANDBOX_DEFAULT_PORT:-3100}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

db_query() {
    sqlite3 "$SANDBOX_DB" "$@"
}

db_init() {
    if [ ! -f "$SANDBOX_DB" ]; then
        sqlite3 "$SANDBOX_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS sandboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    pid INTEGER,
    status TEXT DEFAULT 'stopped',
    network_id INTEGER,
    domain TEXT,
    port INTEGER DEFAULT 3100,
    mount_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
SQL
        log "database initialized"
    fi
}

sandbox_dir() {
    echo "${SANDBOX_DATA_DIR}/$1"
}

sandbox_domain() {
    echo "${1}.${SANDBOX_SUFFIX}.${SANDBOX_DOMAIN}"
}

sandbox_exists() {
    local name=$1
    [ -d "$(sandbox_dir "$name")" ]
}

sandbox_is_running() {
    local name=$1
    local pid
    pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${name}';" 2>/dev/null)
    [ -n "$pid" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null
}

ensure_running() {
    local name=$1
    if ! sandbox_is_running "$name"; then
        echo "Error: sandbox '${name}' is not running" >&2
        exit 1
    fi
}
