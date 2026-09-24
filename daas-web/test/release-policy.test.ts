import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseCopyFilter } from '../../scripts/release-policy.mjs';

test('packaging excludes private default/custom/symlink model config while keeping examples and prompts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'daas-package-models-')); t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'source'); const dest = join(root, 'dist'); await mkdir(join(src, '.daas/prompts'), { recursive: true });
  for (const name of ['models.json', 'settings.json', 'custom.json', 'models.example.json', 'settings.example.json', 'backup.local.json']) await writeFile(join(src, '.daas', name), name);
  await writeFile(join(src, '.daas/prompts/base.md'), 'DaaS Agent');
  await symlink(join(src, '.daas/custom.json'), join(src, '.daas/alias.json'));
  await cp(join(src, '.daas'), join(dest, '.daas'), { recursive: true, filter: await releaseCopyFilter(src, { DAAS_MODELS_FILE: '.daas/custom.json' }) });
  for (const name of ['models.json', 'settings.json', 'custom.json', 'alias.json', 'backup.local.json']) await assert.rejects(readFile(join(dest, '.daas', name)));
  for (const name of ['models.example.json', 'settings.example.json', 'prompts/base.md']) assert.ok(await readFile(join(dest, '.daas', name), 'utf8'));
});
