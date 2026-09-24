import { realpath } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

// Private model files may have an administrator-selected name. Compare real paths as well as paths.
export async function releaseCopyFilter(root, env = process.env) {
  const privatePaths = new Set([
    resolve(root, '.daas/settings.json'), resolve(root, '.daas/models.json'),
    ...(env.DAAS_MODELS_FILE ? [resolve(root, env.DAAS_MODELS_FILE)] : []),
  ]);
  for (const path of [...privatePaths]) {
    try { privatePaths.add(await realpath(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return async source => {
    const name = basename(source);
    if (/^(?:settings|models)\.json$/.test(name) || name.includes('.local.') ||
        /^(?:framework-entry\.ts|framework\.bundle\.mjs(?:\.map)?)$/.test(name)) return false;
    const path = resolve(source);
    const resource = relative(resolve(root, '.daas'), path).replaceAll('\\', '/');
    if (resource && !resource.startsWith('../') && resource !== '..') {
      const first = resource.split('/')[0];
      if (!['index.ts', 'extensions', 'skills', 'prompts', 'settings.example.json', 'models.example.json'].includes(first)) return false;
    }
    return !privatePaths.has(path) && !privatePaths.has(await realpath(path));
  };
}
