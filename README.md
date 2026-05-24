# Sandbox-Box

Isolated sandbox engine running in Docker. Each sandbox gets its own network namespace, filesystem, domain, and web terminal — managed via a single CLI.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  sandbox-box container               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ sandbox1  │  │ sandbox2  │  │ sandbox3  │  ...     │
│  │ net ns    │  │ net ns    │  │ net ns    │           │
│  │ mount ns  │  │ mount ns  │  │ mount ns  │           │
│  │ 10.10.1.2 │  │ 10.10.2.2 │  │ 10.10.3.2 │           │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘         │
│        │              │              │                 │
│  ┌─────┴──────────────┴──────────────┴─────┐          │
│  │           Nginx reverse proxy            │          │
│  │  *.sandbox.example.com → sandbox N       │          │
│  └──────────────────┬───────────────────────┘          │
│                     │                                  │
│  ┌──────────────────┴───────────────────────┐          │
│  │  sshd (2201) │ ttyd (7681) │ CLI (sandbox) │       │
│  └──────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────┘
         │
    NPM HTTPS proxy (*.sandbox.example.com:8443)
```

## Features

- **Network isolation**: veth pair + dedicated subnet per sandbox (`10.10.{id}.0/24`)
- **Filesystem isolation**: two-stage bind mount (host → home/workspace, namespace → /root, /workspace)
- **Domain routing**: auto-generated nginx config per sandbox (`<name>.sandbox.<domain>`)
- **Web Terminal**: ttyd per sandbox via `terminal.<name>.sandbox.<domain>:8443`
- **Daemon mode**: run long-lived services inside sandboxes
- **Auto-recovery**: container restart automatically restores all running sandboxes
- **Data persistence**: destroy keeps data, resume restores from preserved state
- **Security**: input validation, SQL injection prevention, path traversal blocking
- **Resource limits**: cgroup v2 memory limit (graceful fallback if unavailable)

## Quick Start

### Deploy with Docker

```bash
# Pull image
docker pull ghcr.io/dyyz1993/docker-container-sandbox-box:latest

# Create .env
cat > .env << 'EOF'
SSH_PUBLIC_KEY=ssh-rsa AAAA... your-key-here
SANDBOX_DOMAIN=sandbox.example.com
EOF

# Run container
docker run -d \
  --name sandbox-box \
  --privileged \
  --cgroupns=host \
  --restart unless-stopped \
  --env-file .env \
  -p 9091:80 \
  -p 2201:22 \
  -v ./scripts:/root/scripts \
  -v ./data:/root/data \
  -v ./logs:/var/log \
  -v ./config/nginx:/etc/nginx/custom \
  ghcr.io/dyyz1993/docker-container-sandbox-box:latest
```

### CLI Usage

```bash
# Enter container
ssh -p 2201 root@<host>

# Create a sandbox
sandbox create myapp

# Execute commands
sandbox myapp echo "hello from sandbox"
sandbox myapp npm init -y

# Interactive shell
sandbox shell myapp

# Run a daemon (long-lived service)
sandbox daemon myapp "python3 -m http.server 3100"

# Get sandbox URL
sandbox url myapp
# → http://myapp.sandbox.example.com

# List all sandboxes
sandbox list

# Health check
sandbox health myapp

# Destroy (data preserved)
sandbox destroy myapp

# Resume from preserved data
sandbox resume myapp
```

### CLI Reference

| Command | Description |
|---|---|
| `sandbox create <name> [--mount /path] [--port 3100]` | Create new sandbox |
| `sandbox <name> <command...>` | Execute command in sandbox |
| `sandbox shell <name>` | Interactive bash shell |
| `sandbox daemon <name> <command>` | Run long-lived service |
| `sandbox list` | List all sandboxes |
| `sandbox info <name>` | Show sandbox details |
| `sandbox url <name>` | Show sandbox URL |
| `sandbox health <name>` | Health check |
| `sandbox resume <name> [--mount /path]` | Resume stopped sandbox |
| `sandbox destroy <name>` | Destroy sandbox (keeps data) |

## HTTPS Setup (Nginx Proxy Manager)

Point a wildcard domain (`*.sandbox.example.com`) to your host, then configure NPM:

1. Add a **Proxy Host** for `*.sandbox.example.com`
2. Forward to `sandbox-box container IP:9091`
3. Enable SSL (Let's Encrypt or custom cert)
4. Access sandboxes via `https://<name>.sandbox.example.com:8443`

## pi Coding Agent Integration

The `pi-extension/` directory contains a complete pi coding agent extension that proxies all 7 built-in tools (bash, read, write, edit, grep, find, ls) to a remote sandbox via SSH, using the `ToolOperationsProvider` architecture.

### How It Works

```
Local Mac                          Remote Sandbox (192.168.0.29:2201)
┌──────────────┐                   ┌──────────────┐
│  pi agent    │                   │  sandbox-box  │
│              │  ── SSH ──→       │  container    │
│  MCP tools   │  (bash/read/      │              │
│  (local)     │   write/edit/     │  pi-{project} │
│              │   grep/find/ls)   │  (namespace)  │
└──────────────┘                   └──────────────┘
```

**Architecture:**
- **bash** → `registerTool` override (needed because bash-ext overrides built-in bash)
- **read/write/edit/grep/find/ls** → `setToolOperationsProvider` injects remote operations
- **MCP tools** → stay local (external APIs, local data)
- **Switching** → `pi.setToolOperationsProvider(provider)` to activate remote, `undefined` to revert

