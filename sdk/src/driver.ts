import type {
  ContainerConfig,
  ContainerState,
  ContainerStats,
  ExecResult,
  ExecStreamCallbacks,
  ExecStreamOptions,
  FileInfo,
  GitStatus,
} from './types';

export interface ContainerDriver {
  readonly type: 'sandbox-box' | 'cloudflare';

  create(name: string, config?: ContainerConfig): Promise<void>;
  start(name: string, config?: ContainerConfig): Promise<void>;
  stop(name: string, signal?: string | number): Promise<void>;
  destroy(name: string): Promise<void>;
  getState(name: string): Promise<ContainerState>;

  fetch(name: string, request: Request, port?: number): Promise<Response>;

  exec(name: string, command: string): Promise<ExecResult>;

  execStream(
    name: string,
    command: string,
    callbacks: ExecStreamCallbacks,
    options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }>;

  readFile(name: string, path: string): Promise<string>;
  writeFile(name: string, path: string, content: string): Promise<void>;
  listFiles(name: string, path: string): Promise<FileInfo[]>;

  gitStatus(name: string): Promise<GitStatus>;
  gitPush(name: string, message: string): Promise<void>;

  getStats(name: string): Promise<ContainerStats>;

  list(): Promise<Array<{ name: string; state: ContainerState }>>;
}
