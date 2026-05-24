const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const PORT = 3000;
const WEB_DIR = __dirname;
const SANDBOX_CMD = '/usr/local/bin/sandbox';
const SANDBOX_CLONE_CMD = '/usr/local/bin/sandbox-clone.sh';
const WORKSPACE_ROOT = '/root/data/sandboxes';
const CGROUP_ROOT = '/sys/fs/cgroup';
const PROJECTS_FILE = '/root/data/projects.json';
const USERS_FILE = '/root/data/users.json';
const DB_PATH = process.env.SANDBOX_DB || '/root/data/sandbox.db';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sandbox2024';
const AUTH_SECRET = process.env.AUTH_SECRET || 'sandbox-box-secret-key';
const TOKEN_EXPIRY = 86400;

function generateToken() {
  const payload = JSON.stringify({
    password: ADMIN_PASSWORD,
    exp: Date.now() + TOKEN_EXPIRY * 1000
  });
  return crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
}

function validateToken(token) {
  if (!token) return false;
  const expectedToken = generateToken();
  return token === expectedToken;
}

function authMiddleware(req, res) {
  if (req.url === '/api/auth/login' || req.url === '/api/health') {
    return true;
  }
  if (!req.url.startsWith('/api/')) {
    return true;
  }
  const token = (req.headers.authorization && req.headers.authorization.replace('Bearer ', '')) ||
    new URL(req.url, 'http://localhost').searchParams.get('token');
  if (!validateToken(token)) {
    sendJSON(res, 401, { error: 'Unauthorized', message: 'Invalid or missing token' });
    return false;
  }
  return true;
}

let db;
try {
  const Database = require('better-sqlite3');
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const columns = db.prepare("PRAGMA table_info(sandboxes)").all().map(c => c.name);
  if (!columns.includes('user_id')) db.exec("ALTER TABLE sandboxes ADD COLUMN user_id TEXT");
  if (!columns.includes('project_id')) db.exec("ALTER TABLE sandboxes ADD COLUMN project_id TEXT");
  if (!columns.includes('branch')) db.exec("ALTER TABLE sandboxes ADD COLUMN branch TEXT");
  if (!columns.includes('purpose')) db.exec("ALTER TABLE sandboxes ADD COLUMN purpose TEXT");

  console.log('SQLite database initialized at', DB_PATH);
} catch (e) {
  console.warn('better-sqlite3 not available, falling back to JSON files:', e.message);
  db = null;
}

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
    const activeSandbox = fs.existsSync('/root/data/active-sandbox')
      ? fs.readFileSync('/root/data/active-sandbox', 'utf-8').trim()
      : null;
    sendJSON(res, 200, { sandboxes, activeSandbox });
  } catch (e) {
    if (e.stdout && typeof e.stdout === 'string') {
      const lines = e.stdout.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        sendJSON(res, 200, { sandboxes: [], activeSandbox: null });
        return;
      }
    }
    sendJSON(res, 200, { sandboxes: [], activeSandbox: null });
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
    fs.writeFileSync('/root/data/active-sandbox', name, 'utf-8');
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

    const activeSandbox = fs.existsSync('/root/data/active-sandbox')
      ? fs.readFileSync('/root/data/active-sandbox', 'utf-8').trim()
      : null;
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
      sandboxCount,
      activeSandbox
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
  try {
    if (db) {
      const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
      const countStmt = db.prepare("SELECT COUNT(*) as cnt FROM sandboxes WHERE project_id = ?");
      for (const p of projects) {
        const row = countStmt.get(p.id);
        p.sandboxCount = row?.cnt || 0;
      }
      sendJSON(res, 200, projects);
    } else {
      const projects = readJsonFile(PROJECTS_FILE);
      sendJSON(res, 200, projects);
    }
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to list projects');
  }
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
    const id = generateId(name);
    if (db) {
      db.prepare('INSERT INTO projects (id, name, repo_url) VALUES (?, ?, ?)').run(id, name, repoUrl);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      sendJSON(res, 200, project);
    } else {
      const projects = readJsonFile(PROJECTS_FILE);
      const project = { id, name, repoUrl, createdAt: new Date().toISOString() };
      projects.push(project);
      writeJsonFile(PROJECTS_FILE, projects);
      sendJSON(res, 200, project);
    }
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to create project');
  }
}

