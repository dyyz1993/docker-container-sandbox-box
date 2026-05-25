import { spawn } from 'node:child_process';
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
  ApiRequestError,
  AuthenticationError,
  ContainerNotFoundError,
} from '../types';

interface SandboxListResponse {
  name: string;
  status: string;
  updatedAt?: string;
  createdAt: string;
  pid?: number;
  ip?: string;
  domain?: string;
  port?: number;
}

interface ExecResponse {
  stdout?: string;
  output?: string;
  stderr?: string;
  exitCode?: number;
}

interface SandboxListAPIResponse {
  sandboxes: SandboxListResponse[];
  activeSandbox?: string;
}

interface FileEntry {
  name: string;
  type?: string;
  size?: number;
  mtime?: string;
}

function mapStatus(raw: string): ContainerState['status'] {
  switch (raw) {
    case 'running':
      return 'running';
    case 'creating':
      return 'creating';
    case 'stopping':
      return 'stopping';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

export class SandboxBoxDriver implements ContainerDriver {
  readonly type = 'sandbox-box' as const;
  private readonly baseUrl: string;
  private readonly password: string;
  private token: string;

  constructor(config: { baseUrl: string; token?: string; password?: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.password = config.password ?? '';
    this.token = config.token ?? '';
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;

    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
    });

    if (!res.ok) {
      throw new AuthenticationError(`Login returned ${res.status}`);
    }

    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new AuthenticationError('No token in login response');
    }

    this.token = data.token;
    return this.token;
  }

  private async rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.ensureToken();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const res = await this.rawRequest(path, options);

    if (res.status === 401) {
      this.token = '';
      const retry = await this.rawRequest(path, options);
      if (!retry.ok) {
        throw new ApiRequestError(path, retry.status, await retry.text());
      }
      return retry;
    }

    if (!res.ok) {
      throw new ApiRequestError(path, res.status, await res.text());
    }

    return res;
  }

  // --- Lifecycle ---

  async create(name: string, config?: ContainerConfig): Promise<void> {
    if (config?.repoUrl) {
      await this.request('/api/sandboxes/clone', {
        method: 'POST',
        body: JSON.stringify({
          name,
          repoUrl: config.repoUrl,
          branch: config.branch,
        }),
      });
    } else {
      await this.request('/api/sandboxes', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    }
  }

  async start(name: string, config?: ContainerConfig): Promise<void> {
    const state = await this.getState(name);

    if (state.status === 'running' || state.status === 'healthy') {
      return;
    }

    await this.create(name, config);
  }

  async stop(name: string, _signal?: string | number): Promise<void> {
    try {
      await this.request(`/api/sandboxes/${encodeURIComponent(name)}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command: 'echo stopping' }),
      });
    } catch {
      // best-effort
    }
  }

  async destroy(name: string): Promise<void> {
    const res = await this.rawRequest(
      `/api/sandboxes/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw new ApiRequestError(`/api/sandboxes/${name}`, res.status, await res.text());
    }
  }

  async getState(name: string): Promise<ContainerState> {
    const res = await this.request('/api/sandboxes');
    const data = (await res.json()) as SandboxListAPIResponse;
    const sb = data.sandboxes.find((s) => s.name === name);

    if (!sb) {
      return {
        status: 'stopped',
        lastChange: new Date(),
      };
    }

    return {
      status: mapStatus(sb.status),
      lastChange: new Date(sb.updatedAt ?? sb.createdAt),
      pid: sb.pid,
      ip: sb.ip,
      domain: sb.domain,
      port: sb.port,
    };
  }

  // --- Networking ---

  async fetch(name: string, request: Request, port?: number): Promise<Response> {
    const state = await this.getState(name);

    if (state.status !== 'running' && state.status !== 'healthy') {
      throw new ContainerNotFoundError(name);
    }

    const targetPort = port ?? 3100;
    const url = new URL(request.url);
    const targetUrl = `http://${state.ip}:${targetPort}${url.pathname}${url.search}`;

    return fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
  }

  // --- Exec ---

  async exec(name: string, command: string): Promise<ExecResult> {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/exec`,
      {
        method: 'POST',
        body: JSON.stringify({ command }),
      },
    );

    const data = (await res.json()) as ExecResponse;
    return {
      stdout: data.stdout ?? data.output ?? '',
      stderr: data.stderr ?? '',
      exitCode: data.exitCode ?? 0,
    };
  }

  async execStream(
    name: string,
    command: string,
    callbacks: ExecStreamCallbacks,
    options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const escaped = command.replace(/'/g, "'\\''");
      const proc = spawn('bash', ['-c', `sandbox ${name} '${escaped}'`], {
        timeout: options?.timeout,
        env: { ...process.env, HOME: '/root' },
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

  // --- Files ---

  async readFile(name: string, path: string): Promise<string> {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files/read?path=${encodeURIComponent(path)}`,
    );
    return await res.text();
  }

  async writeFile(name: string, path: string, content: string): Promise<void> {
    await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files/write`,
      {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
      },
    );
  }

  async listFiles(name: string, path: string): Promise<FileInfo[]> {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`,
    );
    const data = (await res.json()) as FileEntry[];

    return data.map((f) => ({
      name: f.name,
      path: `${path}/${f.name}`,
      type: (f.type ?? 'file') as FileInfo['type'],
      size: f.size ?? 0,
      modified: f.mtime ?? '',
    }));
  }

  // --- Git ---

  async gitStatus(name: string): Promise<GitStatus> {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/git/status`,
    );
    return (await res.json()) as GitStatus;
  }

  async gitPush(name: string, message: string): Promise<void> {
    await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/git/push`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
    );
  }

  // --- Stats ---

  async getStats(name: string): Promise<ContainerStats> {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/stats`,
    );
    return (await res.json()) as ContainerStats;
  }

  // --- List ---

  async list(): Promise<Array<{ name: string; state: ContainerState }>> {
    const res = await this.request('/api/sandboxes');
    const data = (await res.json()) as SandboxListAPIResponse;

    return data.sandboxes.map((sb) => ({
      name: sb.name,
      state: {
        status: mapStatus(sb.status),
        lastChange: new Date(sb.updatedAt ?? sb.createdAt),
        pid: sb.pid,
        ip: sb.ip,
        domain: sb.domain,
        port: sb.port,
      },
    }));
  }
}
