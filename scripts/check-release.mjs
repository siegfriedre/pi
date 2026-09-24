import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(here, '../daas-web/dist'));
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
assert.equal(pkg.dependencies, undefined, 'Release must not need npm install.');
assert.equal(pkg.devDependencies, undefined);
assert.equal(pkg.workspaces, undefined);
const names = await readdir(source);
assert.ok(!names.includes('packages') && !names.includes('node_modules'));
await access(join(source, 'server/adapters/framework.bundle.mjs'));
await access(join(source, 'licenses/framework-LICENSE'));
for (const file of ['settings.json', 'models.json']) {
  await assert.rejects(access(join(source, '.daas', file)), 'Private configuration must be mounted separately.');
}
await access(join(source, '.daas/prompts/base.md'));
await access(join(source, '.daas/models.example.json'));
const temp = await mkdtemp(join(tmpdir(), 'daas-release-'));
try {
  const copy = join(temp, 'app');
  await cp(source, copy, { recursive: true });
  await cp(join(here, 'release-smoke.mjs'), join(temp, 'smoke.mjs'));
  const child = spawn(process.execPath, ['--experimental-strip-types', join(temp, 'smoke.mjs'), copy], {
    cwd: temp, shell: false, stdio: 'inherit',
    // Do not inherit real model keys, user credentials, import hooks or custom module search paths.
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NODE_PATH: '', NODE_OPTIONS: '' },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const code = await new Promise((resolveCode, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(new Error(`Release smoke killed: ${signal}`)) : resolveCode(code));
    });
    assert.equal(code, 0, 'Isolated release smoke failed.');
  } finally { clearTimeout(timer); }
  console.log('DaaS release passed: no source repository/node_modules; real bundled Agent and local mock model HTTP flow.');
} finally { await rm(temp, { recursive: true, force: true }); }
