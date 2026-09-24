import { createRequire } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle, checkProject } from '../scripts/project.mjs';
import { releaseCopyFilter } from '../scripts/release-policy.mjs';

// Build-time dependencies only. Never install/upgrade packages or modify core snapshots here.
const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, '..');
await checkProject(repository);
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
if (esbuild.version !== '0.28.1') throw new Error('Use the pinned esbuild 0.28.1; do not upgrade dependencies.');
const stage = await mkdtemp(join(root, '.dist-staging-'));
const run = promisify(execFile);
try {
  const filter = await releaseCopyFilter(root);
  for (const folder of ['server', 'public', '.daas']) {
    await cp(join(root, folder), join(stage, folder), {
      recursive: true,
      filter,
    });
  }
  const built = await esbuild.build({
    absWorkingDir: repository,
    entryPoints: [join(root, 'server/adapters/framework-entry.ts')],
    outfile: join(stage, 'server/adapters/framework.bundle.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    tsconfig: join(root, 'tsconfig.json'), packages: 'bundle', metafile: true,
    external: ['node:*'], legalComments: 'eof', sourcemap: false,
    banner: { js: 'import { createRequire as __daasCreateRequire } from "node:module"; const require = __daasCreateRequire(import.meta.url);' },
  });
  // Fail rather than silently shipping a bundle that still needs deleted packages or npm modules.
  const dependencyReport = checkBundle(built.metafile, repository);
  const licenses = join(stage, 'licenses');
  await mkdir(licenses);
  await cp(join(repository, 'LICENSE'), join(licenses, 'framework-LICENSE'));
  const packageRoots = new Set();
  for (const input of Object.keys(built.metafile.inputs)) {
    const absolute = resolve(repository, input);
    const normalized = absolute.replaceAll('\\', '/');
    const at = normalized.lastIndexOf('/node_modules/');
    if (at < 0) continue;
    const parts = normalized.slice(at + 14).split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    packageRoots.add(normalized.slice(0, at) + '/node_modules/' + name);
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
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: 'daas-agent-service', version: '0.1.0', private: true, type: 'module',
    engines: { node: '>=22.19.0' }, scripts: { start: 'node server/main.ts' },
  }, null, 2));
  const info = {
    product: 'DaaS Agent', esbuild: esbuild.version, builtAt: new Date().toISOString(),
    entry: 'server/main.ts', dependencies: dependencyReport, source: JSON.parse(await readFile(join(repository, 'UPSTREAM.json'), 'utf8')),
  };
  await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify(info, null, 2));
  // Copy out of the repository and exercise the REAL bundle against a LOCAL fake HTTP model.
  // No real model, company gateway, credentials or internet are used by this check.
  const result = await run(process.execPath, [join(repository, 'scripts/check-release.mjs'), stage], {
    cwd: repository, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(stage, join(root, 'dist'));
  console.log('DaaS 发布目录已生成并完成隔离验证：daas-web/dist。容器无需 packages/、node_modules 或构建工具。');
} finally {
  await rm(stage, { recursive: true, force: true });
}
