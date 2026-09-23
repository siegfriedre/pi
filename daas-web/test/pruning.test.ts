import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkManifest, checkProject, checkBundle, CORE_PACKAGES } from '../../scripts/project.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
test('pruned root has seven exact direct dependencies and a complete 35-record lock', () => {
  assert.deepEqual(checkManifest(pkg, lock), { direct: 7, locked: 35 });
  assert.equal(lock.packages['node_modules/undici'], undefined);
  assert.ok(lock.packages['node_modules/undici-types']);
});
test('upstream workspaces cannot silently return', () => {
  assert.throws(() => checkManifest({ ...pkg, workspaces: ['packages/*'] }, lock), /workspaces/);
});
test('version drift is rejected', () => {
  const changed = structuredClone(lock); changed.packages['node_modules/esbuild'].version = '9.0.0';
  assert.throws(() => checkManifest(pkg, changed), /0.28.1/);
});
test('missing optional platform binaries are detected in lock closure', () => {
  const changed = structuredClone(lock); delete changed.packages['node_modules/@esbuild/linux-x64'];
  assert.throws(() => checkManifest(pkg, changed), /Missing locked dependency/);
});
test('unused dependency records and workspace links are rejected', () => {
  const changed = structuredClone(lock);
  changed.packages['node_modules/terminal-only'] = { version: '1.0.0', integrity: 'sha512-AAAA' };
  assert.throws(() => checkManifest(pkg, changed), /unused packages/);
});
test('bundle guard allows three source packages and Node builtins only', () => {
  const report = checkBundle({
    inputs: { 'packages/agent/src/agent.ts': {}, 'packages/ai/src/index.ts': {}, 'packages/telemetry/src/index.ts': {}, 'node_modules/typebox/index.mjs': {} },
    outputs: { 'dist/framework.mjs': { imports: [{ path: 'node:fs', external: true }] } },
  }, root);
  assert.deepEqual(report, { core: CORE_PACKAGES, npm: ['typebox'] });
});
test('bundle guard rejects reintroduced CLI code and unresolved npm imports', () => {
  assert.throws(() => checkBundle({ inputs: { 'packages/coding-agent/src/cli.ts': {} }, outputs: {} }, root), /Unexpected core/);
  assert.throws(() => checkBundle({ inputs: {}, outputs: { out: { imports: [{ path: 'typebox', external: true }] } } }, root), /external dependency/);
});
test('project layout guard detects extra packages using an isolated fixture', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'daas-layout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  for (const file of ['packages/agent/src/agent.ts', 'packages/ai/src/index.ts', 'packages/ai/src/api/openai-completions.ts', 'packages/telemetry/src/index.ts', 'daas-web/server/adapters/framework-entry.ts']) {
    const target = join(dir, file); await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, '// Layout fixture only; not an upstream runtime.');
  }
  assert.deepEqual(await checkProject(dir), { direct: 7, locked: 35 });
  await mkdir(join(dir, 'packages/tui'));
  await assert.rejects(checkProject(dir), /three approved/);
});