async function handleDeleteProject(req, res, id) {
  try {
    if (db) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (!project) {
        return sendError(res, 404, 'Project not found');
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      sendJSON(res, 200, { success: true, project });
    } else {
      const projects = readJsonFile(PROJECTS_FILE);
      const index = projects.findIndex(p => p.id === id);
      if (index === -1) {
        return sendError(res, 404, 'Project not found');
      }
      const removed = projects.splice(index, 1)[0];
      writeJsonFile(PROJECTS_FILE, projects);
      sendJSON(res, 200, { success: true, project: removed });
    }
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
      if (db) {
        const found = db.prepare('SELECT * FROM projects WHERE name = ? OR id = ?').get(project, project);
        if (found && found.repo_url) {
          repoUrl = found.repo_url;
        }
      } else {
        const projects = readJsonFile(PROJECTS_FILE);
        const found = projects.find(p => p.name === project || p.id === project);
        if (found && found.repoUrl) {
          repoUrl = found.repoUrl;
        }
      }
    }
    if (!repoUrl) {
      return sendError(res, 400, 'Repository URL is required');
    }

    const safeUrl = sanitizeForShell(repoUrl);
    const safeBranch = branch ? sanitizeForShell(branch) : '';

    let cmd = `${SANDBOX_CLONE_CMD} ${name} ${safeUrl}`;
    if (safeBranch) {
      cmd += ` --branch ${safeBranch}`;
    }

    const output = execSync(`${cmd} 2>&1`, { encoding: 'utf-8', timeout: 120000 });
    fs.writeFileSync('/root/data/active-sandbox', name, 'utf-8');
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
  try {
    if (db) {
      const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
      const sbStmt = db.prepare("SELECT name, status, domain FROM sandboxes WHERE user_id = ?");
      for (const u of users) {
        const sandboxes = sbStmt.all(u.id);
        u.sandboxes = sandboxes;
        u.sandboxCount = sandboxes.length;
      }
      sendJSON(res, 200, users);
    } else {
      const users = readJsonFile(USERS_FILE);
      sendJSON(res, 200, users);
    }
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to list users');
  }
}

async function handleCreateUser(req, res) {
  try {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
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

    fs.writeFileSync('/root/data/active-sandbox', sandboxName, 'utf-8');

    const id = generateId(name);
    if (db) {
      db.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)').run(id, name, email || null);
      db.prepare('UPDATE sandboxes SET user_id = ? WHERE name = ?').run(id, sandboxName);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      user.sandboxName = sandboxName;
      sendJSON(res, 200, user);
    } else {
      const users = readJsonFile(USERS_FILE);
      const user = {
        id,
        name,
        sandboxName,
        createdAt: new Date().toISOString()
      };
      users.push(user);
      writeJsonFile(USERS_FILE, users);
      sendJSON(res, 200, user);
    }
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to create user');
  }
}

