#!/bin/bash

SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-/root/data/sandboxes}"
SANDBOX_DB="${SANDBOX_DB:-/root/data/sandbox.db}"
SANDBOX_DOMAIN="${DOMAIN:-19930810.xyz}"
SANDBOX_SUFFIX="${SANDBOX_DOMAIN_SUFFIX:-sandbox}"
SANDBOX_DEFAULT_PORT="${SANDBOX_DEFAULT_PORT:-3100}"
SANDBOX_LOG_FILE="${SANDBOX_LOG_FILE:-/var/log/sandbox-box.log}"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" >&2
    echo "$msg" >> "$SANDBOX_LOG_FILE" 2>/dev/null || true
}

db_escape() {
    printf '%s' "$1" | sed "s/'/''/g"
}

db_query() {
    sqlite3 "$SANDBOX_DB" "$@"
}

validate_name() {
    local name="$1"
    if [[ ! "$name" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
        echo "Error: invalid name '${name}'. Only [a-zA-Z0-9_-], max 64 chars" >&2
        exit 1
    fi
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
    services TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
SQL
        log "database initialized"
    else
        local has_services
        has_services=$(sqlite3 "$SANDBOX_DB" "PRAGMA table_info(sandboxes);" 2>/dev/null | grep -c 'services' || true)
        if [ "$has_services" -eq 0 ]; then
            sqlite3 "$SANDBOX_DB" "ALTER TABLE sandboxes ADD COLUMN services TEXT DEFAULT '';" 2>/dev/null || true
        fi
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
    local escaped
    escaped=$(db_escape "$name")
    local pid
    pid=$(db_query "SELECT pid FROM sandboxes WHERE name='${escaped}';" 2>/dev/null)
    [ -n "$pid" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null
}

ensure_running() {
    local name=$1
    if ! sandbox_is_running "$name"; then
        echo "Error: sandbox '${name}' is not running" >&2
        exit 1
    fi
}
