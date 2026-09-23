import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const CORE_PACKAGES = ['agent', 'ai', 'telemetry'];
export const DIRECT_PINS = {
  '@types/node': '22.19.19', esbuild: '0.28.1', openai: '6.40.0',
  'partial-json': '0.1.7', tsx: '4.22.1', typebox: '1.3.27', typescript: '5.9.3',
};
export function checkManifest(pkg, lock) {
  assert.equal(pkg.workspaces, undefined, 'This application must not install upstream workspaces.');
  const direct = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.deepEqual(direct, DIRECT_PINS, 'Review dependency changes and update the explicit application contract.');
  assert.equal(pkg.scripts.prepare, undefined, 'Do not restore the terminal prepare hook.');
  assert.equal(lock.lockfileVersion, 3);
  for (const key of ['name', 'version', 'dependencies', 'devDependencies', 'engines']) {
    assert.deepEqual(lock.packages[''][key], pkg[key], `Lock root mismatch: ${key}`);
  }
  assert.equal(lock.packages[''].workspaces, undefined);
  const expected = new Set();
  const visit = name => {
    const key = `node_modules/${name}`;
    if (expected.has(key)) return;
    expected.add(key);
    const entry = lock.packages[key];
    assert.ok(entry && !entry.link, `Missing locked dependency: ${name}`);
    assert.match(entry.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `Unpinned dependency: ${name}`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, `Missing integrity: ${name}`);
    if (DIRECT_PINS[name]) assert.equal(entry.version, DIRECT_PINS[name]);
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) visit(dep);
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[dep]?.optional) visit(dep);
    }
  };
  Object.keys(direct).forEach(visit);
  assert.deepEqual(Object.keys(lock.packages).filter(k => k).sort(), [...expected].sort(), 'Lockfile retains unused packages or workspace links.');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key.startsWith('node_modules/@esbuild/')) assert.equal(entry.version, DIRECT_PINS.esbuild);
  }
  return { direct: Object.keys(direct).length, locked: expected.size };
}
export async function checkProject(root) {
  const read = async name => JSON.parse(await readFile(resolve(root, name), 'utf8'));
  const result = checkManifest(await read('package.json'), await read('package-lock.json'));
  const dirs = (await readdir(resolve(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(dirs, CORE_PACKAGES, 'Only the three approved core source snapshots should remain.');
  for (const file of [
    'packages/agent/src/agent.ts', 'packages/ai/src/index.ts',
    'packages/ai/src/api/openai-completions.ts', 'packages/telemetry/src/index.ts',
    'daas-web/server/adapters/framework-entry.ts',
  ]) await access(resolve(root, file));
  return result;
}
export function checkBundle(metafile, root) {
  const core = new Set();
  const npm = new Set();
  for (const name of Object.keys(metafile.inputs)) {
    const rel = relative(root, resolve(root, name)).replaceAll('\\', '/');
    assert.ok(!rel.startsWith('../') && !isAbsolute(rel), `Bundle input outside repository: ${name}`);
    const hit = /^packages\/([^/]+)\//.exec(rel);
    if (hit) {
      assert.ok(CORE_PACKAGES.includes(hit[1]), `Unexpected core dependency: ${hit[1]}`);
      core.add(hit[1]);
    }
    const tail = rel.split('/node_modules/').at(-1);
    const dependency = rel.startsWith('node_modules/') ? rel.slice(13) : tail !== rel ? tail : undefined;
    if (dependency) npm.add(dependency.startsWith('@') ? dependency.split('/').slice(0, 2).join('/') : dependency.split('/')[0]);
  }
  const builtin = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) if (imported.external) {
      assert.ok(builtin.has(imported.path), `Release still needs an external dependency: ${imported.path}`);
    }
  }
  return { core: [...core].sort(), npm: [...npm].sort() };
}
