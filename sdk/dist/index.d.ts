interface ContainerConfig {
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
type ContainerStatus = 'creating' | 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code' | 'error';
interface ContainerState {
    status: ContainerStatus;
    lastChange: Date;
    exitCode?: number;
    pid?: number;
    ip?: string;
    domain?: string;
    port?: number;
}
interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
interface ExecStreamCallbacks {
    onStdout: (data: string) => void;
    onStderr?: (data: string) => void;
}
interface ExecStreamOptions {
    timeout?: number;
    signal?: AbortSignal;
    cwd?: string;
}
interface FileInfo {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    modified: string;
}
interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
}
interface GitStatus {
    branch: string;
    modified: string[];
    staged: string[];
    untracked: string[];
    ahead: number;
    behind: number;
    recentCommits: GitCommit[];
}
interface ContainerStats {
    cpu: number;
    memory: number;
    memoryLimit: number;
    processes: number;
    disk: number;
}
type DriverType = 'sandbox-box' | 'cloudflare' | 'docker';
interface SandboxBoxDriverConfig {
    type: 'sandbox-box';
    baseUrl: string;
    token?: string;
    password?: string;
}
interface CloudflareDriverConfig {
    type: 'cloudflare';
    binding: unknown;
}
interface DockerDriverConfig {
    type: 'docker';
    socketPath?: string;
    image?: string;
    defaultPort?: number;
}
type DriverConfig = SandboxBoxDriverConfig | CloudflareDriverConfig | DockerDriverConfig;
declare class UnsupportedOperationError extends Error {
    readonly driver: string;
    readonly operation: string;
    constructor(operation: string, driver: string);
}
declare class ContainerNotFoundError extends Error {
    readonly containerName: string;
    constructor(name: string);
}
declare class ContainerStartError extends Error {
    readonly containerName: string;
    constructor(name: string, reason: string);
}
declare class ContainerNotRunningError extends Error {
    readonly containerName: string;
    constructor(name: string);
}
declare class AuthenticationError extends Error {
    constructor(reason: string);
}
declare class ApiRequestError extends Error {
    readonly statusCode: number;
    readonly endpoint: string;
    constructor(endpoint: string, statusCode: number, body: string);
}

interface ContainerDriver {
    readonly type: 'sandbox-box' | 'cloudflare' | 'docker';
    create(name: string, config?: ContainerConfig): Promise<void>;
    start(name: string, config?: ContainerConfig): Promise<void>;
    stop(name: string, signal?: string | number): Promise<void>;
    destroy(name: string): Promise<void>;
    getState(name: string): Promise<ContainerState>;
    fetch(name: string, request: Request, port?: number): Promise<Response>;
    exec(name: string, command: string): Promise<ExecResult>;
    execStream(name: string, command: string, callbacks: ExecStreamCallbacks, options?: ExecStreamOptions): Promise<{
        exitCode: number;
    }>;
    readFile(name: string, path: string): Promise<string>;
    writeFile(name: string, path: string, content: string): Promise<void>;
    listFiles(name: string, path: string): Promise<FileInfo[]>;
    gitStatus(name: string): Promise<GitStatus>;
    gitPush(name: string, message: string): Promise<void>;
    getStats(name: string): Promise<ContainerStats>;
    list(): Promise<Array<{
        name: string;
        state: ContainerState;
    }>>;
}

