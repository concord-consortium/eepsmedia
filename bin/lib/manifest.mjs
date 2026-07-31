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
 * Extract a `version:` constant from JavaScript source. Accepts single quotes,
 * double quotes, or backticks — all three styles are in use across the plugins.
 *
 * Kept pure and separate from readVersion so the parsing can be tested against
 * fixed inputs. Tests must not assert live version values: those change on
 * every release, and a test that encodes them breaks on every deploy PR.
 *
 * @param {string} source
 * @returns {string|null} the version, or null if no constant is present
 */
export function parseVersion(source) {
  const match = source.match(/version\s*:\s*(['"`])(.*?)\1/);
  return match ? match[2] : null;
}

/**
 * Read the plugin's `constants.version`. Each plugin reports this to CODAP
 * via its *.connect.js, so it is the version users actually see.
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
  const version = parseVersion(readFileSync(join(repoRoot, entry.versionFile), 'utf8'));
  if (version === null) {
    throw new Error(`No version constant found in ${entry.versionFile}`);
  }
  return version;
}
