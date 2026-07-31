import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from './manifest.mjs';

/** Refs that are not repo-relative paths and so cannot be checked here. */
const EXTERNAL = /^(https?:)?\/\/|^#|^data:|^mailto:|^javascript:/i;

/**
 * Find every relative src/href in an HTML file that does not resolve to a
 * file on disk.
 * @param {string} htmlPath absolute path to the HTML file
 * @returns {string[]} broken refs, in document order
 */
export function brokenRefs(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const base = dirname(htmlPath);
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);

  const broken = [];
  for (const ref of refs) {
    if (ref === '' || EXTERNAL.test(ref)) continue;
    const target = ref.split('#')[0].split('?')[0];
    if (target === '') continue;
    if (!existsSync(join(base, target))) broken.push(ref);
  }
  return broken;
}

/**
 * @param {string} plugin directory name under plugins/
 * @returns {string[]} broken refs in that plugin's index.html
 */
export function checkPlugin(plugin) {
  return brokenRefs(join(repoRoot, 'plugins', plugin, 'index.html'));
}
