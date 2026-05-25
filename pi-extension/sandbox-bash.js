/**
 * Sandbox-Box Bash Extension for pi
 * Uses @sandbox-box/containers SDK for all operations
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── SDK ───────────────────────────────────────────────────────────────
const {
  initDriver, getDriver, getContainer, listContainers,
} = require('@sandbox-box/containers');

// Auto-init SDK driver (connects to local web-ui via loopback)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sandbox2024';
const SANDBOX_BOX_URL = process.env.SANDBOX_BOX_URL || 'http://localhost:3000';

let sdkReady = false;
try {
  initDriver({ type: 'sandbox-box', baseUrl: SANDBOX_BOX_URL, password: ADMIN_PASSWORD });
  sdkReady = true;
} catch (e) {
  console.warn(`[sandbox-bash] SDK init failed: ${e.message}. Falling back to CLI.`);
}

// ─── State ─────────────────────────────────────────────────────────────
const ACTIVE_SANDBOX_FILE = '/root/data/active-sandbox';

function getActiveSandbox() {
  if (process.env.PI_SANDBOX) return process.env.PI_SANDBOX;
  try {
    if (fs.existsSync(ACTIVE_SANDBOX_FILE)) {
      return fs.readFileSync(ACTIVE_SANDBOX_FILE, 'utf-8').trim();
    }
  } catch {}
  return null;
}

function escapeShellArg(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ─── Extension ─────────────────────────────────────────────────────────
module.exports = function(pi) {

  // ─── bash tool ────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'bash',
    description: 'Execute bash commands inside the active sandbox. All commands execute in a fully isolated namespace (PID/mount/network/UTS). Use switch_sandbox first to select which sandbox to work in.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
        description: { type: 'string', description: 'Brief description of what this command does' },
      },
      required: ['command'],
    },

    async execute(_toolCallId, { command, timeout = 120000, description }, signal, onUpdate, _ctx) {
      const sandboxName = getActiveSandbox();
      if (!sandboxName) return execRaw(command, timeout, signal, onUpdate);

      // Try SDK first, fall back to nsenter
      if (sdkReady) {
        try {
          const result = await getContainer(sandboxName).exec(command);
          const text = result.stdout + (result.stderr ? '\n--- stderr ---\n' + result.stderr : '');
          if (onUpdate) onUpdate({ content: [{ type: 'text', text }] });
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          // SDK failed, fall through to nsenter
          if (onUpdate) onUpdate({ content: [{ type: 'text', text: `SDK exec failed: ${e.message}. Falling back to nsenter.\n` }] });
        }
      }

      return execInSandbox(sandboxName, command, timeout, signal, onUpdate);
    },
  });

  // ─── switch_sandbox tool ─────────────────────────────────────────────
  pi.registerTool({
    name: 'switch_sandbox',
    description: 'Switch the active sandbox for bash command execution. Lists all available sandboxes if name is not found. Use this when you need to work in a different sandbox.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sandbox name to switch to. Use list_sandboxes to see all available.' },
      },
      required: ['name'],
    },

    async execute(_toolCallId, { name }) {
      // Verify via SDK
      if (sdkReady) {
        try {
          const containers = await getDriver().list();
          const found = containers.find(c => c.name === name && c.state.status === 'running');
          if (!found) {
            const running = containers.filter(c => c.state.status === 'running').map(c => c.name);
            return {
              content: [{
                type: 'text',
                text: `Error: Sandbox "${name}" is not running.\n\nRunning sandboxes:\n  ${running.join('\n  ')}`,
              }],
            };
          }
          fs.writeFileSync(ACTIVE_SANDBOX_FILE, name);
          return {
            content: [{ type: 'text', text: `✓ Switched to sandbox "${name}". All bash commands will now execute inside this sandbox (PID ${found.state.pid || '?'}).` }],
          };
        } catch (e) {
          // SDK failed, fall through to CLI
        }
      }

      // CLI fallback
      try {
        const output = require('child_process').execSync('sandbox list', { encoding: 'utf-8', timeout: 10000 });
        const lines = output.split('\n').filter(l => l.trim());
        const found = lines.some(l => {
          const parts = l.trim().split(/\s+/);
          return parts[0] === name && l.includes('running');
        });
        if (!found) {
          const running = lines.filter(l => l.includes('running')).map(l => l.split(/\s+/)[0]);
          return {
            content: [{ type: 'text', text: `Error: Sandbox "${name}" is not running.\n\nRunning sandboxes:\n  ${running.join('\n  ')}` }],
          };
        }
        fs.writeFileSync(ACTIVE_SANDBOX_FILE, name);
        return { content: [{ type: 'text', text: `✓ Switched to sandbox "${name}" (via CLI).` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error switching sandbox: ${e.message}` }] };
      }
    },
  });

  // ─── list_sandboxes tool ─────────────────────────────────────────────
  pi.registerTool({
    name: 'list_sandboxes',
    description: 'List all sandboxes with their status, IP, PID, and domain. Shows which sandbox is currently active.',
    parameters: { type: 'object', properties: {} },

    async execute() {
      const active = getActiveSandbox();

      if (sdkReady) {
        try {
          const containers = await getDriver().list();
          if (containers.length === 0) {
            return { content: [{ type: 'text', text: 'No sandboxes found.' }] };
          }

          // Table header
          const header = 'NAME                 STATUS    PID       IP               DOMAIN';
          const sep    = '─'.repeat(78);
          const rows = containers.map(c => {
            const name = c.name.padEnd(20).slice(0, 20);
            const status = (c.state.status || '?').padEnd(9).slice(0, 9);
            const pid = String(c.state.pid || '-').padEnd(9).slice(0, 9);
            const ip = (c.state.ip || '-').padEnd(16).slice(0, 16);
            const domain = c.state.domain || (c.name ? `${c.name}.sandbox.19930810.xyz` : '-');
            const marker = c.name === active ? ' ◀ active' : '';
            return `${name}${status}${pid}${ip}${domain}${marker}`;
          });

          const stats = `${containers.filter(c => c.state.status === 'running').length} running, ${containers.filter(c => c.state.status === 'stopped').length} stopped`;

          return {
            content: [{ type: 'text', text: `Sandboxes:\n${sep}\n${header}\n${sep}\n${rows.join('\n')}\n${sep}\n${stats}` }],
          };
        } catch (e) {
          // SDK failed, fall through to CLI
        }
      }

      // CLI fallback
      try {
        const output = require('child_process').execSync('sandbox list', { encoding: 'utf-8', timeout: 10000 });
        let result = output;
        if (active) result += `\n\nActive sandbox: ${active}`;
        return { content: [{ type: 'text', text: result }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
      }
    },
  });
};

// ─── Direct exec helper (no sandbox) ────────────────────────────────────
function execRaw(command, timeout, signal, onUpdate) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: '/root' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (onUpdate) onUpdate({ content: [{ type: 'text', text: stdout }] });
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    if (signal) signal.addEventListener('abort', () => proc.kill('SIGTERM'));
    proc.on('close', (code) => {
      resolve({ content: [{ type: 'text', text: stdout + (stderr ? '\n--- stderr ---\n' + stderr : '') }] });
    });
    proc.on('error', (err) => {
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}

// ─── nsenter-based sandbox exec (fallback) ─────────────────────────────
function execInSandbox(sandboxName, command, timeout, signal, onUpdate) {
  return new Promise((resolve) => {
    const escapedCmd = escapeShellArg(command);
    const fullCmd = `sandbox ${sandboxName} ${escapedCmd}`;
    const proc = spawn('bash', ['-c', fullCmd], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: '/root' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (onUpdate) onUpdate({ content: [{ type: 'text', text: stdout }] });
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    if (signal) signal.addEventListener('abort', () => proc.kill('SIGTERM'));
    proc.on('close', (code) => {
      resolve({
        content: [{ type: 'text', text: stdout + (stderr ? '\n--- stderr ---\n' + stderr : '') }],
      });
    });
    proc.on('error', (err) => {
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}
