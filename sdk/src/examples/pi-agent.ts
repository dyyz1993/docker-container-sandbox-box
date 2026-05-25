import {
  getContainer,
  listContainers,
  initDriver,
} from '@sandbox-box/containers';

initDriver({
  type: 'sandbox-box',
  baseUrl: 'http://192.168.0.29:9091',
  password: 'sandbox2024',
});

async function main(): Promise<void> {
  const containers = await listContainers();
  console.log(`Available: ${containers.map((c) => c.name).join(', ')}`);

  const sandbox = getContainer('my-project');

  const result = await sandbox.exec('ls -la /workspace');
  console.log(result.stdout);

  const pkg = await sandbox.readFile('/workspace/package.json');
  console.log('package.json:', pkg.slice(0, 200));

  await sandbox.writeFile(
    '/workspace/test.ts',
    'export const hello = "world";\n',
  );

  const git = await sandbox.gitStatus();
  console.log(`Branch: ${git.branch}, Modified: ${git.modified.length}`);

  await sandbox.gitPush('feat: add new feature');

  const other = getContainer('other-project');
  const testResult = await other.exec('npm test');
  console.log('Test exit code:', testResult.exitCode);
  if (testResult.stderr) console.error('Test stderr:', testResult.stderr);
}

main().catch(console.error);
