import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only on an administrator build machine with the branch's existing offline dependencies.
// No install, package upgrade, network request, or core source mutation is performed.
const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
if (esbuild.version !== '0.28.1') throw new Error('Use the existing pinned esbuild 0.28.1; do not upgrade dependencies.');
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
for (const folder of ['server', 'public', '.daas']) {
  await cp(join(root, folder), join(dist, folder), { recursive: true,
    filter: source => !/settings\.json$|\.local\.|framework-entry\.ts$|framework\.bundle\.mjs(?:\.map)?$/.test(source) });
}
const built = await esbuild.build({
  entryPoints: [join(root, 'server/adapters/framework-entry.ts')],
  outfile: join(dist, 'server/adapters/framework.bundle.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  tsconfig: join(root, 'tsconfig.json'), packages: 'bundle', metafile: true,
  external: ['node:*'], legalComments: 'eof', sourcemap: false,
  banner: { js: 'import { createRequire as __daasCreateRequire } from "node:module"; const require = __daasCreateRequire(import.meta.url);' },
});
// Preserve bundled third-party licenses outside all browser-exposed directories.
const licenses = join(dist, 'licenses'); await mkdir(licenses);
try { await cp(join(repository, 'LICENSE'), join(licenses, 'framework-LICENSE')); } catch { throw new Error('Upstream LICENSE is required for distribution.'); }
const packageRoots = new Set();
for (const input of Object.keys(built.metafile.inputs)) {
  const absolute = resolve(input); const parts = absolute.split('/node_modules/');
  if (parts.length < 2) continue;
  const last = parts.at(-1).split('/'); const name = last[0].startsWith('@') ? last.slice(0, 2).join('/') : last[0];
  packageRoots.add(absolute.slice(0, absolute.lastIndexOf('/node_modules/')) + '/node_modules/' + name);
}
const notices = [];
for (const folder of packageRoots) {
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license });
  for (const name of await readdir(folder)) if (/^(license|licence|copying|notice)(\.|$)/i.test(name)) {
    await cp(join(folder, name), join(licenses, `${pkg.name.replaceAll('/', '__')}-${name}`), { recursive: true });
  }
}
await writeFile(join(licenses, 'packages.json'), JSON.stringify(notices, null, 2));
await writeFile(join(dist, 'package.json'), JSON.stringify({ name: 'daas-agent-service', version: '0.1.0', private: true, type: 'module', engines: { node: '>=22.19.0' }, scripts: { start: 'node server/main.ts' } }, null, 2));
await writeFile(join(dist, 'BUILD-INFO.json'), JSON.stringify({ product: 'DaaS Agent', esbuild: esbuild.version, builtAt: new Date().toISOString(), entry: 'server/main.ts' }, null, 2));
console.log('DaaS 离线运行目录已生成：daas-web/dist（无需 CLI/TUI、tsgo 或在线安装）。');
