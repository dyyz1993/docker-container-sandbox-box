const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 3000;
const WEB_DIR = __dirname;
const SANDBOX_CMD = '/usr/local/bin/sandbox';
const WORKSPACE_ROOT = '/root/data/sandboxes';
const CGROUP_ROOT = '/sys/fs/cgroup';
const PROJECTS_FILE = '/root/data/projects.json';
const USERS_FILE = '/root/data/users.json';

function validatePath(p) {
  if (!p || p.includes('..') || !p.startsWith('/')) {
    return false;
  }
  return true;
}

function safePath(base, relative) {
  const resolved = path.posix.normalize(path.posix.join(base, relative));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readJsonFile(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function generateId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    + '-' + Date.now().toString(36);
}

function sanitizeForShell(str) {
  return str.replace(/['"\\`$]/g, '');
}

// ============================================================
// EXISTING ENDPOINTS
// ============================================================

async function handleListSandboxes(req, res) {
  try {
    const output = execSync(`${SANDBOX_CMD} list 2>&1`, { encoding: 'utf-8', timeout: 10000 });
    const lines = output.trim().split('\n').filter(l => l.trim());
    const sandboxes = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4 && parts[0] && /^[a-zA-Z0-9_-]+$/.test(parts[0]) && parts[0] !== 'NAME') {
        sandboxes.push({
          name: parts[0] || '',
          status: parts[1] || 'unknown',
          port: parts[2] || '',
          domain: parts[3] || '',
          pid: parts[4] || ''
        });
      }
    }
    sendJSON(res, 200, sandboxes);
  } catch (e) {
    if (e.stdout && typeof e.stdout === 'string') {
      const lines = e.stdout.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        sendJSON(res, 200, []);
        return;
      }
    }
    sendJSON(res, 200, []);
  }
}

async function handleCreateSandbox(req, res) {
  try {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendError(res, 400, 'Invalid sandbox name. Use alphanumeric, hyphens, underscores only.');
    }
    const output = execSync(`${SANDBOX_CMD} create ${name} 2>&1`, { encoding: 'utf-8', timeout: 60000 });
    sendJSON(res, 200, { success: true, message: output.trim() });
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to create sandbox');
  }
}

