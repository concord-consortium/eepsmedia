#!/usr/bin/env node
import { readVersion } from './lib/manifest.mjs';

const plugin = process.argv[2];

if (!plugin) {
  console.error('usage: node bin/plugin-version.mjs <plugin>');
  process.exit(2);
}

try {
  process.stdout.write(readVersion(plugin) + '\n');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
