import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { ContainerDriver } from '../driver';
import type {
  ContainerConfig,
  ContainerState,
  ContainerStats,
  ExecResult,
  ExecStreamCallbacks,
  ExecStreamOptions,
  FileInfo,
  GitStatus,
} from '../types';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerStartError,
} from '../types';

interface DockerContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    Pid: number;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
  };
  NetworkSettings: {
    Networks: Record<
      string,
      {
        IPAddress: string;
        Gateway: string;
      }
    >;
  };
  Config: {
    Labels: Record<string, string>;
  };
  Mounts: Array<{
    Source: string;
    Destination: string;
    Type: string;
  }>;
}

interface DockerExecInspect {
  ID: string;
  Running: boolean;
  ExitCode: number;
  ProcessConfig: {
    entrypoint: string;
    arguments: string[];
  };
}

const LABEL_MANAGED = 'sandbox-box.managed';
const LABEL_NAME = 'sandbox-box.name';
const WORKSPACE_DIR = '/workspace';

export interface DockerDriverOptions {
  socketPath?: string;
  image?: string;
  defaultPort?: number;
}

export class DockerDriver implements ContainerDriver {
  readonly type = 'docker' as const;
  private readonly socketPath: string;
  private readonly image: string;
  private readonly defaultPort: number;

  constructor(opts: DockerDriverOptions = {}) {
    this.socketPath = opts.socketPath ?? '/var/run/docker.sock';
    this.image = opts.image ?? 'node:22-bookworm-slim';
    this.defaultPort = opts.defaultPort ?? 3000;
  }

