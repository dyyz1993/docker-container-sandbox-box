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
import { UnsupportedOperationError } from '../types';

export class CloudflareDriver implements ContainerDriver {
  readonly type = 'cloudflare' as const;
  private readonly binding: unknown;

  constructor(config: { binding: unknown }) {
    this.binding = config.binding;
  }

  async create(_name: string, _config?: ContainerConfig): Promise<void> {
    throw new UnsupportedOperationError('create', 'cloudflare');
  }

  async start(name: string, config?: ContainerConfig): Promise<void> {
    const cf = this.binding as Record<string, (...args: unknown[]) => Promise<unknown>> | null;
    if (!cf || typeof cf.start !== 'function') {
      throw new UnsupportedOperationError('start', 'cloudflare');
    }
    await cf.start(name, config);
  }

  async stop(name: string, signal?: string | number): Promise<void> {
    const cf = this.binding as Record<string, (...args: unknown[]) => Promise<unknown>> | null;
    if (!cf || typeof cf.stop !== 'function') {
      throw new UnsupportedOperationError('stop', 'cloudflare');
    }
    await cf.stop(name, signal);
  }

  async destroy(name: string): Promise<void> {
    const cf = this.binding as Record<string, (...args: unknown[]) => Promise<unknown>> | null;
    if (!cf || typeof cf.destroy !== 'function') {
      throw new UnsupportedOperationError('destroy', 'cloudflare');
    }
    await cf.destroy(name);
  }

  async getState(name: string): Promise<ContainerState> {
    const cf = this.binding as Record<string, (...args: unknown[]) => Promise<ContainerState>> | null;
    if (!cf || typeof cf.getState !== 'function') {
      throw new UnsupportedOperationError('getState', 'cloudflare');
    }
    return cf.getState(name);
  }

  async fetch(name: string, request: Request, port?: number): Promise<Response> {
    const cf = this.binding as Record<string, (...args: unknown[]) => Promise<Response>> | null;
    if (!cf || typeof cf.fetch !== 'function') {
      throw new UnsupportedOperationError('fetch', 'cloudflare');
    }
    return cf.fetch(name, request, port);
  }

  async exec(_name: string, _command: string): Promise<ExecResult> {
    throw new UnsupportedOperationError('exec', 'cloudflare');
  }

  async execStream(
    _name: string,
    _command: string,
    _callbacks: ExecStreamCallbacks,
    _options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }> {
    throw new UnsupportedOperationError('execStream', 'cloudflare');
  }

  async readFile(_name: string, _path: string): Promise<string> {
    throw new UnsupportedOperationError('readFile', 'cloudflare');
  }

  async writeFile(_name: string, _path: string, _content: string): Promise<void> {
    throw new UnsupportedOperationError('writeFile', 'cloudflare');
  }

  async listFiles(_name: string, _path: string): Promise<FileInfo[]> {
    throw new UnsupportedOperationError('listFiles', 'cloudflare');
  }

  async gitStatus(_name: string): Promise<GitStatus> {
    throw new UnsupportedOperationError('gitStatus', 'cloudflare');
  }

  async gitPush(_name: string, _message: string): Promise<void> {
    throw new UnsupportedOperationError('gitPush', 'cloudflare');
  }

  async getStats(_name: string): Promise<ContainerStats> {
    throw new UnsupportedOperationError('getStats', 'cloudflare');
  }

  async list(): Promise<Array<{ name: string; state: ContainerState }>> {
    throw new UnsupportedOperationError('list', 'cloudflare');
  }
}