async function handleDeleteUser(req, res, id) {
  try {
    let removed;
    if (db) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!user) {
        return sendError(res, 404, 'User not found');
      }
      removed = user;
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } else {
      const users = readJsonFile(USERS_FILE);
      const index = users.findIndex(u => u.id === id);
      if (index === -1) {
        return sendError(res, 404, 'User not found');
      }
      removed = users.splice(index, 1)[0];
      writeJsonFile(USERS_FILE, users);
    }

    const sandboxName = removed.sandboxName || (removed.name ? `user-${removed.name}` : '');
    try {
      if (sandboxName && /^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
        execSync(`${SANDBOX_CMD} destroy ${sandboxName} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
      }
    } catch (_) {}

    sendJSON(res, 200, { success: true, user: removed });
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to delete user');
  }
}

// ============================================================
// NEW ENDPOINTS: Workspaces
// ============================================================

async function handleCreateWorkspace(req, res) {
  try {
    if (!db) {
      return sendError(res, 501, 'Workspaces require SQLite database');
    }
    const body = await readBody(req);
    const userId = (body.userId || '').trim();
    const projectId = (body.projectId || '').trim();
    const branch = (body.branch || 'main').trim();
    const purpose = (body.purpose || '').trim();
    const sandboxName = (body.sandboxName || '').trim() || null;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!user || !project) {
      return sendError(res, 404, 'User or project not found');
    }

    const name = sandboxName || `${user.name}-${project.name}-${branch}`.substring(0, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendError(res, 400, 'Invalid sandbox name generated');
    }

    const safeUrl = sanitizeForShell(project.repo_url || '');
    const safeBranch = sanitizeForShell(branch);
    if (!safeUrl) {
      return sendError(res, 400, 'Project has no repository URL');
    }

    let cmd = `${SANDBOX_CLONE_CMD} ${name} ${safeUrl}`;
    if (safeBranch && safeBranch !== 'main') {
      cmd += ` --branch ${safeBranch}`;
    }
    execSync(`${cmd} 2>&1`, { encoding: 'utf-8', timeout: 120000 });
    fs.writeFileSync('/root/data/active-sandbox', name, 'utf-8');

    if (safeBranch && safeBranch !== 'main') {
      try {
        execSync(`${SANDBOX_CMD} ${name} bash -c 'cd /workspace && git checkout -b ${safeBranch}' 2>&1`, {
          encoding: 'utf-8', timeout: 15000
        });
      } catch (_) {}
    }

    try {
      const dir = '/root/data';
      const confPath = `${dir}/git-token.conf`;
      if (fs.existsSync(confPath)) {
        const confContent = fs.readFileSync(confPath, 'utf-8');
        const getToken = (line) => { const m = line.match(/="(.*)"/); return m ? m[1] : ''; };
        const gProviderUrl = confContent.split('\n').find(l => l.startsWith('GIT_PROVIDER_URL'));
        const gToken = confContent.split('\n').find(l => l.startsWith('GIT_TOKEN'));
        const gTokenUser = confContent.split('\n').find(l => l.startsWith('GIT_TOKEN_USER'));
        if (gProviderUrl && gToken) {
          const pUrl = getToken(gProviderUrl);
          const tk = getToken(gToken);
          const tu = gTokenUser ? getToken(gTokenUser) : 'oauth2';
          if (tk) {
            const sbRow = db.prepare('SELECT pid FROM sandboxes WHERE name = ?').get(name);
            if (sbRow && sbRow.pid) {
              execSync(
                `nsenter -t ${sbRow.pid} -m -n -p -u -- bash -c 'export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ` +
                `git config --global credential.helper "store --file /root/.git-credentials"; ` +
                `echo "https://${tu}:${tk}@${pUrl}" > /root/.git-credentials; ` +
                `git config --global user.email "sandbox@sandbox-box.local"; ` +
                `git config --global user.name "Sandbox Box"; ` +
                `chmod 600 /root/.git-credentials'`,
                { timeout: 5000 }
              );
            }
          }
        }
      }
    } catch (_) {}

    db.prepare('UPDATE sandboxes SET user_id = ?, project_id = ?, branch = ?, purpose = ? WHERE name = ?')
      .run(userId, projectId, branch, purpose || null, name);

    const workspace = db.prepare(
      `SELECT s.*, u.name as user_name, p.name as project_name
       FROM sandboxes s
       LEFT JOIN users u ON s.user_id = u.id
       LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.name = ?`
    ).get(name);

    sendJSON(res, 200, { workspace });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to create workspace');
    sendError(res, 500, msg);
  }
}

