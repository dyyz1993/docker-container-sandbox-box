export interface ContainerConfig {
  defaultPort?: number;
  requiredPorts?: number[];
  sleepAfter?: string | number;
  envVars?: Record<string, string>;
  entrypoint?: string[];
  enableInternet?: boolean;
  pingEndpoint?: string;
  repoUrl?: string;
  branch?: string;
  maxInstances?: number;
  instanceType?: string;
}

export type ContainerStatus =
  | 'creating'
  | 'running'
  | 'healthy'
  | 'stopping'
  | 'stopped'
  | 'stopped_with_code'
  | 'error';

export interface ContainerState {
  status: ContainerStatus;
  lastChange: Date;
  exitCode?: number;
  pid?: number;
  ip?: string;
  domain?: string;
  port?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecStreamCallbacks {
  onStdout: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ExecStreamOptions {
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitStatus {
  branch: string;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  recentCommits: GitCommit[];
}

export interface ContainerStats {
  cpu: number;
  memory: number;
  memoryLimit: number;
  processes: number;
  disk: number;
}

export type DriverType = 'sandbox-box' | 'cloudflare';

export interface SandboxBoxDriverConfig {
  type: 'sandbox-box';
  baseUrl: string;
  token?: string;
  password?: string;
}

export interface CloudflareDriverConfig {
  type: 'cloudflare';
  binding: unknown;
}

export type DriverConfig = SandboxBoxDriverConfig | CloudflareDriverConfig;

export class UnsupportedOperationError extends Error {
  readonly driver: string;
  readonly operation: string;

  constructor(operation: string, driver: string) {
    super(`Operation "${operation}" is not supported by "${driver}" driver`);
    this.name = 'UnsupportedOperationError';
    this.operation = operation;
    this.driver = driver;
  }
}

export class ContainerNotFoundError extends Error {
  readonly containerName: string;

  constructor(name: string) {
    super(`Container "${name}" not found`);
    this.name = 'ContainerNotFoundError';
    this.containerName = name;
  }
}

export class ContainerStartError extends Error {
  readonly containerName: string;

  constructor(name: string, reason: string) {
    super(`Failed to start container "${name}": ${reason}`);
    this.name = 'ContainerStartError';
    this.containerName = name;
  }
}

export class ContainerNotRunningError extends Error {
  readonly containerName: string;

  constructor(name: string) {
    super(`Container "${name}" is not running`);
    this.name = 'ContainerNotRunningError';
    this.containerName = name;
  }
}

export class AuthenticationError extends Error {
  constructor(reason: string) {
    super(`Authentication failed: ${reason}`);
    this.name = 'AuthenticationError';
  }
}

export class ApiRequestError extends Error {
  readonly statusCode: number;
  readonly endpoint: string;

  constructor(endpoint: string, statusCode: number, body: string) {
    super(`API request to "${endpoint}" failed (${statusCode}): ${body}`);
    this.name = 'ApiRequestError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}
