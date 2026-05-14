#!/usr/bin/env node
/**
 * Post-`tsc` step: copy library markdown assets (`src/content/`,
 * `src/prompts/`) next to the compiled output so `src/stage.ts`'s
 * `import.meta.dirname` resolver finds them at the same relative offset under
 * both dev (tsx → `src/`) and prod (node → `dist/`).
 *
 * Run via `npm run build`, which is `tsc && node scripts/copy-library-assets.mjs`.
 */
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dist = resolve(repoRoot, 'dist');

const pairs = [
  ['src/content', 'content'],
  ['src/prompts', 'prompts'],
];

for (const [from, to] of pairs) {
  const src = resolve(repoRoot, from);
  const dst = resolve(dist, to);
  await rm(dst, { recursive: true, force: true });
  await cp(src, dst, { recursive: true });
  console.log(`[copy-library-assets] ${from} → dist/${to}`);
}
