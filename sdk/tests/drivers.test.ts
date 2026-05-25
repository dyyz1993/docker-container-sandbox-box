import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

async function getSandboxBoxDriver() {
  const { SandboxBoxDriver } = await import('../src/drivers/sandbox-box');
  return new SandboxBoxDriver({
    baseUrl: 'http://test-server:9091',
    password: 'test-password',
  });
}

async function getDockerDriver() {
  const { DockerDriver } = await import('../src/drivers/docker');
  return new DockerDriver({
    socketPath: '/tmp/nonexistent.sock',
    image: 'node:22-alpine',
    defaultPort: 3000,
  });
}

async function getCloudflareDriver() {
  const { CloudflareDriver } = await import('../src/drivers/cloudflare');
  return new CloudflareDriver({ binding: {} });
}

describe('SandboxBoxDriver', () => {
  let driver: Awaited<ReturnType<typeof getSandboxBoxDriver>>;

  beforeEach(async () => {
    mockFetch.mockReset();
    driver = await getSandboxBoxDriver();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('should have type sandbox-box', () => {
    expect(driver.type).toBe('sandbox-box');
  });

  it('should login on first request and cache token', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'test-token-123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sandboxes: [] }), { status: 200 }),
      );

    await driver.list();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const loginCall = mockFetch.mock.calls[0];
    expect(loginCall[0]).toBe('http://test-server:9091/api/auth/login');
    expect(JSON.parse(loginCall[1].body)).toEqual({ password: 'test-password' });

    const listCall = mockFetch.mock.calls[1];
    expect(listCall[1].headers.get('Authorization')).toBe('Bearer test-token-123');
  });

  it('should retry on 401 (re-login)', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'first-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'second-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sandboxes: [{ name: 'sb1', status: 'running' }] }), { status: 200 }),
      );

    const result = await driver.list();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('sb1');
  });
});

describe('DockerDriver (unit)', () => {
  let driver: Awaited<ReturnType<typeof getDockerDriver>>;

  beforeEach(async () => {
    driver = await getDockerDriver();
  });

  it('should have type docker', () => {
    expect(driver.type).toBe('docker');
  });

  it('should return stopped for non-existent container', async () => {
    const state = await driver.getState('nonexistent-' + Date.now());
    expect(state.status).toBe('stopped');
  });

  it('should throw ContainerNotFoundError for stats on non-existent', async () => {
    const { ContainerNotFoundError } = await import('../src/types');
    await expect(
      driver.getStats('nonexistent-' + Date.now()),
    ).rejects.toThrow(ContainerNotFoundError);
  });

  it('should throw ContainerNotFoundError for exec on non-existent', async () => {
    const { ContainerNotFoundError } = await import('../src/types');
    await expect(
      driver.exec('nonexistent-' + Date.now(), 'echo hi'),
    ).rejects.toThrow(ContainerNotFoundError);
  });

  it('should handle destroy of non-existent container gracefully', async () => {
    await expect(
      driver.destroy('nonexistent-' + Date.now()),
    ).resolves.not.toThrow();
  });
});