async function handleDestroySandbox(req, res, name) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const output = execSync(`${SANDBOX_CMD} destroy ${name} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
    sendJSON(res, 200, { success: true, message: output.trim() });
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to destroy sandbox');
  }
}

async function handleListFiles(req, res, sandboxName, queryPath) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const dirPath = queryPath || '/';
    if (!validatePath(dirPath)) {
      return sendError(res, 400, 'Invalid path');
    }
    const fullPath = `${WORKSPACE_ROOT}/${sandboxName}/workspace${dirPath === '/' ? '' : dirPath}`;
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(path.normalize(`${WORKSPACE_ROOT}/${sandboxName}/workspace`))) {
      return sendError(res, 400, 'Path traversal detected');
    }
    const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const entryPath = path.join(normalizedPath, entry.name);
      let size = 0;
      let mtime = '';
      try {
        const stat = fs.statSync(entryPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch (_) {}
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        mtime
      };
    });
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJSON(res, 200, files);
  } catch (e) {
    if (e.code === 'ENOENT') {
      sendError(res, 404, 'Directory not found');
    } else if (e.code === 'ENOTDIR') {
      sendError(res, 400, 'Not a directory');
    } else {
      sendError(res, 500, e.message);
    }
  }
}

async function handleReadFile(req, res, sandboxName, queryPath) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    if (!queryPath || !validatePath(queryPath)) {
      return sendError(res, 400, 'Invalid path');
    }
    const fullPath = `${WORKSPACE_ROOT}/${sandboxName}/workspace${queryPath}`;
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(path.normalize(`${WORKSPACE_ROOT}/${sandboxName}/workspace`))) {
      return sendError(res, 400, 'Path traversal detected');
    }
    const stat = fs.statSync(normalizedPath);
    if (stat.isDirectory()) {
      return sendError(res, 400, 'Path is a directory');
    }
    if (stat.size > 5 * 1024 * 1024) {
      return sendError(res, 400, 'File too large (max 5MB)');
    }
    const content = fs.readFileSync(normalizedPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      sendError(res, 404, 'File not found');
    } else {
      sendError(res, 500, e.message);
    }
  }
}

async function handleWriteFile(req, res, sandboxName) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const body = await readBody(req);
    const filePath = body.path || '';
    const content = body.content !== undefined ? body.content : '';
    if (!filePath || !validatePath(filePath)) {
      return sendError(res, 400, 'Invalid path');
    }
    const fullPath = `${WORKSPACE_ROOT}/${sandboxName}/workspace${filePath}`;
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(path.normalize(`${WORKSPACE_ROOT}/${sandboxName}/workspace`))) {
      return sendError(res, 400, 'Path traversal detected');
    }
    const dir = path.dirname(normalizedPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(normalizedPath, content, 'utf-8');
    sendJSON(res, 200, { success: true, message: 'File saved' });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleSystemStats(req, res) {
  try {
    let cpuPercent = 0;
    try {
      const stat1 = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0];
      const vals1 = stat1.split(/\s+/).slice(1).map(Number);
      const total1 = vals1.reduce((a, b) => a + b, 0);
      const idle1 = vals1[3];
      await new Promise(r => setTimeout(r, 200));
      const stat2 = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0];
      const vals2 = stat2.split(/\s+/).slice(1).map(Number);
      const total2 = vals2.reduce((a, b) => a + b, 0);
      const idle2 = vals2[3];
      const totalDiff = total2 - total1;
      const idleDiff = idle2 - idle1;
      cpuPercent = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 1000) / 10 : 0;
    } catch (_) {}

    let memTotal = 0, memAvailable = 0;
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
      for (const line of meminfo.split('\n')) {
        const match = line.match(/^(\w+):\s+(\d+)/);
        if (match) {
          if (match[1] === 'MemTotal') memTotal = parseInt(match[2]) * 1024;
          if (match[1] === 'MemAvailable') memAvailable = parseInt(match[2]) * 1024;
        }
      }
    } catch (_) {}
    const memUsed = memTotal - memAvailable;
    const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;

    let diskTotal = '0', diskUsed = '0', diskAvailable = '0', diskPercent = 0;
    try {
      const dfOutput = execSync('df -h / 2>/dev/null', { encoding: 'utf-8' });
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        diskTotal = parts[1] || '0';
        diskUsed = parts[2] || '0';
        diskAvailable = parts[3] || '0';
        diskPercent = parseFloat((parts[4] || '0%').replace('%', ''));
      }
    } catch (_) {}

    let uptime = 0;
    try {
      const uptimeStr = fs.readFileSync('/proc/uptime', 'utf-8').trim();
      uptime = parseFloat(uptimeStr.split(' ')[0]);
    } catch (_) {}

    let sandboxCount = 0;
    try {
      const output = execSync(`${SANDBOX_CMD} list 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      const lines = output.trim().split('\n').filter(l => l.trim());
      sandboxCount = lines.filter(l => {
        const p = l.split(/\s+/);
        return p[0] && p[0] !== 'NAME' && p[0] !== '';
      }).length;
    } catch (_) {}

    sendJSON(res, 200, {
      cpu: { percent: cpuPercent },
      memory: {
        total: memTotal,
        used: memUsed,
        available: memAvailable,
        percent: memPercent
      },
      disk: {
        total: diskTotal,
        used: diskUsed,
        available: diskAvailable,
        percent: diskPercent
      },
      uptime,
      sandboxCount
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleSandboxStats(req, res, sandboxName) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }

    let memCurrent = 0, memMax = 0;
    try {
      memCurrent = parseInt(fs.readFileSync(`${CGROUP_ROOT}/sandbox-${sandboxName}/memory.current`, 'utf-8').trim()) || 0;
    } catch (_) {}
    try {
      const maxStr = fs.readFileSync(`${CGROUP_ROOT}/sandbox-${sandboxName}/memory.max`, 'utf-8').trim();
      memMax = maxStr === 'max' ? 0 : (parseInt(maxStr) || 0);
    } catch (_) {}

    let cpuPercent = 0;
    let processes = 0;
    try {
      const listOutput = execSync(`${SANDBOX_CMD} list 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      const lines = listOutput.trim().split('\n');
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0] === sandboxName && parts[4]) {
          const pid = parts[4];
          try {
            const psOutput = execSync(`ps -p ${pid} -o %cpu,rss 2>/dev/null`, { encoding: 'utf-8' });
            const psLines = psOutput.trim().split('\n');
            if (psLines.length >= 2) {
              const psParts = psLines[1].trim().split(/\s+/);
              cpuPercent = parseFloat(psParts[0]) || 0;
            }
          } catch (_) {}
          try {
            const pgrepOutput = execSync(`pgrep -P ${pid} 2>/dev/null || echo "${pid}"`, { encoding: 'utf-8' });
            const pids = pgrepOutput.trim().split('\n').filter(p => p.trim());
            processes = pids.length + 1;
          } catch (_) {
            processes = 1;
          }
          break;
        }
      }
    } catch (_) {}

    sendJSON(res, 200, {
      cpu: cpuPercent,
      memory: {
        current: memCurrent,
        max: memMax
      },
      processes
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleListDomains(req, res) {
  try {
    const confDir = '/etc/nginx/conf.d';
    let files = [];
    try {
      files = fs.readdirSync(confDir).filter(f => /^sandbox-.*\.conf$/.test(f));
    } catch (_) {}

    const domains = [];
    for (const file of files) {
      const sandboxName = file.replace(/^sandbox-/, '').replace(/\.conf$/, '');
      let content;
      try {
        content = fs.readFileSync(path.join(confDir, file), 'utf-8');
      } catch (_) { continue; }

      const serverBlocks = content.match(/server\s*\{[^}]*\}/gs) || [];
      for (const block of serverBlocks) {
        const serverNameMatch = block.match(/server_name\s+([^;]+);/);
        const proxyPassMatch = block.match(/proxy_pass\s+([^;]+);/);
        if (!serverNameMatch || !proxyPassMatch) continue;

        const domain = serverNameMatch[1].trim().split(/\s+/)[0];
        const proxyUrl = proxyPassMatch[1].trim().replace(/^https?:\/\//, '');
        const type = domain.startsWith('terminal-') ? 'terminal' : 'app';

        domains.push({ domain, sandbox: sandboxName, target: proxyUrl, type });
      }
    }
    sendJSON(res, 200, domains);
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

function serveStatic(req, res) {
  const htmlPath = path.join(WEB_DIR, 'index.html');
  try {
    const content = fs.readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch (e) {
    sendError(res, 404, 'index.html not found');
  }
}

// ============================================================
// NEW ENDPOINTS: Projects
// ============================================================

async function handleListProjects(req, res) {
  const projects = readJsonFile(PROJECTS_FILE);
  sendJSON(res, 200, projects);
}

async function handleCreateProject(req, res) {
  try {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const repoUrl = (body.repoUrl || '').trim();
    if (!name) {
      return sendError(res, 400, 'Project name is required');
    }
    if (!repoUrl) {
      return sendError(res, 400, 'Repository URL is required');
    }
    const projects = readJsonFile(PROJECTS_FILE);
    const id = generateId(name);
    const project = {
      id,
      name,
      repoUrl,
      createdAt: new Date().toISOString()
    };
    projects.push(project);
    writeJsonFile(PROJECTS_FILE, projects);
    sendJSON(res, 200, project);
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to create project');
  }
}

async function handleDeleteProject(req, res, id) {
  try {
    const projects = readJsonFile(PROJECTS_FILE);
    const index = projects.findIndex(p => p.id === id);
    if (index === -1) {
      return sendError(res, 404, 'Project not found');
    }
    const removed = projects.splice(index, 1)[0];
    writeJsonFile(PROJECTS_FILE, projects);
    sendJSON(res, 200, { success: true, project: removed });
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to delete project');
  }
}

// ============================================================
// NEW ENDPOINTS: Clone into sandbox
// ============================================================

async function handleCloneSandbox(req, res) {
  try {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    let repoUrl = (body.repoUrl || '').trim();
    const branch = (body.branch || '').trim();
    const project = (body.project || '').trim();

    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendError(res, 400, 'Invalid sandbox name. Use alphanumeric, hyphens, underscores only.');
    }
    if (!repoUrl && project) {
      const projects = readJsonFile(PROJECTS_FILE);
      const found = projects.find(p => p.name === project || p.id === project);
      if (found && found.repoUrl) {
        repoUrl = found.repoUrl;
      }
    }
    if (!repoUrl) {
      return sendError(res, 400, 'Repository URL is required');
    }

    const safeUrl = sanitizeForShell(repoUrl);
    const safeBranch = branch ? sanitizeForShell(branch) : '';

    let cmd = `${SANDBOX_CMD} clone ${name} ${safeUrl}`;
    if (safeBranch) {
      cmd += ` --branch ${safeBranch}`;
    }

    const output = execSync(`${cmd} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
    sendJSON(res, 200, { success: true, message: output.trim() });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to clone sandbox');
    sendError(res, 500, msg);
  }
}

// ============================================================
// NEW ENDPOINTS: Git operations in sandbox
// ============================================================

async function handleGitStatus(req, res, sandboxName) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const cmd = `${SANDBOX_CMD} ${sandboxName} bash -c 'cd /workspace && git status --porcelain && echo --- && git branch --show-current && echo --- && git log --oneline -5' 2>&1`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
    const parts = output.trim().split('---');

    const statusLines = (parts[0] || '').trim().split('\n').filter(l => l.trim());
    const branch = (parts[1] || '').trim();
    const commitLines = (parts[2] || '').trim().split('\n').filter(l => l.trim());

    sendJSON(res, 200, {
      status: statusLines,
      branch,
      recentCommits: commitLines
    });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to get git status');
    sendError(res, 500, msg);
  }
}

