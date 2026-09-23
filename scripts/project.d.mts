export const CORE_PACKAGES: string[];
export const DIRECT_PINS: Record<string, string>;
export function checkManifest(pkg: unknown, lock: unknown): { direct: number; locked: number };
export function checkProject(root: string): Promise<{ direct: number; locked: number }>;
export function checkBundle(metafile: unknown, root: string): { core: string[]; npm: string[] };
