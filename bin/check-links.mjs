#!/usr/bin/env node
import { checkPlugin } from './lib/links.mjs';
import { pluginNames } from './lib/manifest.mjs';

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : pluginNames();

let failed = false;

for (const plugin of targets) {
  let broken;
  try {
    broken = checkPlugin(plugin);
  } catch (err) {
    console.error(`ERROR ${plugin}: ${err.message}`);
    failed = true;
    continue;
  }

  if (broken.length > 0) {
    failed = true;
    console.error(`FAIL ${plugin}: ${broken.length} broken reference(s)`);
    for (const ref of broken) console.error(`       ${ref}`);
  } else {
    console.log(`ok   ${plugin}`);
  }
}

process.exit(failed ? 1 : 0);