### Prerequisites

1. **pi fork** `@dyyz1993/pi-coding-agent` >= 0.75.0 with `ToolOperationsProvider` support
2. **sandbox-box** container running and accessible via SSH
3. **SSH key** configured in the container (`SSH_PUBLIC_KEY` env var)

### Installation

```bash
# Option 1: Project-level (recommended)
mkdir -p .pi/extensions
cp -r pi-extension/ .pi/extensions/sandbox-box/

# Option 2: Global
cp -r pi-extension/ ~/.pi/agent/extensions/sandbox-box/
```

### Configuration

Create `.pi/sandbox-box.json` in your project root:

```json
{
  "mode": "remote",
  "host": "192.168.0.29",
  "port": 2201,
  "sandboxPrefix": "pi-",
  "destroyOnExit": false
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"local"` | Startup mode: `"local"` or `"remote"` |
| `host` | `"192.168.0.29"` | sandbox-box container SSH address |
| `port` | `2201` | SSH port |
| `sandboxPrefix` | `"pi-"` | Sandbox name prefix, final name = prefix + project dir name |
| `destroyOnExit` | `false` | Destroy sandbox when pi exits |

### Usage

```bash
# Start pi with extension (local mode by default)
pi -e ./pi-extension

# Start directly in remote mode via flag
pi -e ./pi-extension --sandbox-box

# Runtime switching inside pi session
/sandbox-box          # show status
/sandbox-box remote   # switch to remote sandbox mode
/sandbox-box local    # switch back to local mode
```

### What Happens in Remote Mode

1. On `session_start`, the extension:
   - Tests SSH connectivity to sandbox-box
   - Auto-creates a sandbox named `{prefix}{projectDir}` (e.g., `pi-myapp`)
   - Injects `ToolOperationsProvider` for 6 file tools + `registerTool` for bash

2. All built-in tool calls are transparently proxied:
   - `bash` → SSH → `sandbox <name> bash -c '<cmd>'`
   - `read` → SSH → `sandbox <name> cat '<path>'`
   - `write` → SSH → `sandbox <name> tee '<path>'` (via stdin)
   - `edit` → read + write combined
   - `grep` → SSH → `sandbox <name> rg --json '<pattern>' '<path>'`
   - `find` → SSH → `sandbox <name> find '<cwd>' -name '<pattern>'`
   - `ls` → SSH → `sandbox <name> ls/stat/test`

3. MCP tools continue to run locally (they access external APIs, not sandbox files)

### Verified Features

| Feature | Status | Notes |
|---------|--------|-------|
| bash remote execution | ✅ | `hostname` returns sandbox hostname |
| read remote files | ✅ | `cat` via SSH |
| write remote files | ✅ | `tee` via SSH stdin |
| edit remote files | ✅ | read + sed + write |
| grep remote search | ✅ | `rg --json` via SSH |
| find remote files | ✅ | `find -name` via SSH |
| ls remote listing | ✅ | `ls`/`stat`/`test` via SSH |
| Sandbox auto-create | ✅ | Created on session start if not exists |
| Mode switching | ✅ | `/sandbox-box remote/local` at runtime |
| Session recovery | ✅ | Reconnects on next pi start |

### Notes

1. **Sandbox working directory is `/workspace`** — remote mode cwd auto-switches to `/workspace`
2. **MCP tools run locally** — knowledge base, web search, etc. use local data
3. **Sandbox data persists** — `destroy` keeps data, `resume` restores it
4. **Path escaping** — single quotes + backslash escaping for SSH commands

## Development

### Prerequisites

- Docker with Buildx
- GitHub account (for GHCR)

### Build Locally

```bash
docker build -t sandbox-box .
```

### CI/CD

Pushing to `main` branch triggers GitHub Actions to build and push the image to `ghcr.io/dyyz1993/docker-container-sandbox-box:latest`.

### Project Structure

```
├── .github/workflows/build.yml   # CI pipeline
├── Dockerfile                    # Container image
├── entrypoint.sh                 # SSH setup, sandbox recovery on start
├── docker-compose.yml            # Reference compose (use docker run for production)
├── scripts/
│   ├── sandbox                   # CLI entry point
│   ├── sandbox-lib.sh            # Shared functions (db, validation, logging)
│   ├── sandbox-create.sh         # Sandbox creation + namespace setup
│   ├── sandbox-destroy.sh        # Sandbox destruction
│   ├── sandbox-exec.sh           # Command execution (interactive/daemon)
│   ├── sandbox-network.sh        # Network namespace management (veth/NAT/DNS)
│   └── sandbox-nginx.sh          # Nginx proxy config generation
├── config/
│   ├── nginx/nginx.conf          # Base nginx config
│   └── supervisor/supervisord.conf
├── pi-extension/
│   └── index.ts                  # pi coding agent extension
└── data/                         # Runtime data (gitignored)
```

## Known Limitations

- **cgroup memory limits** require kernel enforcement; some NAS platforms (e.g., ZSpace) don't enforce `memory.max`
- **Docker Compose** v2.21.0 doesn't support `cgroupns` field — use `docker run --cgroupns=host` instead
- **Host SSH** may not be available on some NAS devices — deploy via container SSH (port 2201) instead

## License

MIT