async function handleListWorkspaces(req, res) {
  try {
    if (!db) {
      return sendError(res, 501, 'Workspaces require SQLite database');
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let sql = `SELECT s.*, u.name as user_name, p.name as project_name
               FROM sandboxes s
               LEFT JOIN users u ON s.user_id = u.id
               LEFT JOIN projects p ON s.project_id = p.id
               WHERE s.user_id IS NOT NULL OR s.project_id IS NOT NULL`;
    const params = [];
    const userId = url.searchParams.get('userId');
    const projectId = url.searchParams.get('projectId');
    if (userId) { sql += ' AND s.user_id = ?'; params.push(userId); }
    if (projectId) { sql += ' AND s.project_id = ?'; params.push(projectId); }
    sql += ' ORDER BY s.created_at DESC';

    const workspaces = db.prepare(sql).all(...params);
    sendJSON(res, 200, workspaces);
  } catch (e) {
    sendError(res, 500, e.message || 'Failed to list workspaces');
  }
}

async function handleDeleteWorkspace(req, res, sandboxName) {
  try {
    if (!db) {
      return sendError(res, 501, 'Workspaces require SQLite database');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxName)) {
      return sendError(res, 400, 'Invalid sandbox name');
    }
    const workspace = db.prepare(
      `SELECT s.*, u.name as user_name, p.name as project_name
       FROM sandboxes s
       LEFT JOIN users u ON s.user_id = u.id
       LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.name = ?`
    ).get(sandboxName);
    if (!workspace) {
      return sendError(res, 404, 'Workspace not found');
    }
    execSync(`${SANDBOX_CMD} destroy ${sandboxName} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
    sendJSON(res, 200, { success: true, workspace });
  } catch (e) {
    const msg = (e.stderr && typeof e.stderr === 'string') ? e.stderr.trim() : (e.message || 'Failed to delete workspace');
    sendError(res, 500, msg);
  }
}

// ============================================================
// Git token management
// ============================================================

function handleGetGitConfig(req, res) {
    const confPath = '/root/data/git-token.conf';
    if (fs.existsSync(confPath)) {
        const content = fs.readFileSync(confPath, 'utf-8');
        const providerUrl = content.match(/GIT_PROVIDER_URL="([^"]+)"/)?.[1] || '';
        const tokenUser = content.match(/GIT_TOKEN_USER="([^"]+)"/)?.[1] || 'oauth2';
        const hasToken = content.includes('GIT_TOKEN=') && content.match(/GIT_TOKEN="([^"]+)"/)?.[1]?.length > 0;
        sendJSON(res, 200, { configured: hasToken, providerUrl, tokenUser, tokenMasked: hasToken ? '****' + content.match(/GIT_TOKEN="[^"]*(.{4})"/)?.[1] : '' });
    } else {
        sendJSON(res, 200, { configured: false });
    }
}

function handleSetGitConfig(req, res) {
    readBody(req).then(body => {
        const { providerUrl, token, tokenUser } = body;
        if (!providerUrl || !token) return sendError(res, 400, 'providerUrl and token are required');
        
        const dir = '/root/data';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const conf = `GIT_PROVIDER_URL="${providerUrl}"\nGIT_TOKEN="${token}"\nGIT_TOKEN_USER="${tokenUser || 'oauth2'}"\n`;
        fs.writeFileSync(`${dir}/git-token.conf`, conf);
        
        try {
            const sandboxes = db?.prepare?.('SELECT name, pid FROM sandboxes WHERE status = ?')?.all?.('running') || [];
            for (const sb of sandboxes) {
                const pid = sb.pid;
                if (!pid) continue;
                try {
                    execSync(
                        `nsenter -t ${pid} -m -n -p -u -- bash -c 'export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ` +
                        `git config --global credential.helper "store --file /root/.git-credentials"; ` +
                        `echo "https://${tokenUser || 'oauth2'}:${token}@${providerUrl}" > /root/.git-credentials; ` +
                        `chmod 600 /root/.git-credentials'`,
                        { timeout: 5000 }
                    );
                } catch (e) { /* skip failed sandboxes */ }
            }
        } catch (e) { /* no db */ }
        
        sendJSON(res, 200, { success: true, message: 'Git token configured and applied to running sandboxes' });
    }).catch(e => sendError(res, 500, e.message));
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
let currentStreamMsg = null;

function broadcastToChat(data) {
  const msg = JSON.stringify(data);
  for (const ws of chatClients) {
    try { ws.send(msg); } catch {}
  }
}

function startRpc() {
  if (rpcProcess) return;

  const cwd = process.env.RPC_CWD || '/root';
  const args = ['--mode', 'rpc', '--no-session', '--extension', '/root/.pi/agent/extensions/sandbox-box/index.js'];

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

function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n');
  }
  return String(content);
}

