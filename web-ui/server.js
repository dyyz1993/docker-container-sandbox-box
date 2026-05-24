const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const WEB_DIR = __dirname;
const SANDBOX_CMD = '/usr/local/bin/sandbox';
const WORKSPACE_ROOT = '/root/data/sandboxes';
const CGROUP_ROOT = '/sys/fs/cgroup';

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
    if (method === 'GET' && pathname === '/api/sandboxes') {
      return await handleListSandboxes(req, res);
    }

    if (method === 'POST' && pathname === '/api/sandboxes') {
      return await handleCreateSandbox(req, res);
    }

    const destroyMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)$/);
    if (destroyMatch) {
      const name = destroyMatch[1];
      if (method === 'DELETE') {
        return await handleDestroySandbox(req, res, name);
      }
    }

    const filesListMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)\/files$/);
    if (filesListMatch && method === 'GET') {
      const name = filesListMatch[1];
      const queryPath = url.searchParams.get('path') || '/';
      return await handleListFiles(req, res, name, queryPath);
    }

    const fileReadMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)\/files\/read$/);
    if (fileReadMatch && method === 'GET') {
      const name = fileReadMatch[1];
      const queryPath = url.searchParams.get('path') || '';
      return await handleReadFile(req, res, name, queryPath);
    }

    const fileWriteMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)\/files\/write$/);
    if (fileWriteMatch && method === 'PUT') {
      const name = fileWriteMatch[1];
      return await handleWriteFile(req, res, name);
    }

    if (method === 'GET' && pathname === '/api/domains') {
      return await handleListDomains(req, res);
    }

    if (method === 'GET' && pathname === '/api/stats') {
      return await handleSystemStats(req, res);
    }

    const sandboxStatsMatch = pathname.match(/^\/api\/sandboxes\/([a-zA-Z0-9_-]+)\/stats$/);
    if (sandboxStatsMatch && method === 'GET') {
      const name = sandboxStatsMatch[1];
      return await handleSandboxStats(req, res, name);
    }

    return serveStatic(req, res);
  } catch (e) {
    sendError(res, 500, e.message || 'Internal server error');
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Sandbox Box Web UI running on http://0.0.0.0:${PORT}`);
});
