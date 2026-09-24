import { resolve } from 'node:path';
import { AppError, readApproved } from './safety.ts';
import type { Mode } from './types.ts';

/** Administrator-owned prompt files, loaded as a startup snapshot. Not registered as model-readable resources. */
export async function loadSystemPrompts(root: string): Promise<Record<Mode, string>> {
  try {
    const folder = resolve(root, '.daas/prompts');
    const [base, common, developer, analyst] = await Promise.all(
      ['base.md', 'common.md', 'developer.md', 'analyst.md'].map(file => readApproved(folder, file, 20000)),
    );
    if ([base, common, developer, analyst].some(text => !text.trim())) throw new Error('Empty prompt');
    return { developer: [base, common, developer].join('\n\n'), analyst: [base, common, analyst].join('\n\n') };
  } catch { throw new AppError('PROMPT_CONFIG_ERROR', 'DaaS 提示词文件缺失、为空或不符合只读资源要求，请管理员检查配置。', 503); }
}
