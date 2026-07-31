import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, parseVersion, pluginNames, readVersion, repoRoot } from './manifest.mjs';

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

test('parseVersion accepts all three quote styles', () => {
  // Choosy uses single quotes, scrambler double, testimate backticks.
  assert.equal(parseVersion("        version: '2021m',"), '2021m');
  assert.equal(parseVersion('        version: "1.7",'), '1.7');
  assert.equal(parseVersion('        version: `2026e`,'), '2026e');
});

test('parseVersion tolerates whitespace around the colon', () => {
  assert.equal(parseVersion('version:"x",'), 'x');
  assert.equal(parseVersion('version   :   `y`'), 'y');
});

test('parseVersion returns null when no constant is present', () => {
  assert.equal(parseVersion('const answer = 42;'), null);
});

test('every deployable plugin yields a non-empty version', () => {
  // Deliberately does NOT assert specific values — those change every release,
  // and encoding them here would break the suite on every deploy PR.
  for (const plugin of pluginNames()) {
    const version = readVersion(plugin);
    assert.ok(
      typeof version === 'string' && version.length > 0,
      `${plugin}: expected a non-empty version, got ${JSON.stringify(version)}`
    );
  }
});

test('unknown plugin throws a helpful error', () => {
  assert.throws(() => readVersion('nope'), /Unknown plugin "nope"/);
});
