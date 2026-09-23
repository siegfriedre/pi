import { fileURLToPath } from 'node:url';
import { checkProject } from './project.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await checkProject(root);
console.log(`DaaS project manifest checked: ${result.direct} direct dependencies, ${result.locked} locked records; 3 core source snapshots.`);
