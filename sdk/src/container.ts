import type { ContainerDriver } from './driver';
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

const DEFAULT_WAIT_ATTEMPTS = 60;
const WAIT_INTERVAL_MS = 1000;

export class Container {
  readonly name: string;
  readonly config: ContainerConfig;
  private readonly driver: ContainerDriver;

  constructor(name: string, config: ContainerConfig, driver: ContainerDriver) {
    this.name = name;
    this.config = config;
    this.driver = driver;
  }

  async start(options?: ContainerConfig): Promise<void> {
    const merged = { ...this.config, ...options };
    await this.driver.start(this.name, merged);
  }

  async startAndWaitForPorts(options?: ContainerConfig): Promise<void> {
    await this.start(options);
    const ports = this.config.requiredPorts;
    if (!ports || ports.length === 0) {
      for (let i = 0; i < DEFAULT_WAIT_ATTEMPTS; i++) {
        const state = await this.driver.getState(this.name);
        if (state.status === 'running' || state.status === 'healthy') return;
        await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
      }
      throw new Error(`Container "${this.name}" failed to start within ${DEFAULT_WAIT_ATTEMPTS}s`);
    }
    for (const port of ports) {
      for (let i = 0; i < DEFAULT_WAIT_ATTEMPTS; i++) {
        try {
          const probe = new Request(`http://localhost:${port}/`);
          const resp = await this.driver.fetch(this.name, probe, port);
          if (resp.ok || resp.status < 500) break;
        } catch {
          // port not ready yet
        }
        if (i === DEFAULT_WAIT_ATTEMPTS - 1) {
          throw new Error(`Container "${this.name}" port ${port} not ready within ${DEFAULT_WAIT_ATTEMPTS}s`);
        }
        await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
      }
    }
  }

  async stop(signal?: string | number): Promise<void> {
    await this.driver.stop(this.name, signal);
  }

  async destroy(): Promise<void> {
    await this.driver.destroy(this.name);
  }

  async fetch(request: Request): Promise<Response> {
    return this.driver.fetch(this.name, request, this.config.defaultPort);
  }

  async getState(): Promise<ContainerState> {
    return this.driver.getState(this.name);
  }

  async exec(command: string): Promise<ExecResult> {
    return this.driver.exec(this.name, command);
  }

  async execStream(
    command: string,
    callbacks: ExecStreamCallbacks,
    options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }> {
    return this.driver.execStream(this.name, command, callbacks, options);
  }

  async readFile(path: string): Promise<string> {
    return this.driver.readFile(this.name, path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.driver.writeFile(this.name, path, content);
  }

  async listFiles(path: string = '/'): Promise<FileInfo[]> {
    return this.driver.listFiles(this.name, path);
  }

  async gitStatus(): Promise<GitStatus> {
    return this.driver.gitStatus(this.name);
  }

  async gitPush(message: string): Promise<void> {
    return this.driver.gitPush(this.name, message);
  }

  async getStats(): Promise<ContainerStats> {
    return this.driver.getStats(this.name);
  }
}