function extractToolData(content) {
  var toolCalls = [];
  var textParts = [];
  if (!content) return { text: '', toolCalls: toolCalls };
  if (typeof content === 'string') return { text: content, toolCalls: toolCalls };
  if (Array.isArray(content)) {
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'toolCall') {
        var args = '';
        if (typeof block.arguments === 'string') {
          args = block.arguments;
          try { args = JSON.stringify(JSON.parse(block.arguments), null, 2); } catch {}
        } else if (block.arguments) {
          args = JSON.stringify(block.arguments, null, 2);
        }
        toolCalls.push({
          id: block.id || '',
          name: block.name || 'unknown',
          arguments: args,
          result: ''
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name || 'unknown',
          arguments: block.input ? JSON.stringify(block.input, null, 2) : '',
          result: ''
        });
      } else if (block.type === 'tool_result') {
        toolCalls.push({
          name: 'tool_result',
          arguments: '',
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
        });
      }
    }
  }
  return { text: textParts.join('\n'), toolCalls: toolCalls };
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
    if (!currentStreamMsg) {
      currentStreamMsg = {
        id: 'msg-' + Date.now(),
        role: 'assistant',
        content: '',
        tool_calls: [],
        timestamp: new Date().toISOString()
      };
    }

    var partial = event.partial;
    if (partial && partial.content && Array.isArray(partial.content)) {
      for (var ci = 0; ci < partial.content.length; ci++) {
        var block = partial.content[ci];
        if (block.type === 'toolCall') {
          var tcEntry = {
            id: block.id || '',
            name: block.name || 'unknown',
            arguments: block.arguments || '',
            result: ''
          };
          if (!currentStreamMsg.tool_calls) currentStreamMsg.tool_calls = [];
          currentStreamMsg.tool_calls.push(tcEntry);
          broadcastToChat({
            type: 'tool_call',
            tool: { id: tcEntry.id, name: tcEntry.name, arguments: tcEntry.arguments }
          });
        }
      }
    }

    var aev = event.assistantMessageEvent;
    if (aev) {
      if (aev.type === 'text_delta') {
        currentStreamMsg.content += aev.delta || '';
      } else if (aev.type === 'tool_use') {
        var tcEntry2 = {
          id: aev.id || '',
          name: aev.name || 'unknown',
          arguments: aev.input ? JSON.stringify(aev.input, null, 2) : '',
          result: ''
        };
        if (!currentStreamMsg.tool_calls) currentStreamMsg.tool_calls = [];
        currentStreamMsg.tool_calls.push(tcEntry2);
        broadcastToChat({
          type: 'tool_call',
          tool: { id: tcEntry2.id, name: tcEntry2.name, arguments: tcEntry2.arguments }
        });
      }
    }

    broadcastToChat({ type: 'stream', data: event });

  } else if (event.type === 'tool_execution_start') {
    broadcastToChat({
      type: 'tool_execution',
      status: 'start',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: event.args
    });

  } else if (event.type === 'tool_execution_update') {
    var updateText = '';
    if (event.partialResult && event.partialResult.content && event.partialResult.content[0]) {
      updateText = event.partialResult.content[0].text || '';
    }
    broadcastToChat({
      type: 'tool_execution',
      status: 'update',
      output: updateText
    });

  } else if (event.type === 'tool_execution_end') {
    var endText = '';
    if (event.result && event.result.content && event.result.content[0]) {
      endText = event.result.content[0].text || '';
    }
    broadcastToChat({
      type: 'tool_execution',
      status: 'end',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      result: endText,
      isError: event.isError || false,
      durationMs: event.durationMs || 0
    });

  } else if (event.type === 'message_end') {
    broadcastToChat({ type: 'done', data: event });

  } else if (event.type === 'agent_end') {
    currentStreamMsg = null;
    if (event.messages && event.messages.length > 0) {
      var pendingToolCalls = [];
      for (var mi = 0; mi < event.messages.length; mi++) {
        var m = event.messages[mi];
        if (m.role === 'assistant') {
          var hasToolCall = false;
          if (Array.isArray(m.content)) {
            for (var k = 0; k < m.content.length; k++) {
              if (m.content[k].type === 'toolCall') { hasToolCall = true; break; }
            }
          }

          if (hasToolCall) {
            var msgEntry = {
              id: m.entryId || ('msg-' + Date.now() + '-' + mi),
              role: 'assistant',
              content: m.content,
              timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString()
            };
            var extracted = extractToolData(m.content);
            if (extracted.toolCalls.length > 0) {
              msgEntry.tool_calls = extracted.toolCalls;
              pendingToolCalls = extracted.toolCalls;
            }
            messageHistory.push(msgEntry);
          } else {
            var extracted2 = extractToolData(m.content);
            var msgEntry2 = {
              id: m.entryId || ('msg-' + Date.now() + '-' + mi),
              role: 'assistant',
              content: extracted2.text || flattenContent(m.content),
              timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString()
            };
            if (extracted2.toolCalls.length > 0) {
              msgEntry2.tool_calls = extracted2.toolCalls;
              pendingToolCalls = extracted2.toolCalls;
            } else {
              pendingToolCalls = [];
            }
            messageHistory.push(msgEntry2);
          }
        } else if (m.role === 'toolResult') {
          var toolResultMsg = {
            id: m.entryId || ('msg-' + Date.now() + '-' + mi),
            role: 'toolResult',
            content: m.content,
            toolCallId: m.toolCallId || '',
            toolName: m.toolName || '',
            isError: m.isError || false,
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString()
          };
          messageHistory.push(toolResultMsg);

          var toolResultText = '';
          if (typeof m.content === 'string') {
            toolResultText = m.content;
          } else if (Array.isArray(m.content)) {
            toolResultText = m.content.map(function(c) {
              if (typeof c === 'string') return c;
              if (c.text) return c.text;
              return JSON.stringify(c);
            }).join('\n');
          }
          if (pendingToolCalls.length > 0 && toolResultText) {
            pendingToolCalls[0].result = toolResultText;
            pendingToolCalls.shift();
          }
        } else if (m.role === 'user' && pendingToolCalls.length > 0) {
          var resultExtracted = extractToolData(m.content);
          for (var ri = 0; ri < resultExtracted.toolCalls.length && ri < pendingToolCalls.length; ri++) {
            pendingToolCalls[ri].result = resultExtracted.toolCalls[ri].result;
          }
          pendingToolCalls = [];
        } else if (m.role === 'tool' || m.role === 'tool_result') {
          var toolResult2 = '';
          if (typeof m.content === 'string') {
            toolResult2 = m.content;
          } else if (Array.isArray(m.content)) {
            toolResult2 = m.content.map(function(c) {
              if (typeof c === 'string') return c;
              if (c.text) return c.text;
              return JSON.stringify(c);
            }).join('\n');
          }
          if (pendingToolCalls.length > 0 && toolResult2) {
            pendingToolCalls[0].result = toolResult2;
            pendingToolCalls.shift();
          }
        }
      }
    }
    broadcastToChat({ type: 'done', data: event });
    broadcastToChat({ type: 'messages', messages: messageHistory });
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
    if (!authMiddleware(req, res)) return;

    if (method === 'POST' && pathname === '/api/auth/login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { password } = JSON.parse(body);
          if (password === ADMIN_PASSWORD) {
            const token = generateToken();
            sendJSON(res, 200, { token, expiresIn: TOKEN_EXPIRY });
          } else {
            sendJSON(res, 401, { error: 'Invalid password' });
          }
        } catch {
          sendJSON(res, 400, { error: 'Invalid request' });
        }
      });
      return;
    }

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

    // --- Workspace routes ---

    if (method === 'GET' && pathname === '/api/workspaces') {
      return await handleListWorkspaces(req, res);
    }

    if (method === 'POST' && pathname === '/api/workspaces') {
      return await handleCreateWorkspace(req, res);
    }

    const workspaceDeleteMatch = pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9_-]+)$/);
    if (workspaceDeleteMatch && method === 'DELETE') {
      return await handleDeleteWorkspace(req, res, workspaceDeleteMatch[1]);
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

    if (method === 'GET' && pathname === '/api/git-config') {
      return handleGetGitConfig(req, res);
    }

    if (method === 'POST' && pathname === '/api/git-config') {
      return handleSetGitConfig(req, res);
    }

    // --- Chat API routes ---
    if (method === 'POST' && pathname === '/api/chat/start') { startRpc(); sendJSON(res, 200, { status: 'starting' }); return; }
    if (method === 'POST' && pathname === '/api/chat/stop') { stopRpc(); sendJSON(res, 200, { status: 'stopped' }); return; }
    if (method === 'POST' && pathname === '/api/chat/prompt') {
      readBody(req).then(async body => {
        try {
          messageHistory.push({
            id: 'user-' + Date.now(),
            role: 'user',
            content: body.message || '',
            timestamp: new Date().toISOString()
          });
          const result = await sendRpcCommand({ type: 'prompt', message: body.message });
          sendJSON(res, 200, result || { success: true });
        } catch (e) { sendError(res, 500, e.message); }
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/chat/status') { sendJSON(res, 200, { running: !!rpcProcess, ready: rpcReady }); return; }
    if (method === 'GET' && pathname === '/api/chat/messages') { sendJSON(res, 200, { messages: messageHistory }); return; }
    if (method === 'GET' && pathname === '/api/chat/models') {
      if (!rpcReady || !rpcProcess) {
        sendJSON(res, 200, { models: [] });
        return;
      }
      sendRpcCommand({ type: 'get_available_models' }).then(function(result) {
        var models = [];
        if (result) {
          models = result.models || (result.data && result.data.models) || [];
        }
        sendJSON(res, 200, { models: models });
      }).catch(function(e) {
        sendJSON(res, 200, { models: [] });
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/chat/state') {
      if (!rpcReady || !rpcProcess) {
        sendJSON(res, 200, { running: false, ready: false });
        return;
      }
      sendRpcCommand({ type: 'get_state' }).then(function(result) {
        var state = (result && result.data) || result || {};
        sendJSON(res, 200, Object.assign({ running: true, ready: true }, state));
      }).catch(function(e) {
        sendJSON(res, 200, { running: true, ready: true, error: e.message });
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/chat/sandbox') {
      readBody(req).then(function(body) {
        try {
          var name = (body.name || '').trim();
          if (!name) { sendError(res, 400, 'name is required'); return; }
          var dir = '/root/data';
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dir + '/active-sandbox', name, 'utf-8');
          sendJSON(res, 200, { success: true, sandbox: name });
        } catch (e) { sendError(res, 500, e.message); }
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/chat/sandbox') {
      try {
        var activeName = '';
        var activePath = '/root/data/active-sandbox';
        if (fs.existsSync(activePath)) {
          activeName = fs.readFileSync(activePath, 'utf-8').trim();
        }
        sendJSON(res, 200, { sandbox: activeName });
      } catch (e) { sendJSON(res, 200, { sandbox: '' }); }
      return;
    }

    if (method === 'POST' && pathname === '/api/chat/set_model') {
      readBody(req).then(async function(body) {
        try {
          if (!rpcReady) { sendError(res, 400, 'RPC not ready'); return; }
          var result = await sendRpcCommand({ type: 'set_model', provider: body.provider, modelId: body.modelId });
          sendJSON(res, 200, { success: true, result: result });
        } catch (e) { sendError(res, 500, e.message); }
      });
      return;
    }

    // --- Static fallback ---
    return serveStatic(req, res);
  } catch (e) {
    sendError(res, 500, e.message || 'Internal server error');
  }
}

const server = http.createServer(handleRequest);
server.timeout = 300000;
server.keepAliveTimeout = 300000;

server.listen(PORT, () => {
  console.log(`Sandbox Box Web UI running on http://0.0.0.0:${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/chat') {
    const acceptKey = req.headers['sec-websocket-key'];
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
        const modelsRes = await sendRpcCommand({ type: 'get_available_models' });
        const modelList = modelsRes ? (modelsRes.models || (modelsRes.data && modelsRes.data.models) || []) : [];
        ws.send(JSON.stringify({ type: 'models', models: modelList }));
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