  private async dockerRequest(
    path: string,
    options: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      hijack?: boolean;
    } = {},
  ): Promise<{ status: number; body: string; socket?: NodeJS.Socket }> {
    const { method = 'GET', body, headers = {}, hijack = false } = options;

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        const reqHeaders: Record<string, string> = {
          Host: 'localhost',
          ...headers,
        };

        if (hijack) {
          reqHeaders['Connection'] = 'Upgrade';
          reqHeaders['Upgrade'] = 'tcp';
        }

        let raw = `${method} ${path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) {
          raw += `${k}: ${v}\r\n`;
        }

        if (body) {
          const buf = Buffer.from(body);
          reqHeaders['Content-Type'] = reqHeaders['Content-Type'] ?? 'application/json';
          raw += `Content-Type: ${reqHeaders['Content-Type']}\r\nContent-Length: ${buf.length}\r\n\r\n`;
          socket.write(raw);
          socket.write(buf);
        } else {
          raw += '\r\n';
          socket.write(raw);
        }

        if (hijack) {
          resolve({ status: 101, body: '', socket });
          return;
        }

        let data = Buffer.alloc(0);
        let headersDone = false;
        let statusCode = 0;
        let contentLength = -1;
        let isChunked = false;
        let bodyStart = 0;

        socket.on('data', (chunk: Buffer) => {
          data = Buffer.concat([data, chunk]);

          if (!headersDone) {
            const headerEnd = data.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            headersDone = true;
            bodyStart = headerEnd + 4;

            const headerStr = data.slice(0, headerEnd).toString();
            const statusMatch = headerStr.match(/^HTTP\/\d\.\d\s+(\d+)/);
            if (statusMatch) statusCode = parseInt(statusMatch[1], 10);

            const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (clMatch) contentLength = parseInt(clMatch[1], 10);

            if (headerStr.match(/Transfer-Encoding:\s*chunked/i)) {
              isChunked = true;
            }
          }

          if (isChunked) {
            const term = data.indexOf(Buffer.from('0\r\n\r\n'));
            if (term !== -1) {
              const bodyData = data.slice(bodyStart, term);
              const decoded = this.decodeChunked(bodyData.toString());
              socket.destroy();
              resolve({ status: statusCode, body: decoded });
            }
          } else if (contentLength >= 0) {
            const received = data.length - bodyStart;
            if (received >= contentLength) {
              const bodyData = data.slice(bodyStart, bodyStart + contentLength);
              socket.destroy();
              resolve({ status: statusCode, body: bodyData.toString() });
            }
          }
        });

        socket.on('error', reject);
        socket.on('close', () => {
          if (!headersDone) {
            reject(new Error('Socket closed before response headers'));
          }
        });
      });

      socket.on('error', reject);
    });
  }

  private decodeChunked(raw: string): string {
    const parts: string[] = [];
    let offset = 0;
    while (offset < raw.length) {
      const lineEnd = raw.indexOf('\r\n', offset);
      if (lineEnd === -1) break;
      const size = parseInt(raw.slice(offset, lineEnd), 16);
      if (size === 0) break;
      offset = lineEnd + 2;
      parts.push(raw.slice(offset, offset + size));
      offset += size + 2;
    }
    return parts.join('');
  }

  private findContainerByName(name: string): Promise<DockerContainerInspect | null> {
    return this.listAllContainers().then((containers) => {
      const match = containers.find(
        (c) => c.Config?.Labels?.[LABEL_NAME] === name || c.Name === `/${name}`,
      );
      return match ?? null;
    });
  }

  private async listAllContainers(): Promise<DockerContainerInspect[]> {
    try {
      const { body, status } = await this.dockerRequest(
        `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }))}`,
      );
      if (status >= 400) return [];

      const list = JSON.parse(body) as Array<{ Id: string; Names: string[]; Labels: Record<string, string> }>;
      const results: DockerContainerInspect[] = [];

      for (const c of list) {
        try {
          const { body: inspectBody, status: inspectStatus } = await this.dockerRequest(
            `/containers/${c.Id}/json`,
          );
          if (inspectStatus < 400) {
            results.push(JSON.parse(inspectBody));
          }
        } catch {
          // skip containers we can't inspect
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private containerName(name: string): string {
    return name;
  }

  async create(name: string, config?: ContainerConfig): Promise<void> {
    const existing = await this.findContainerByName(name);
    if (existing) return;

    const env: string[] = [];
    if (config?.envVars) {
      for (const [k, v] of Object.entries(config.envVars)) {
        env.push(`${k}=${v}`);
      }
    }

    const entrypoint = config?.entrypoint ?? ['sleep', 'infinity'];

    const exposedPorts: Record<string, {}> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const port = config?.defaultPort ?? this.defaultPort;
    if (port) {
      exposedPorts[`${port}/tcp`] = {};
    }

    const body = JSON.stringify({
      Image: this.image,
      name: this.containerName(name),
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_NAME]: name,
      },
      WorkingDir: WORKSPACE_DIR,
      Env: env,
      Entrypoint: entrypoint,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        AutoRemove: false,
      },
      Tty: true,
      OpenStdin: true,
    });

    const { status, body: respBody } = await this.dockerRequest('/containers/create', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });

    if (status >= 400) {
      throw new ContainerStartError(name, respBody);
    }

    if (config?.repoUrl) {
      await this.start(name);
      try {
        const branch = config.branch ? ` -b ${config.branch}` : '';
        await this.exec(name, `mkdir -p ${WORKSPACE_DIR} && cd ${WORKSPACE_DIR} && git clone${branch} ${config.repoUrl} . || true`);
      } catch {
        // best-effort clone
      }
      await this.stop(name);
    }
  }

  async start(name: string, config?: ContainerConfig): Promise<void> {
    let container = await this.findContainerByName(name);

    if (!container) {
      await this.create(name, config);
      container = await this.findContainerByName(name);
    }

    if (!container) {
      throw new ContainerStartError(name, 'Failed to create container');
    }

    if (container.State.Running) return;

    const { status, body } = await this.dockerRequest(
      `/containers/${container.Id}/start`,
      { method: 'POST' },
    );

    if (status >= 400 && status !== 304) {
      throw new ContainerStartError(name, body);
    }
  }

  async stop(name: string, signal?: string | number): Promise<void> {
    const container = await this.findContainerByName(name);
    if (!container || !container.State.Running) return;

    const sig = typeof signal === 'number' ? signal : (signal ?? 'SIGTERM');
    await this.dockerRequest(
      `/containers/${container.Id}/stop?signal=${encodeURIComponent(String(sig))}`,
      { method: 'POST' },
    );
  }

  async destroy(name: string): Promise<void> {
    const container = await this.findContainerByName(name);
    if (!container) return;

    if (container.State.Running) {
      await this.dockerRequest(`/containers/${container.Id}/stop?t=5`, {
        method: 'POST',
      });
    }

    await this.dockerRequest(`/containers/${container.Id}?v=true&force=true`, {
      method: 'DELETE',
    });
  }

  async getState(name: string): Promise<ContainerState> {
    const container = await this.findContainerByName(name);

    if (!container) {
      return { status: 'stopped', lastChange: new Date() };
    }

    const statusMap: Record<string, ContainerState['status']> = {
      running: 'running',
      created: 'stopped',
      exited: 'stopped_with_code',
      dead: 'error',
      paused: 'stopped',
      restarting: 'creating',
      removing: 'stopping',
    };

    const ip = this.getContainerIP(container);
    const port = this.defaultPort;

    return {
      status: statusMap[container.State.Status] ?? 'stopped',
      lastChange: new Date(
        container.State.StartedAt ?? container.State.FinishedAt ?? new Date(),
      ),
      exitCode: container.State.ExitCode,
      pid: container.State.Pid > 0 ? container.State.Pid : undefined,
      ip: ip || undefined,
      port,
      domain: name,
    };
  }

  private getContainerIP(container: DockerContainerInspect): string {
    const networks = container.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      if (net.IPAddress) return net.IPAddress;
    }
    return '';
  }

  async fetch(name: string, request: Request, port?: number): Promise<Response> {
    const state = await this.getState(name);
    if (state.status !== 'running' && state.status !== 'healthy') {
      throw new ContainerNotRunningError(name);
    }

    const targetPort = port ?? this.defaultPort;
    const target = state.ip ?? name;
    const url = new URL(request.url);
    const targetUrl = `http://${target}:${targetPort}${url.pathname}${url.search}`;

    return fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
  }

  async exec(name: string, command: string): Promise<ExecResult> {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);
    if (!container.State.Running) throw new ContainerNotRunningError(name);

    const { body: createBody, status: createStatus } = await this.dockerRequest(
      `/containers/${container.Id}/exec`,
      {
        method: 'POST',
        body: JSON.stringify({
          AttachStdout: true,
          AttachStderr: true,
          Cmd: ['bash', '-c', command],
        }),
      },
    );

    if (createStatus >= 400) {
      return { stdout: '', stderr: createBody, exitCode: 1 };
    }

    const execId = (JSON.parse(createBody) as { Id: string }).Id;

    const { body: startBody, status: startStatus } = await this.dockerRequest(
      `/exec/${execId}/start`,
      {
        method: 'POST',
        body: JSON.stringify({ Detach: false, Tty: false }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    let stdout = '';
    let stderr = '';
    if (startStatus < 400 && startBody) {
      const parsed = this.parseDockerStream(startBody);
      stdout = parsed.stdout;
      stderr = parsed.stderr;
    }

    const { body: inspectBody } = await this.dockerRequest(`/exec/${execId}/json`);
    const execInspect = JSON.parse(inspectBody) as DockerExecInspect;

    return {
      stdout,
      stderr,
      exitCode: execInspect.ExitCode ?? 1,
    };
  }

  private parseDockerStream(raw: string): { stdout: string; stderr: string } {
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];

    let offset = 0;
    const buf = Buffer.from(raw, 'binary');

    while (offset + 8 <= buf.length) {
      const streamType = buf[offset];
      offset += 4;
      const length = buf.readUInt32BE(offset);
      offset += 4;

      if (offset + length > buf.length) break;

      const data = buf.slice(offset, offset + length).toString('utf-8');
      offset += length;

      if (streamType === 1) {
        stdoutParts.push(data);
      } else if (streamType === 2) {
        stderrParts.push(data);
      }
    }

    return {
      stdout: stdoutParts.join(''),
      stderr: stderrParts.join(''),
    };
  }

  async execStream(
    name: string,
    command: string,
    callbacks: ExecStreamCallbacks,
    options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }> {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);
    if (!container.State.Running) throw new ContainerNotRunningError(name);

    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['exec', name, 'bash', '-c', command], {
        timeout: options?.timeout,
        cwd: options?.cwd,
      });

      proc.stdout.on('data', (data: Buffer) => callbacks.onStdout(data.toString()));
      proc.stderr.on('data', (data: Buffer) => callbacks.onStderr?.(data.toString()));

      if (options?.signal) {
        const onAbort = () => proc.kill('SIGTERM');
        options.signal.addEventListener('abort', onAbort, { once: true });
        proc.on('close', () => options.signal!.removeEventListener('abort', onAbort));
      }

      proc.on('close', (code) => resolve({ exitCode: code ?? 0 }));
      proc.on('error', (err) => reject(err));
    });
  }

  async readFile(name: string, path: string): Promise<string> {
    const { stdout } = await this.exec(name, `cat ${path}`);
    return stdout;
  }

  async writeFile(name: string, path: string, content: string): Promise<void> {
    const escaped = content.replace(/'/g, "'\\''");
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) {
      await this.exec(name, `mkdir -p ${dir}`);
    }
    await this.exec(name, `printf '%s' '${escaped}' > ${path}`);
  }

  async listFiles(name: string, path: string): Promise<FileInfo[]> {
    const { stdout, exitCode } = await this.exec(
      name,
      `ls -1 --time-style=full-iso ${path} 2>/dev/null | tail -n +1`,
    );

    if (exitCode !== 0) return [];

    const { stdout: statOutput } = await this.exec(
      name,
      `stat -c '%F\t%s\t%Y' ${path}/* 2>/dev/null || true`,
    );

    const fileMap = new Map<string, { type: string; size: number; modified: number }>();
    for (const line of statOutput.split('\n')) {
      if (!line.trim()) continue;
      const [fullPath, type, size, mtime] = line.split('\t');
      const fileName = fullPath.split('/').pop() ?? '';
      fileMap.set(fileName, {
        type,
        size: parseInt(size, 10) || 0,
        modified: parseInt(mtime, 10) * 1000 || Date.now(),
      });
    }

    return stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const fileName = line.trim();
        const info = fileMap.get(fileName) ?? {
          type: 'regular file',
          size: 0,
          modified: Date.now(),
        };
        const type = info.type.includes('directory')
          ? 'directory'
          : info.type.includes('link')
            ? 'symlink'
            : 'file';

        return {
          name: fileName,
          path: `${path}/${fileName}`.replace(/\/+/g, '/'),
          type: type as FileInfo['type'],
          size: info.size,
          modified: new Date(info.modified).toISOString(),
        };
      });
  }

  async gitStatus(name: string): Promise<GitStatus> {
    const { stdout } = await this.exec(
      name,
      `cd ${WORKSPACE_DIR} 2>/dev/null && git status --porcelain=v2 --branch 2>/dev/null || echo "NOT_A_REPO"`,
    );

    if (stdout.includes('NOT_A_REPO')) {
      return {
        branch: '',
        modified: [],
        staged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
        recentCommits: [],
      };
    }

    const branch = this.extractBranch(stdout);
    const modified: string[] = [];
    const staged: string[] = [];
    const untracked: string[] = [];
    let ahead = 0;
    let behind = 0;

    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.ab')) {
        const parts = line.split(' ');
        for (const p of parts) {
          if (p.startsWith('+')) ahead = parseInt(p.slice(1), 10);
          if (p.startsWith('-')) behind = Math.abs(parseInt(p.slice(1), 10));
        }
      } else if (line.startsWith('1 M') || line.startsWith('1 .M')) {
        modified.push(line.split(/\s+/).slice(-1)[0]);
      } else if (line.startsWith('1 M.') || line.startsWith('1 A.') || line.startsWith('1 C.')) {
        staged.push(line.split(/\s+/).slice(-1)[0]);
      } else if (line.startsWith('? ')) {
        untracked.push(line.slice(2).trim());
      }
    }

    const { stdout: logOutput } = await this.exec(
      name,
      `cd ${WORKSPACE_DIR} && git log --oneline -5 --format='%h|%s|%an|%ci' 2>/dev/null || true`,
    );

    const recentCommits = logOutput
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [hash, message, author, date] = line.split('|');
        return { hash, message, author, date };
      });

    return { branch, modified, staged, untracked, ahead, behind, recentCommits };
  }

  private extractBranch(porcelainOutput: string): string {
    for (const line of porcelainOutput.split('\n')) {
      if (line.startsWith('# branch.head')) {
        return line.split(' ').slice(-1)[0] || 'HEAD';
      }
    }
    return 'HEAD';
  }

  async gitPush(name: string, message: string): Promise<void> {
    const escapedMsg = message.replace(/"/g, '\\"');
    await this.exec(
      name,
      `cd ${WORKSPACE_DIR} && git add -A && git commit -m "${escapedMsg}" && git push`,
    );
  }

  async getStats(name: string): Promise<ContainerStats> {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);

    const { body } = await this.dockerRequest(
      `/containers/${container.Id}/stats?stream=false`,
    );

    const stats = JSON.parse(body) as {
      cpu_stats: {
        cpu_usage: { total_usage: number };
        system_cpu_usage: number;
        online_cpus: number;
      };
      precpu_stats: {
        cpu_usage: { total_usage: number };
        system_cpu_usage: number;
      };
      memory_stats: {
        usage: number;
        limit: number;
      };
      num_procs: number;
    };

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent =
      sysDelta > 0
        ? (cpuDelta / sysDelta) * stats.cpu_stats.online_cpus * 100
        : 0;

    return {
      cpu: Math.round(cpuPercent * 100) / 100,
      memory: stats.memory_stats.usage,
      memoryLimit: stats.memory_stats.limit,
      processes: stats.num_procs ?? 0,
      disk: 0,
    };
  }

  async list(): Promise<Array<{ name: string; state: ContainerState }>> {
    const containers = await this.listAllContainers();
    return containers.map((c) => {
      const name = c.Config?.Labels?.[LABEL_NAME] ?? c.Name.replace(/^\//, '');
      return {
        name,
        state: {
          status: c.State.Running ? 'running' : 'stopped',
          lastChange: new Date(
            c.State.StartedAt ?? c.State.FinishedAt ?? new Date(),
          ),
          pid: c.State.Pid > 0 ? c.State.Pid : undefined,
          ip: this.getContainerIP(c) || undefined,
          port: this.defaultPort,
        },
      };
    });
  }
}
