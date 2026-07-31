import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, pluginNames, readVersion, repoRoot } from './manifest.mjs';

test('manifest lists exactly the four deployable plugins', () => {
  assert.deepEqual(pluginNames(), ['Choosy', 'scrambler', 'simmer', 'testimate']);
});

test('manifest excludes norma and lotti', () => {
  const names = pluginNames();
  assert.ok(!names.includes('norma'), 'norma must not be deployable');
  assert.ok(!names.includes('lotti'), 'lotti must not be deployable');
});

test('every versionFile exists on disk', () => {
  for (const [plugin, entry] of Object.entries(loadManifest())) {
    assert.ok(
      existsSync(join(repoRoot, entry.versionFile)),
      `${plugin}: missing ${entry.versionFile}`
    );
  }
});

test('reads versions across all three quote styles', () => {
  // Choosy uses single quotes, scrambler double, testimate backticks.
  assert.equal(readVersion('Choosy'), '2021m');
  assert.equal(readVersion('scrambler'), '1.7');
  assert.equal(readVersion('simmer'), '2025a');
  assert.equal(readVersion('testimate'), '2026e');
});

test('unknown plugin throws a helpful error', () => {
  assert.throws(() => readVersion('nope'), /Unknown plugin "nope"/);
});