describe('CloudflareDriver', () => {
  let driver: Awaited<ReturnType<typeof getCloudflareDriver>>;

  beforeEach(async () => {
    driver = await getCloudflareDriver();
  });

  it('should have type cloudflare', () => {
    expect(driver.type).toBe('cloudflare');
  });

  it('should throw UnsupportedOperationError for create', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.create('test')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for exec', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.exec('test', 'echo hi')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for readFile', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.readFile('test', '/path')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for writeFile', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.writeFile('test', '/path', 'content')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for listFiles', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.listFiles('test', '/path')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for gitStatus', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.gitStatus('test')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for gitPush', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.gitPush('test', 'msg')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for getStats', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.getStats('test')).rejects.toThrow(UnsupportedOperationError);
  });

  it('should throw UnsupportedOperationError for list', async () => {
    const { UnsupportedOperationError } = await import('../src/types');
    await expect(driver.list()).rejects.toThrow(UnsupportedOperationError);
  });

  it('should start via binding', async () => {
    const startFn = vi.fn().mockResolvedValue(undefined);
    const { CloudflareDriver } = await import('../src/drivers/cloudflare');
    const cfDriver = new CloudflareDriver({
      binding: { start: startFn },
    });
    await cfDriver.start('test-ctr');
    expect(startFn).toHaveBeenCalledWith('test-ctr', undefined);
  });

  it('should getState via binding', async () => {
    const { CloudflareDriver } = await import('../src/drivers/cloudflare');
    const getStateFn = vi.fn().mockResolvedValue({ status: 'running', lastChange: new Date() });
    const cfDriver = new CloudflareDriver({
      binding: { getState: getStateFn },
    });
    const state = await cfDriver.getState('test-ctr');
    expect(state.status).toBe('running');
  });
});

describe('Public API', () => {
  it('should export all types and classes', async () => {
    const sdk = await import('../src/index');
    expect(sdk.initDriver).toBeInstanceOf(Function);
    expect(sdk.getDriver).toBeInstanceOf(Function);
    expect(sdk.resetDriver).toBeInstanceOf(Function);
    expect(sdk.getContainer).toBeInstanceOf(Function);
    expect(sdk.listContainers).toBeInstanceOf(Function);
    expect(sdk.switchPort).toBeInstanceOf(Function);
    expect(sdk.Container).toBeInstanceOf(Function);
    expect(sdk.SandboxBoxDriver).toBeInstanceOf(Function);
    expect(sdk.CloudflareDriver).toBeInstanceOf(Function);
    expect(sdk.DockerDriver).toBeInstanceOf(Function);
    expect(sdk.ContainerNotFoundError).toBeInstanceOf(Function);
    expect(sdk.ContainerStartError).toBeInstanceOf(Function);
    expect(sdk.ContainerNotRunningError).toBeInstanceOf(Function);
    expect(sdk.AuthenticationError).toBeInstanceOf(Function);
    expect(sdk.ApiRequestError).toBeInstanceOf(Function);
    expect(sdk.UnsupportedOperationError).toBeInstanceOf(Function);
  });

  it('should init docker driver', async () => {
    const sdk = await import('../src/index');
    sdk.resetDriver();
    sdk.initDriver({ type: 'docker', socketPath: '/tmp/docker.sock' });
    const driver = sdk.getDriver();
    expect(driver.type).toBe('docker');
    sdk.resetDriver();
  });

  it('should init sandbox-box driver', async () => {
    const sdk = await import('../src/index');
    sdk.resetDriver();
    sdk.initDriver({ type: 'sandbox-box', baseUrl: 'http://localhost:9091' });
    const driver = sdk.getDriver();
    expect(driver.type).toBe('sandbox-box');
    sdk.resetDriver();
  });

  it('should init cloudflare driver', async () => {
    const sdk = await import('../src/index');
    sdk.resetDriver();
    sdk.initDriver({ type: 'cloudflare', binding: {} });
    const driver = sdk.getDriver();
    expect(driver.type).toBe('cloudflare');
    sdk.resetDriver();
  });

  it('should throw on unknown driver type', async () => {
    const sdk = await import('../src/index');
    sdk.resetDriver();
    expect(() =>
      sdk.initDriver({ type: 'unknown' } as any),
    ).toThrow('Unknown driver type');
    sdk.resetDriver();
  });

  it('switchPort should modify request', async () => {
    const sdk = await import('../src/index');
    const req = new Request('http://localhost/test?q=1', { headers: { 'X-Custom': 'val' } });
    const switched = sdk.switchPort(req, 8080);
    expect(switched.headers.get('X-Container-Port')).toBe('8080');
    expect(new URL(switched.url).pathname).toBe('/test');
  });
});