async function handleGitPush(req, res, sandboxName) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const body = await readBody(req);
    const message = (body.message || `Update ${new Date().toISOString()}`).trim();
    const branch = (body.branch || '').trim();

    const safeMsg = sanitizeForShell(message);
    let cmd = `${SANDBOX_CMD} ${sandboxName} bash -c 'cd /workspace && git add -A && git commit -m "${safeMsg}" && git push origin HEAD' 2>&1`;

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    sendJSON(res, 200, { success: true, message: output.trim() });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to push');
    sendError(res, 500, msg);
  }
}

async function handleGitCheckout(req, res, sandboxName) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const body = await readBody(req);
    const branch = (body.branch || '').trim();
    if (!branch) {
      return sendError(res, 400, 'Branch name is required');
    }

    const safeBranch = sanitizeForShell(branch);
    const cmd = `${SANDBOX_CMD} ${sandboxName} bash -c 'cd /workspace && git checkout ${safeBranch}' 2>&1`;

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
    sendJSON(res, 200, { success: true, message: output.trim() });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to checkout branch');
    sendError(res, 500, msg);
  }
}

// ============================================================
// NEW ENDPOINTS: Users
// ============================================================

async function handleListUsers(req, res) {
  const users = readJsonFile(USERS_FILE);
  sendJSON(res, 200, users);
}

