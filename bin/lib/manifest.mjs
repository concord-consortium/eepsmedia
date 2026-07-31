import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the repo root (this file lives at <root>/bin/lib/). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST_PATH = join(repoRoot, '.github', 'deploy-manifest.json');

/**
 * The deployable set. Its keys ARE the definition of what may be deployed —
 * norma and lotti are excluded by simply not appearing here.
 * @returns {Record<string, {versionFile: string}>}
 */
export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** @returns {string[]} plugin directory names, in manifest order */
export function pluginNames() {
  return Object.keys(loadManifest());
}

/**
 * Extract the plugin's `constants.version`. Each plugin reports this to CODAP
 * via its *.connect.js, so it is the version users actually see.
 * Accepts single quotes, double quotes, or backticks — all three are in use.
 * @param {string} plugin
 * @returns {string}
 */
export function readVersion(plugin) {
  const manifest = loadManifest();
  const entry = manifest[plugin];
  if (!entry) {
    throw new Error(
      `Unknown plugin "${plugin}". Known: ${Object.keys(manifest).join(', ')}`
    );
  }
  const source = readFileSync(join(repoRoot, entry.versionFile), 'utf8');
  const match = source.match(/version\s*:\s*(['"`])(.*?)\1/);
  if (!match) {
    throw new Error(`No version constant found in ${entry.versionFile}`);
  }
  return match[2];
}