declare class Container {
    readonly name: string;
    readonly config: ContainerConfig;
    private readonly driver;
    constructor(name: string, config: ContainerConfig, driver: ContainerDriver);
    start(options?: ContainerConfig): Promise<void>;
    startAndWaitForPorts(options?: ContainerConfig): Promise<void>;
    stop(signal?: string | number): Promise<void>;
    destroy(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    getState(): Promise<ContainerState>;
    exec(command: string): Promise<ExecResult>;
    execStream(command: string, callbacks: ExecStreamCallbacks, options?: ExecStreamOptions): Promise<{
        exitCode: number;
    }>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    listFiles(path?: string): Promise<FileInfo[]>;
    gitStatus(): Promise<GitStatus>;
    gitPush(message: string): Promise<void>;
    getStats(): Promise<ContainerStats>;
}

declare class SandboxBoxDriver implements ContainerDriver {
    readonly type: "sandbox-box";
    private readonly baseUrl;
    private readonly password;
    private token;
    constructor(config: {
        baseUrl: string;
        token?: string;
        password?: string;
    });
    private ensureToken;
    private rawRequest;
    private request;
    create(name: string, config?: ContainerConfig): Promise<void>;
    start(name: string, config?: ContainerConfig): Promise<void>;
    stop(name: string, _signal?: string | number): Promise<void>;
    destroy(name: string): Promise<void>;
    getState(name: string): Promise<ContainerState>;
    fetch(name: string, request: Request, port?: number): Promise<Response>;
    exec(name: string, command: string): Promise<ExecResult>;
    execStream(name: string, command: string, callbacks: ExecStreamCallbacks, options?: ExecStreamOptions): Promise<{
        exitCode: number;
    }>;
    readFile(name: string, path: string): Promise<string>;
    writeFile(name: string, path: string, content: string): Promise<void>;
    listFiles(name: string, path: string): Promise<FileInfo[]>;
    gitStatus(name: string): Promise<GitStatus>;
    gitPush(name: string, message: string): Promise<void>;
    getStats(name: string): Promise<ContainerStats>;
    list(): Promise<Array<{
        name: string;
        state: ContainerState;
    }>>;
}

declare class CloudflareDriver implements ContainerDriver {
    readonly type: "cloudflare";
    private readonly binding;
    constructor(config: {
        binding: unknown;
    });
    create(_name: string, _config?: ContainerConfig): Promise<void>;
    start(name: string, config?: ContainerConfig): Promise<void>;
    stop(name: string, signal?: string | number): Promise<void>;
    destroy(name: string): Promise<void>;
    getState(name: string): Promise<ContainerState>;
    fetch(name: string, request: Request, port?: number): Promise<Response>;
    exec(_name: string, _command: string): Promise<ExecResult>;
    execStream(_name: string, _command: string, _callbacks: ExecStreamCallbacks, _options?: ExecStreamOptions): Promise<{
        exitCode: number;
    }>;
    readFile(_name: string, _path: string): Promise<string>;
    writeFile(_name: string, _path: string, _content: string): Promise<void>;
    listFiles(_name: string, _path: string): Promise<FileInfo[]>;
    gitStatus(_name: string): Promise<GitStatus>;
    gitPush(_name: string, _message: string): Promise<void>;
    getStats(_name: string): Promise<ContainerStats>;
    list(): Promise<Array<{
        name: string;
        state: ContainerState;
    }>>;
}

interface DockerDriverOptions {
    socketPath?: string;
    image?: string;
    defaultPort?: number;
}
declare class DockerDriver implements ContainerDriver {
    readonly type: "docker";
    private readonly socketPath;
    private readonly image;
    private readonly defaultPort;
    constructor(opts?: DockerDriverOptions);
    private dockerRequest;
    private decodeChunked;
    private findContainerByName;
    private listAllContainers;
    private containerName;
    create(name: string, config?: ContainerConfig): Promise<void>;
    start(name: string, config?: ContainerConfig): Promise<void>;
    stop(name: string, signal?: string | number): Promise<void>;
    destroy(name: string): Promise<void>;
    getState(name: string): Promise<ContainerState>;
    private getContainerIP;
    fetch(name: string, request: Request, port?: number): Promise<Response>;
    exec(name: string, command: string): Promise<ExecResult>;
    private parseDockerStream;
    execStream(name: string, command: string, callbacks: ExecStreamCallbacks, options?: ExecStreamOptions): Promise<{
        exitCode: number;
    }>;
    readFile(name: string, path: string): Promise<string>;
    writeFile(name: string, path: string, content: string): Promise<void>;
    listFiles(name: string, path: string): Promise<FileInfo[]>;
    gitStatus(name: string): Promise<GitStatus>;
    private extractBranch;
    gitPush(name: string, message: string): Promise<void>;
    getStats(name: string): Promise<ContainerStats>;
    list(): Promise<Array<{
        name: string;
        state: ContainerState;
    }>>;
}

declare function initDriver(config: DriverConfig): void;
declare function getDriver(): ContainerDriver;
declare function resetDriver(): void;
declare function getContainer(name: string, config?: ContainerConfig): Container;
declare function listContainers(): Promise<Container[]>;
declare function switchPort(request: Request, port: number): Request;

export { ApiRequestError, AuthenticationError, CloudflareDriver, type CloudflareDriverConfig, Container, type ContainerConfig, type ContainerDriver, ContainerNotFoundError, ContainerNotRunningError, ContainerStartError, type ContainerState, type ContainerStats, type ContainerStatus, DockerDriver, type DockerDriverConfig, type DriverConfig, type DriverType, type ExecResult, type ExecStreamCallbacks, type ExecStreamOptions, type FileInfo, type GitCommit, type GitStatus, SandboxBoxDriver, type SandboxBoxDriverConfig, UnsupportedOperationError, getContainer, getDriver, initDriver, listContainers, resetDriver, switchPort };