async function handleCreateUser(req, res) {
  try {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendError(res, 400, 'Invalid user name. Use alphanumeric, hyphens, underscores only.');
    }

    const sandboxName = `user-${name}`;
    const existingList = execSync(`${SANDBOX_CMD} list 2>&1`, { encoding: 'utf-8', timeout: 30000 });
    const alreadyExists = existingList.split('\n').some(line => {
      const parts = line.trim().split(/\s+/);
      return parts[0] === sandboxName;
    });
    if (!alreadyExists) {
      try {
        execSync(`${SANDBOX_CMD} create ${sandboxName} 2>&1`, { encoding: 'utf-8', timeout: 60000 });
      } catch (e) {
        return sendError(res, 500, `Failed to create sandbox for user: ${e.message}`);
      }
    }

    const users = readJsonFile(USERS_FILE);
    const id = generateId(name);
    const user = {
      id,
      name,
      sandboxName,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    writeJsonFile(USERS_FILE, users);
    sendJSON(res, 200, user);
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to create user');
  }
}

async function handleDeleteUser(req, res, id) {
  try {
    const users = readJsonFile(USERS_FILE);
    const index = users.findIndex(u => u.id === id);
    if (index === -1) {
      return sendError(res, 404, 'User not found');
    }
    const removed = users.splice(index, 1)[0];
    writeJsonFile(USERS_FILE, users);

    try {
      if (removed.sandboxName && /^[a-zA-Z0-9_-]+$/.test(removed.sandboxName)) {
        execSync(`${SANDBOX_CMD} destroy ${removed.sandboxName} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
      }
    } catch (_) {}

    sendJSON(res, 200, { success: true, user: removed });
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to delete user');
  }
}

// ============================================================
// WebSocket / RPC Chat Support
// ============================================================

const chatClients = new Set();

let rpcProcess = null;
let rpcRequestId = 0;
const rpcPending = new Map();
let rpcReady = false;
let messageHistory = [];
let currentState = null;

function broadcastToChat(data) {
  const msg = JSON.stringify(data);
  for (const ws of chatClients) {
    try { ws.send(msg); } catch {}
  }
}

function startRpc() {
  if (rpcProcess) return;

  const cwd = process.env.RPC_CWD || '/root';
  const args = ['--mode', 'rpc', '--no-session'];

  rpcProcess = spawn('pi', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  });

  let buffer = '';
  rpcProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleRpcEvent(event);
      } catch {}
    }
  });

  rpcProcess.stderr.on('data', () => {});

  rpcProcess.on('close', (code) => {
    rpcProcess = null;
    rpcReady = false;
    broadcastToChat({ type: 'status', status: 'stopped', code });
  });

  rpcProcess.on('error', (err) => {
    rpcProcess = null;
    rpcReady = false;
    broadcastToChat({ type: 'status', status: 'error', error: err.message });
  });
}

function stopRpc() {
  if (rpcProcess) {
    rpcProcess.kill('SIGTERM');
    setTimeout(() => { if (rpcProcess) rpcProcess.kill('SIGKILL'); }, 1000);
    rpcProcess = null;
    rpcReady = false;
  }
}

function sendRpcCommand(cmd) {
  if (!rpcProcess) return null;
  const id = 'req_' + (++rpcRequestId);
  cmd.id = id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rpcPending.delete(id); reject(new Error('timeout')); }, 30000);
    rpcPending.set(id, { resolve, reject, timer });
    rpcProcess.stdin.write(JSON.stringify(cmd) + '\n');
  });
}

function handleRpcEvent(event) {
  if (event.type === 'ready') {
    rpcReady = true;
    broadcastToChat({ type: 'status', status: 'ready' });
    return;
  }

  if (event.type === 'response' && event.id && rpcPending.has(event.id)) {
    const pending = rpcPending.get(event.id);
    rpcPending.delete(event.id);
    clearTimeout(pending.timer);
    pending.resolve(event);
    return;
  }

  if (event.type === 'message_update') {
    broadcastToChat({ type: 'stream', data: event });
  } else if (event.type === 'agent_end') {
    broadcastToChat({ type: 'done', data: event });
    sendRpcCommand({ type: 'get_full_messages' }).then(res => {
      if (res?.messages) {
        messageHistory = res.messages;
        broadcastToChat({ type: 'messages', messages: messageHistory });
      }
    }).catch(() => {});
  } else if (event.type === 'message_start') {
    broadcastToChat({ type: 'stream_start', data: event });
  } else {
    broadcastToChat({ type: 'event', data: event });
  }
}

// ============================================================
// ROUTER
// ============================================================

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // --- Existing routes ---

    if (method === 'GET' && pathname === '/api/sandboxes') {
      return await handleListSandboxes(req, res);
    }

    if (method === 'POST' && pathname === '/api/sandboxes/clone') {
      return await handleCloneSandbox(req, res);
    }

    if (method === 'POST' && pathname === '/api/sandboxes') {
      return await handleCreateSandbox(req, res);
    }

    // --- Projects routes ---

    if (method === 'GET' && pathname === '/api/projects') {
      return await handleListProjects(req, res);
    }

    if (method === 'POST' && pathname === '/api/projects') {
      return await handleCreateProject(req, res);
    }

    const projectDeleteMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)$/);
    if (projectDeleteMatch && method === 'DELETE') {
      return await handleDeleteProject(req, res, projectDeleteMatch[1]);
    }

    // --- Users routes ---

    if (method === 'GET' && pathname === '/api/users') {
      return await handleListUsers(req, res);
    }

    if (method === 'POST' && pathname === '/api/users') {
      return await handleCreateUser(req, res);
    }

    const userDeleteMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/);
    if (userDeleteMatch && method === 'DELETE') {
      return await handleDeleteUser(req, res, userDeleteMatch[1]);
    }

    // --- Sandbox-specific routes ---

    const sandboxMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)\/(.+)$/);
    if (sandboxMatch) {
      const name = sandboxMatch[1];
      const subPath = sandboxMatch[2];

      if (method === 'DELETE' && !subPath.includes('/')) {
        return await handleDestroySandbox(req, res, name);
      }

      if (method === 'GET' && subPath === 'files') {
        const queryPath = url.searchParams.get('path') || '/';
        return await handleListFiles(req, res, name, queryPath);
      }

      if (method === 'GET' && subPath === 'files/read') {
        const queryPath = url.searchParams.get('path') || '';
        return await handleReadFile(req, res, name, queryPath);
      }

      if (method === 'PUT' && subPath === 'files/write') {
        return await handleWriteFile(req, res, name);
      }

      if (method === 'GET' && subPath === 'stats') {
        return await handleSandboxStats(req, res, name);
      }

      if (method === 'GET' && subPath === 'git/status') {
        return await handleGitStatus(req, res, name);
      }

      if (method === 'POST' && subPath === 'git/push') {
        return await handleGitPush(req, res, name);
      }

      if (method === 'POST' && subPath === 'git/checkout') {
        return await handleGitCheckout(req, res, name);
      }
    }

    // Also match bare sandbox name (no sub-path) for DELETE
    const destroyMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)$/);
    if (destroyMatch && method === 'DELETE') {
      return await handleDestroySandbox(req, res, destroyMatch[1]);
    }

    // --- Domain & Stats routes ---

    if (method === 'GET' && pathname === '/api/domains') {
      return await handleListDomains(req, res);
    }

    if (method === 'GET' && pathname === '/api/stats') {
      return await handleSystemStats(req, res);
    }

    // --- Chat API routes ---
    if (method === 'POST' && pathname === '/api/chat/start') { startRpc(); sendJSON(res, 200, { status: 'starting' }); return; }
    if (method === 'POST' && pathname === '/api/chat/stop') { stopRpc(); sendJSON(res, 200, { status: 'stopped' }); return; }
    if (method === 'POST' && pathname === '/api/chat/prompt') {
      readBody(req).then(body => {
        sendRpcCommand({ type: 'prompt', message: body.message }).then(r => sendJSON(res, 200, r)).catch(e => sendError(res, 500, e.message));
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/chat/status') { sendJSON(res, 200, { running: !!rpcProcess, ready: rpcReady }); return; }
    if (method === 'GET' && pathname === '/api/chat/messages') { sendJSON(res, 200, { messages: messageHistory }); return; }

    // --- Static fallback ---
    return serveStatic(req, res);
  } catch (e) {
    sendError(res, 500, e.message || 'Internal server error');
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Sandbox Box Web UI running on http://0.0.0.0:${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/chat') {
    const acceptKey = req.headers['sec-websocket-key'];
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1')
      .update(acceptKey + '258EAFA5-E914-47DA-95CA-5AB5DC65B283')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );

    const ws = { socket, send: (data) => sendWsFrame(socket, data) };
    chatClients.add(ws);

    socket.on('data', (buf) => {
      const msgs = parseWsFrames(buf);
      for (const msg of msgs) {
        handleChatMessage(ws, msg);
      }
    });

    socket.on('close', () => chatClients.delete(ws));
    socket.on('error', () => chatClients.delete(ws));
  }
});

function sendWsFrame(socket, data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseWsFrames(buf) {
  const msgs = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 2 > buf.length) break;
    const firstByte = buf[offset];
    const op = firstByte & 0x0f;
    if (op === 0x8) break;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    if (masked) headerLen += 4;
    if (offset + headerLen + payloadLen > buf.length) break;
    let payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen);
    if (masked) {
      const maskKey = buf.slice(offset + headerLen - 4, offset + headerLen);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    if (op === 0x1) {
      try { msgs.push(JSON.parse(payload.toString())); } catch { msgs.push({ raw: payload.toString() }); }
    }
    offset += headerLen + payloadLen;
  }
  return msgs;
}

async function handleChatMessage(ws, msg) {
  try {
    switch (msg.action) {
      case 'start':
        startRpc();
        break;
      case 'stop':
        stopRpc();
        break;
      case 'prompt':
        if (!rpcReady) { ws.send(JSON.stringify({ type: 'error', error: 'RPC not ready' })); return; }
        await sendRpcCommand({ type: 'prompt', message: msg.message });
        break;
      case 'abort':
        await sendRpcCommand({ type: 'abort' });
        break;
      case 'get_messages':
        if (!rpcReady) { ws.send(JSON.stringify({ type: 'messages', messages: messageHistory })); return; }
        const res = await sendRpcCommand({ type: 'get_full_messages' });
        if (res?.messages) { messageHistory = res.messages; ws.send(JSON.stringify({ type: 'messages', messages: messageHistory })); }
        break;
      case 'get_models':
        const models = await sendRpcCommand({ type: 'get_available_models' });
        ws.send(JSON.stringify({ type: 'models', models: models?.models || [] }));
        break;
      case 'set_model':
        await sendRpcCommand({ type: 'set_model', provider: msg.provider, modelId: msg.modelId });
        break;
      case 'get_state':
        const state = await sendRpcCommand({ type: 'get_state' });
        ws.send(JSON.stringify({ type: 'state', state }));
        break;
      case 'get_tools':
        const tools = await sendRpcCommand({ type: 'get_active_tools' });
        ws.send(JSON.stringify({ type: 'tools', tools: tools?.tools || [] }));
        break;
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', error: err.message }));
  }
}
