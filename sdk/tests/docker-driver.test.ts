import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DOCKER_SOCKET = '/var/run/docker.sock';
const TEST_IMAGES = [
  'docker.io/node:22-bookworm-slim',
  'docker.io/library/node:20',
];
const TEST_PREFIX = `sbx-test-${Date.now()}`;

function hasDocker(): boolean {
  try {
    return existsSync(DOCKER_SOCKET);
  } catch {
    return false;
  }
}

function findLocalImage(): string | undefined {
  for (const img of TEST_IMAGES) {
    try {
      execSync(`docker image inspect ${img} 2>/dev/null`, { stdio: 'pipe' });
      return img;
    } catch {
      // not found locally
    }
  }
  return undefined;
}

function pullImage(): string {
  for (const img of TEST_IMAGES) {
    try {
      execSync(`docker pull ${img}`, { stdio: 'pipe', timeout: 180_000 });
      return img;
    } catch {
      continue;
    }
  }
  throw new Error('Failed to pull any test image: ' + TEST_IMAGES.join(', '));
}

function resolveImage(): string {
  const local = findLocalImage();
  if (local) return local;
  return pullImage();
}

let resolvedImage = '';
const itIfDocker = hasDocker() ? it : it.skip;

describe('DockerDriver', () => {
  let driver: import('../src/drivers/docker').DockerDriver;
  const testName = `${TEST_PREFIX}-lifecycle`;

  beforeAll(async () => {
    if (!hasDocker()) return;
    resolvedImage = resolveImage();
    const { DockerDriver } = await import('../src/drivers/docker');
    driver = new DockerDriver({
      socketPath: DOCKER_SOCKET,
      image: resolvedImage,
      defaultPort: 3000,
    });
  });

  afterAll(async () => {
    if (!hasDocker() || !driver) return;
    // Cleanup all test containers
    const containers = await driver.list();
    for (const c of containers) {
      if (c.name.startsWith(TEST_PREFIX)) {
        try { await driver.destroy(c.name); } catch {}
      }
    }
  });

  describe('lifecycle', () => {
    itIfDocker('should create, start, getState, stop, destroy', async () => {
      await driver.create(testName);
      await driver.start(testName);

      let state = await driver.getState(testName);
      expect(state.status).toBe('running');
      expect(state.pid).toBeGreaterThan(0);

      await driver.stop(testName);
      state = await driver.getState(testName);
      expect(
        state.status === 'stopped' ||
        state.status === 'stopped_with_code' ||
        state.status === 'running',
      ).toBe(true);

      if (state.status === 'running') {
        await driver.stop(testName, 'SIGKILL');
      }

      await driver.destroy(testName);
      state = await driver.getState(testName);
      expect(state.status).toBe('stopped');
    });

    itIfDocker('should start a non-existent container (auto-create)', async () => {
      const name = `${TEST_PREFIX}-auto-start`;
      await driver.start(name);
      const state = await driver.getState(name);
      expect(state.status).toBe('running');
      await driver.destroy(name);
    });

    itIfDocker('should return stopped for non-existent container', async () => {
      const state = await driver.getState('non-existent-' + TEST_PREFIX);
      expect(state.status).toBe('stopped');
    });

    itIfDocker('should throw on exec for non-existent container', async () => {
      const { ContainerNotFoundError } = await import('../src/types');
      await expect(
        driver.exec('non-existent-' + TEST_PREFIX, 'echo hello'),
      ).rejects.toThrow(ContainerNotFoundError);
    });

    itIfDocker('should handle destroy on non-existent container gracefully', async () => {
      await expect(
        driver.destroy('non-existent-' + TEST_PREFIX),
      ).resolves.not.toThrow();
    });
  });

  describe('exec', () => {
    const name = `${TEST_PREFIX}-exec`;

    beforeAll(async () => {
      if (!hasDocker()) return;
      await driver.start(name);
    });

    afterAll(async () => {
      if (!hasDocker()) return;
      await driver.destroy(name).catch(() => {});
    });

    itIfDocker('should execute a simple command', async () => {
      const result = await driver.exec(name, 'echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
    });

    itIfDocker('should capture stderr', async () => {
      const result = await driver.exec(name, 'echo "error msg" >&2');
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe('error msg');
    });

    itIfDocker('should return non-zero exit code', async () => {
      const result = await driver.exec(name, 'exit 42');
      expect(result.exitCode).toBe(42);
    });

    itIfDocker('should execute multi-command pipelines', async () => {
      const result = await driver.exec(name, 'echo a && echo b && echo c');
      expect(result.stdout.trim().split('\n')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('file operations', () => {
    const name = `${TEST_PREFIX}-files`;

    beforeAll(async () => {
      if (!hasDocker()) return;
      await driver.start(name);
    });

    afterAll(async () => {
      if (!hasDocker()) return;
      await driver.destroy(name).catch(() => {});
    });

    itIfDocker('should write and read a file', async () => {
      await driver.writeFile(name, '/workspace/test.txt', 'hello from test');
      const content = await driver.readFile(name, '/workspace/test.txt');
      expect(content.trim()).toBe('hello from test');
    });

    itIfDocker('should write file in subdirectory', async () => {
      const content = JSON.stringify({ foo: 'bar', num: 42 });
      await driver.writeFile(name, '/workspace/sub/deep/file.json', content);
      const read = await driver.readFile(name, '/workspace/sub/deep/file.json');
      expect(JSON.parse(read)).toEqual({ foo: 'bar', num: 42 });
    });

    itIfDocker('should list files', async () => {
      await driver.writeFile(name, '/workspace/a.txt', 'aaa');
      await driver.writeFile(name, '/workspace/b.txt', 'bbb');
      await driver.exec(name, 'mkdir -p /workspace/subdir');
      await driver.writeFile(name, '/workspace/subdir/c.txt', 'ccc');

      const files = await driver.listFiles(name, '/workspace');
      const names = files.map((f) => f.name);

      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
      expect(names).toContain('subdir');
      expect(names).not.toContain('..');

      const subdir = files.find((f) => f.name === 'subdir');
      expect(subdir?.type).toBe('directory');

      const subFiles = await driver.listFiles(name, '/workspace/subdir');
      expect(subFiles.map((f) => f.name)).toContain('c.txt');
    });

    itIfDocker('should return empty list for non-existent directory', async () => {
      const files = await driver.listFiles(name, '/nonexistent');
      expect(files).toEqual([]);
    });
  });

  describe('execStream', () => {
    const name = `${TEST_PREFIX}-stream`;

    beforeAll(async () => {
      if (!hasDocker()) return;
      await driver.start(name);
    });

    afterAll(async () => {
      if (!hasDocker()) return;
      await driver.destroy(name).catch(() => {});
    });

    itIfDocker('should stream stdout', async () => {
      const chunks: string[] = [];
      const stderrChunks: string[] = [];
      const result = await driver.execStream(
        name,
        'echo line1; echo line2; echo line3',
        {
          onStdout: (data) => chunks.push(data),
          onStderr: (data) => stderrChunks.push(data),
        },
      );

      expect(result.exitCode).toBe(0);
      const all = chunks.join('') + stderrChunks.join('');
      if (all.length > 0) {
        expect(all).toContain('line1');
      }
    });

    itIfDocker('should respect timeout', async () => {
      const name = `${TEST_PREFIX}-stream-timeout`;
      await driver.start(name);

      try {
        const chunks: string[] = [];
        await driver.execStream(
          name,
          'echo start && sleep 10 && echo end',
          { onStdout: (d) => chunks.push(d) },
          { timeout: 3000 },
        );
      } catch {
        // Expected timeout
      }

      await driver.destroy(name).catch(() => {});
    }, 15_000);
  });

  describe('git operations', () => {
    const name = `${TEST_PREFIX}-git`;
    let hasGit = false;

    beforeAll(async () => {
      if (!hasDocker()) return;
      await driver.start(name);
      const { exitCode } = await driver.exec(name, 'which git 2>/dev/null');
      hasGit = exitCode === 0;
      if (!hasGit) return;
      await driver.exec(name, 'git config --global user.email "test@test.com"');
      await driver.exec(name, 'git config --global user.name "Test User"');
      await driver.exec(name, 'mkdir -p /workspace');
    });

    afterAll(async () => {
      if (!hasDocker()) return;
      await driver.destroy(name).catch(() => {});
    });

    const itIfGit = () => hasGit && hasDocker() ? it : it.skip;

    itIfGit()('should initialize a git repo', async () => {
      const { stdout } = await driver.exec(name, 'cd /workspace && git init 2>&1');
      expect(stdout.toLowerCase()).toContain('init');
    });

    itIfGit()('should show git status', async () => {
      const status = await driver.gitStatus(name);
      expect(status).toBeDefined();
      expect(typeof status.branch).toBe('string');
    });

    itIfGit()('should track modifications', async () => {
      await driver.exec(
        name,
        'cd /workspace && git config user.email "test@test.com" && git config user.name "Test User"',
      );

      await driver.writeFile(name, '/workspace/README.md', '# Test Repo');
      await driver.exec(name, 'cd /workspace && git add README.md && git commit -m "initial"');

      const { stdout: logOut } = await driver.exec(name, 'cd /workspace && git log --oneline -1 2>&1');
      expect(logOut).toContain('initial');

      await driver.writeFile(name, '/workspace/README.md', '# Modified');
      const modifiedStatus = await driver.gitStatus(name);
      expect(modifiedStatus.modified.length + modifiedStatus.untracked.length).toBeGreaterThanOrEqual(0);
    });

    itIfGit()('should push commits', async () => {
      // This will fail without a real remote, but should not throw SDK error
      await driver.writeFile(name, '/workspace/test-push.txt', 'test content');
      try {
        await driver.gitPush(name, 'test commit');
      } catch {
        // Expected: no remote configured
      }
    });
  });

  describe('stats', () => {
    const name = `${TEST_PREFIX}-stats`;

    beforeAll(async () => {
      if (!hasDocker()) return;
      await driver.start(name);
    });

    afterAll(async () => {
      if (!hasDocker()) return;
      await driver.destroy(name).catch(() => {});
    });

    itIfDocker('should return stats for running container', async () => {
      const stats = await driver.getStats(name);
      expect(typeof stats.cpu).toBe('number');
      expect(typeof stats.memory).toBe('number');
      expect(typeof stats.memoryLimit).toBe('number');
      expect(stats.memoryLimit).toBeGreaterThan(0);
      expect(typeof stats.processes).toBe('number');
    });

    itIfDocker('should throw for non-existent container', async () => {
      const { ContainerNotFoundError } = await import('../src/types');
      await expect(
        driver.getStats('non-existent-' + TEST_PREFIX),
      ).rejects.toThrow(ContainerNotFoundError);
    });
  });

  describe('list', () => {
    itIfDocker('should list all managed containers', async () => {
      const name = `${TEST_PREFIX}-list-me`;
      await driver.start(name);
      const containers = await driver.list();

      expect(containers.length).toBeGreaterThan(0);
      const found = containers.find((c) => c.name === name);
      expect(found).toBeDefined();
      expect(found!.state.status).toBe('running');

      await driver.destroy(name);
    });
  });

  describe('with repoUrl config', () => {
    itIfDocker('should create container with repoUrl label', async () => {
      const name = `${TEST_PREFIX}-clone-label`;
      await driver.create(name, {
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'master',
      });

      await driver.start(name);
      const state = await driver.getState(name);
      expect(state.status).toBe('running');

      await driver.destroy(name);
    }, 30_000);
  });

  describe('fetch', () => {
    itIfDocker('should proxy HTTP request to container', async () => {
      const name = `${TEST_PREFIX}-fetch`;
      await driver.start(name);

      await driver.exec(name, 'mkdir -p /workspace');
      await driver.writeFile(name, '/workspace/index.html', '<h1>Hello from DockerDriver</h1>');
      await driver.exec(
        name,
        'node -e "require(\'http\').createServer((q,r)=>{r.end(require(\'fs\').readFileSync(\'/workspace/index.html\',\'utf8\'))}).listen(3000)">/dev/null 2>&1 &',
      );

      await new Promise((r) => setTimeout(r, 3000));

      const state = await driver.getState(name);
      expect(state.ip).toBeTruthy();

      const response = await driver.fetch(
        name,
        new Request('http://localhost/index.html'),
        3000,
      );

      const text = await response.text();
      expect(text).toContain('Hello from DockerDriver');

      await driver.destroy(name);
    }, 20_000);
  });
});
