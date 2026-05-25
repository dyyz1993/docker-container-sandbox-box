export type {
  ContainerConfig,
  ContainerStatus,
  ContainerState,
  ExecResult,
  ExecStreamCallbacks,
  ExecStreamOptions,
  FileInfo,
  GitCommit,
  GitStatus,
  ContainerStats,
  DriverType,
  SandboxBoxDriverConfig,
  CloudflareDriverConfig,
  DriverConfig,
} from './types';

export {
  UnsupportedOperationError,
  ContainerNotFoundError,
  ContainerStartError,
  ContainerNotRunningError,
  AuthenticationError,
  ApiRequestError,
} from './types';

export { Container } from './container';

export type { ContainerDriver } from './driver';

export { SandboxBoxDriver } from './drivers/sandbox-box';
export { CloudflareDriver } from './drivers/cloudflare';

import { Container } from './container';
import { SandboxBoxDriver } from './drivers/sandbox-box';
import { CloudflareDriver } from './drivers/cloudflare';
import type { ContainerDriver as IContainerDriver } from './driver';
import type { ContainerConfig, DriverConfig } from './types';

let _driver: IContainerDriver | null = null;

export function initDriver(config: DriverConfig): void {
  if (config.type === 'sandbox-box') {
    _driver = new SandboxBoxDriver({
      baseUrl: config.baseUrl,
      token: config.token,
      password: config.password,
    });
    return;
  }

  if (config.type === 'cloudflare') {
    _driver = new CloudflareDriver({ binding: config.binding });
    return;
  }

  throw new Error(`Unknown driver type: ${(config as { type: string }).type}`);
}

export function getDriver(): IContainerDriver {
  if (_driver) return _driver;

  const driverType = (typeof process !== 'undefined' && process.env?.CONTAINER_DRIVER) || 'sandbox-box';

  if (driverType === 'sandbox-box') {
    _driver = new SandboxBoxDriver({
      baseUrl:
        (typeof process !== 'undefined' && process.env?.SANDBOX_BOX_URL) ||
        'http://localhost:9091',
      password:
        (typeof process !== 'undefined' && process.env?.SANDBOX_BOX_PASSWORD) ||
        'sandbox2024',
    });
    return _driver;
  }

  throw new Error(
    'Cloudflare driver must be initialized explicitly with initDriver({ type: "cloudflare", binding })',
  );
}

export function resetDriver(): void {
  _driver = null;
}

export function getContainer(name: string, config?: ContainerConfig): Container {
  const driver = getDriver();
  return new Container(name, config ?? {}, driver);
}

export async function listContainers(): Promise<Container[]> {
  const driver = getDriver();
  const items = await driver.list();
  return items.map((item) => new Container(item.name, {}, driver));
}

export function switchPort(request: Request, port: number): Request {
  const url = new URL(request.url);
  const newUrl = new URL(url.pathname + url.search + url.hash, url.origin);
  const headers = new Headers(request.headers);
  headers.set('X-Container-Port', String(port));

  return new Request(newUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: request.redirect,
  });
}
