import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { brokenRefs, checkPlugin } from './links.mjs';
import { pluginNames, repoRoot } from './manifest.mjs';

test('every deployable plugin has zero broken refs', () => {
  for (const plugin of pluginNames()) {
    assert.deepEqual(checkPlugin(plugin), [], `${plugin} has broken refs`);
  }
});

test("detects lotti's three known-broken refs", () => {
  // lotti is not deployable, but it is a real fixture: its index.html loads
  // ../common/*.js, which resolves to plugins/common/ — a directory that does
  // not exist. A checker that can never fail is worthless, so assert it fails.
  const broken = brokenRefs(join(repoRoot, 'plugins', 'lotti', 'index.html'));
  assert.deepEqual(broken, [
    '../common/iframe-phone.js',
    '../common/codapInterface.js',
    '../common/pluginHelper.js',
  ]);
});

test('skips external, fragment, and data refs', () => {
  // simmer loads Blockly from unpkg; Choosy has #fragment hrefs and a
  // fonts.googleapis.com stylesheet. None may be reported as broken.
  assert.deepEqual(checkPlugin('simmer'), []);
  assert.deepEqual(checkPlugin('Choosy'), []);
});
