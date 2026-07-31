# eepsmedia Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this repo its own deployment mechanism — per-plugin git tags that trigger a GitHub Actions sync to `s3://codap-resources/plugins/eepsmedia/`.

**Architecture:** A single `.github/workflows/ci.yml` with two jobs. `check` runs on every push and PR: unit tests plus a link check across all deployable plugins. `deploy` runs only on tags of the form `<plugin>-<version>`, validates the tag against the plugin's `constants.version`, assumes an OIDC role, and `aws s3 sync`s the plugin plus `common/`. A small manifest at `.github/deploy-manifest.json` defines the deployable set and locates each plugin's version constant. There is no build step — the repo *is* the artifact.

**Tech Stack:** GitHub Actions, AWS CLI (`s3 sync`), OIDC role assumption, Node 24 (built-in `node:test`, zero npm dependencies).

**Spec:** `docs/superpowers/specs/2026-07-31-eepsmedia-deployment-design.md`

## Global Constraints

- **No build step.** Every plugin is static assets served as-is; `index.html` is the artifact.
- **Zero npm dependencies.** No `package.json` at the repo root. Use Node's built-in `node:test` and standard library only. Node 24 is available locally and on `ubuntu-latest`.
- **S3 destination:** `s3://codap-resources/plugins/eepsmedia/` — `common/` and `plugins/<name>/` beneath it. This mirrors the repo root exactly.
- **Deployable set:** `Choosy`, `scrambler`, `simmer`, `testimate`. **Not** `norma`, **not** `lotti`.
- **Tag format:** `<directory>-<version>`, directory name **verbatim** including capital `Choosy`.
- **Version constant regex must accept three quote styles:** `'2021m'` (Choosy), `"1.7"` (scrambler), `` `2026e` `` (testimate). Verified: exactly one match per file.
- **Cache-Control: `no-cache`** — plain. Not `must-revalidate`, not `no-store`.
- **No `--acl public-read`** (bucket has ACLs disabled) and **no `--size-only`** (payload is ~10 MB; upload everything).
- **`--delete` on both syncs.** Verified: 0 orphans currently exist across all four plugins and `common/`.
- **PR 1 must change no deployable plugin bytes.** A plugin content change cannot ship until that plugin is tagged.
- **AWS:** role `arn:aws:iam::612297603577:role/eepsmedia`, region `us-east-1`. **Not yet provisioned — see Blocker.**

---

## File Structure

| File | Responsibility |
|---|---|
| `.github/deploy-manifest.json` | Defines the deployable set; maps plugin → version source file. |
| `bin/lib/manifest.mjs` | Loads the manifest; extracts a plugin's `constants.version`. |
| `bin/lib/manifest.test.mjs` | Tests for the above. |
| `bin/lib/links.mjs` | Finds broken relative `src`/`href` refs in an HTML file. |
| `bin/lib/links.test.mjs` | Tests for the above. |
| `bin/plugin-version.mjs` | CLI: print a plugin's version. Consumed by `ci.yml`. |
| `bin/check-links.mjs` | CLI: link-check plugins. Consumed by `ci.yml`. |
| `.github/workflows/ci.yml` | `check` + `deploy` jobs. |
| `CLAUDE.md` | Rewrite the deployment section; drop the resolved case-mismatch issue. |

Logic lives in `bin/lib/*.mjs` so it is importable and testable; the `bin/*.mjs` CLIs are thin wrappers that handle argv and exit codes.

---

# PR 1 — Infrastructure

Changes no deployable plugin bytes. Mergeable and fully verifiable without AWS access.

---

### Task 1: Rename `plugins/choosy` → `plugins/Choosy`

S3 holds exactly one spelling — `plugins/eepsmedia/plugins/Choosy/`, capital C — and V3's `standard-plugins.json` and saved documents both point there. GitHub Actions runs on case-sensitive Linux, so this cannot be papered over. Renaming is internally free: no capital-`Choosy` reference exists in the repo except CLAUDE.md prose, and the plugin's own asset paths are all relative.

**Files:**
- Rename: `plugins/choosy/` → `plugins/Choosy/`

**Interfaces:**
- Consumes: nothing.
- Produces: the path `plugins/Choosy/`, and `plugins/Choosy/src/choosy.js` (note: the **directory** is capitalized, the **file** is not). Task 2's manifest depends on this exact path.

- [ ] **Step 1: Confirm the current state**

```bash
ls plugins/ | sort
git status --porcelain
```

Expected: `choosy` present (lowercase), working tree clean.

- [ ] **Step 2: Rename in two steps**

macOS is case-insensitive, so a direct `git mv choosy Choosy` can be rejected as a no-op. Go through a temporary name:

```bash
git mv plugins/choosy plugins/choosy-tmp
git mv plugins/choosy-tmp plugins/Choosy
```

- [ ] **Step 3: Verify git recorded renames, not delete+add**

```bash
git status --porcelain
```

Expected: every line begins with `R ` (rename). Ten files. If you see `D `/`A ` pairs instead, the rename was not detected — `git add -A` and re-check `git status`.

- [ ] **Step 4: Verify the plugin's internal refs still resolve**

```bash
node -e '
const fs=require("fs"),path=require("path");
const idx="plugins/Choosy/index.html";
const html=fs.readFileSync(idx,"utf8");
const refs=[...html.matchAll(/(?:src|href)="([^"]*)"/g)].map(m=>m[1]);
const bad=refs.filter(r=>r&&!/^(https?:)?\/\/|^#|^data:|^mailto:/.test(r)&&!fs.existsSync(path.join(path.dirname(idx),r.split("#")[0].split("?")[0])));
console.log(bad.length?("BROKEN: "+bad.join(", ")):"all "+refs.length+" refs resolve");
'
```

Expected: `all 24 refs resolve`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename plugins/choosy to plugins/Choosy to match S3 and CODAP

S3 holds only plugins/eepsmedia/plugins/Choosy/ (capital C), and V3's
standard-plugins.json and saved documents both point there. GitHub Actions
runs on case-sensitive Linux, where the monorepo's rsync from Choosy/ would
fail — it only ever worked because macOS is case-insensitive.

No content changes: the plugin's asset paths are all relative, and no
capital-Choosy reference existed in the repo outside CLAUDE.md prose."
```

---

### Task 2: Deploy manifest and version extraction

**Files:**
- Create: `.github/deploy-manifest.json`
- Create: `bin/lib/manifest.mjs`
- Create: `bin/lib/manifest.test.mjs`
- Create: `bin/plugin-version.mjs`

**Interfaces:**
- Consumes: `plugins/Choosy/` from Task 1.
- Produces:
  - `loadManifest(): Record<string, {versionFile: string}>`
  - `pluginNames(): string[]` — manifest keys, in order
  - `readVersion(plugin: string): string` — throws on unknown plugin or missing constant
  - `repoRoot: string` — absolute path to the repo root
  - CLI `node bin/plugin-version.mjs <plugin>` — prints the version, exit 0; prints error to stderr, exit 1 (unknown plugin / no constant) or 2 (no argument)

- [ ] **Step 1: Write the failing tests**

Create `bin/lib/manifest.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test 'bin/lib/*.test.mjs'
```

Expected: FAIL — `Cannot find module .../bin/lib/manifest.mjs`

- [ ] **Step 3: Create the manifest**

Create `.github/deploy-manifest.json`:

```json
{
  "Choosy":    { "versionFile": "plugins/Choosy/src/choosy.js" },
  "scrambler": { "versionFile": "plugins/scrambler/src/scrambler.js" },
  "simmer":    { "versionFile": "plugins/simmer/src/simmer.js" },
  "testimate": { "versionFile": "plugins/testimate/src/testimate.js" }
}
```

- [ ] **Step 4: Implement the library**

Create `bin/lib/manifest.mjs`:

```javascript
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test 'bin/lib/*.test.mjs'
```

Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 6: Add the CLI wrapper**

Create `bin/plugin-version.mjs`:

```javascript
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
```

- [ ] **Step 7: Verify the CLI by hand**

```bash
node bin/plugin-version.mjs simmer          # expect: 2025a
node bin/plugin-version.mjs Choosy          # expect: 2021m
node bin/plugin-version.mjs nope; echo "exit=$?"   # expect: error + exit=1
node bin/plugin-version.mjs; echo "exit=$?"        # expect: usage + exit=2
```

- [ ] **Step 8: Commit**

```bash
git add .github/deploy-manifest.json bin/lib/manifest.mjs bin/lib/manifest.test.mjs bin/plugin-version.mjs
git commit -m "feat: add deploy manifest and version extraction

The manifest's keys define the deployable set (norma and lotti are excluded
by absence). It also locates each plugin's constants.version, which cannot be
derived by convention: Choosy's directory is capitalized but its source file
is not.

The version regex accepts single quotes, double quotes, and backticks —
all three styles are in use across the four plugins."
```

---

### Task 3: Link checker

The only automated guard available: there is no build and no test suite for the plugins themselves. `lotti` serves as the negative fixture — it has three genuinely broken refs (documented in CLAUDE.md), which proves the checker can actually fail.

**Files:**
- Create: `bin/lib/links.mjs`
- Create: `bin/lib/links.test.mjs`
- Create: `bin/check-links.mjs`

**Interfaces:**
- Consumes: `pluginNames()`, `repoRoot` from Task 2.
- Produces:
  - `brokenRefs(htmlPath: string): string[]` — refs that do not resolve, in document order
  - `checkPlugin(plugin: string): string[]` — same, for `plugins/<plugin>/index.html`
  - CLI `node bin/check-links.mjs [plugin...]` — defaults to all manifest plugins; exit 0 if all clean, 1 if any broken

- [ ] **Step 1: Write the failing tests**

Create `bin/lib/links.test.mjs`:

```javascript
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

test('detects lotti\'s three known-broken refs', () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test 'bin/lib/*.test.mjs'
```

Expected: FAIL — `Cannot find module .../bin/lib/links.mjs`

- [ ] **Step 3: Implement the library**

Create `bin/lib/links.mjs`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test 'bin/lib/*.test.mjs'
```

Expected: PASS — 8 tests total (5 from Task 2, 3 here), 0 failures.

- [ ] **Step 5: Add the CLI wrapper**

Create `bin/check-links.mjs`:

```javascript
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
```

- [ ] **Step 6: Verify the CLI by hand**

```bash
node bin/check-links.mjs; echo "exit=$?"
```

Expected:
```
ok   Choosy
ok   scrambler
ok   simmer
ok   testimate
exit=0
```

Then confirm it can fail:

```bash
node bin/check-links.mjs lotti; echo "exit=$?"
```

Expected: `FAIL lotti: 3 broken reference(s)` plus the three refs, `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add bin/lib/links.mjs bin/lib/links.test.mjs bin/check-links.mjs
git commit -m "feat: add link checker for plugin index.html files

Verifies every relative src/href resolves to a file in the repo. This is the
only automated guard available — there is no build and no test suite.

Runs against all deployable plugins, not just the one being deployed, because
a common/ change can break a plugin nobody was touching.

lotti is used as a negative test fixture: its index.html loads ../common/*.js,
resolving to a plugins/common/ directory that does not exist. A checker that
can never fail proves nothing."
```

---

### Task 4: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `node bin/check-links.mjs` (Task 3), `node bin/plugin-version.mjs <plugin>` (Task 2), `node --test 'bin/lib/*.test.mjs'`.
- Produces: the deploy pipeline. Nothing later depends on it programmatically.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: Continuous Integration

on:
  push:
    branches: [master]
    tags:
      - 'Choosy-*'
      - 'scrambler-*'
      - 'simmer-*'
      - 'testimate-*'
  pull_request:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing tag to re-deploy (e.g. simmer-2026a)'
        required: true

jobs:
  check:
    name: Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - name: Unit tests
        run: node --test 'bin/lib/*.test.mjs'
      - name: Link check all deployable plugins
        run: node bin/check-links.mjs

  deploy:
    name: Deploy to codap-resources
    needs: check
    if: startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      id-token: write   # required for OIDC token issuance
      contents: read
    concurrency:
      group: eepsmedia-deploy
      cancel-in-progress: false
    env:
      TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}
      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Parse tag into plugin and version
        run: |
          PLUGIN="${TAG%%-*}"
          VERSION="${TAG#*-}"
          if [[ -z "$PLUGIN" || -z "$VERSION" || "$PLUGIN" == "$TAG" ]]; then
            echo "::error::Tag '$TAG' is not of the form <plugin>-<version>."
            exit 1
          fi
          echo "PLUGIN=$PLUGIN" >> "$GITHUB_ENV"
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"

      - name: Validate tag against constants.version
        run: |
          SOURCE_VERSION="$(node bin/plugin-version.mjs "$PLUGIN")"
          echo "tag version = $VERSION"
          echo "source version = $SOURCE_VERSION"
          if [[ "$VERSION" != "$SOURCE_VERSION" ]]; then
            echo "::error::Tag version '$VERSION' does not match constants.version '$SOURCE_VERSION' in the source. Bump the version constant, or fix the tag."
            exit 1
          fi

      - name: Sanity-check the plugin tree
        run: |
          if [[ ! -s "plugins/$PLUGIN/index.html" ]]; then
            echo "::error::plugins/$PLUGIN/index.html is missing or empty — refusing to sync (would wipe production)."
            exit 1
          fi

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::612297603577:role/eepsmedia
          aws-region: us-east-1

      # Cache-Control: no-cache means "store, but revalidate before reuse" —
      # unchanged files cost a header-only 304. Uniform across every file so a
      # deploy can never leave a half-updated plugin (new JS, stale strings).
      # No --size-only: the payload is ~10 MB, so upload everything and avoid
      # the same-size-different-content trap entirely.
      - name: Sync plugin
        run: |
          aws s3 sync "plugins/$PLUGIN/" \
            "s3://codap-resources/plugins/eepsmedia/plugins/$PLUGIN/" --delete \
            --exclude "node_modules/*" --exclude ".idea/*" \
            --cache-control "no-cache"

      - name: Sync common/
        run: |
          aws s3 sync common/ \
            s3://codap-resources/plugins/eepsmedia/common/ --delete \
            --exclude "node_modules/*" --exclude ".idea/*" \
            --cache-control "no-cache"
```

- [ ] **Step 2: Validate the YAML parses**

```bash
node -e '
const fs=require("fs");
const y=fs.readFileSync(".github/workflows/ci.yml","utf8");
if(/\t/.test(y)) throw new Error("tabs are illegal in YAML");
console.log("no tabs, "+y.split("\n").length+" lines");
'
```

Expected: `no tabs, <N> lines`

- [ ] **Step 3: Verify the tag-parsing logic locally**

The workflow's parsing is plain bash; test it directly before trusting CI:

```bash
for TAG in simmer-2026a scrambler-1.7 Choosy-2021m testimate-2026e badtag; do
  PLUGIN="${TAG%%-*}"; VERSION="${TAG#*-}"
  if [[ -z "$PLUGIN" || -z "$VERSION" || "$PLUGIN" == "$TAG" ]]; then
    echo "$TAG -> REJECTED"
  else
    echo "$TAG -> plugin=$PLUGIN version=$VERSION"
  fi
done
```

Expected:
```
simmer-2026a -> plugin=simmer version=2026a
scrambler-1.7 -> plugin=scrambler version=1.7
Choosy-2021m -> plugin=Choosy version=2021m
testimate-2026e -> plugin=testimate version=2026e
badtag -> REJECTED
```

- [ ] **Step 4: Verify validation would reject a stale tag**

Simmer is currently `2025a`, so a `simmer-2026a` tag must be rejected until Task 6 bumps it. Confirm the comparison behaves:

```bash
SOURCE_VERSION="$(node bin/plugin-version.mjs simmer)"
[[ "2026a" != "$SOURCE_VERSION" ]] && echo "correctly rejects simmer-2026a (source is $SOURCE_VERSION)"
[[ "2025a" == "$SOURCE_VERSION" ]] && echo "correctly accepts simmer-2025a"
```

Expected: both lines print.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add tag-triggered deploy workflow

check runs on every push and PR: unit tests plus a link check across all
deployable plugins. deploy runs only on <plugin>-<version> tags, validates the
tag against the plugin's constants.version, assumes an OIDC role, and syncs the
plugin plus common/ to codap-resources.

Cache-Control: no-cache uniformly, so unchanged files cost a header-only 304
and a deploy can never leave a half-updated plugin. No --size-only (the payload
is ~10 MB) and no --acl (the bucket has ACLs disabled).

Deploys are gated on arn:aws:iam::612297603577:role/eepsmedia, which is not yet
provisioned."
```

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:45-62` (the "Deployment (unresolved — active work)" section)
- Modify: `CLAUDE.md:103-105` (the resolved case-mismatch known issue)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing programmatic.

- [ ] **Step 1: Replace the deployment section**

Replace the whole section from the heading `## Deployment (unresolved — active work)` through the line ending `...which stops being true once the above is done.` with:

```markdown
## Deployment

Plugins deploy to `s3://codap-resources/plugins/eepsmedia/`, which mirrors this repo's root
exactly — `common/` and `plugins/<name>/` beneath it. There is no build step, so the repo *is*
the artifact.

**To deploy a plugin:** bump its `constants.version`, then push a tag `<directory>-<version>`:

```bash
git tag simmer-2026a && git push origin simmer-2026a
```

`.github/workflows/ci.yml` validates the tag against the plugin's `constants.version`, then syncs
`plugins/<name>/` and `common/` to S3. A mismatch fails the build — you cannot deploy without
bumping the version. Use the workflow's `workflow_dispatch` input to re-deploy an existing tag.

The deployable set is defined by the keys of `.github/deploy-manifest.json`: `Choosy`, `scrambler`,
`simmer`, `testimate`. `norma` and `lotti` are deliberately absent and do not deploy.

Everything is uploaded with `Cache-Control: no-cache`, so browsers revalidate via ETag and pick up
changes on the next load. Steady-state deploys need no CloudFront invalidation.

Design rationale, the first-deploy procedure, and the `--delete` semantics are in
`docs/superpowers/specs/2026-07-31-eepsmedia-deployment-design.md`.

Corresponding cleanup still pending in the `codap-data-interactives` monorepo:
- `bin/build` — remove eepsmedia from `STATIC_PLUGIN_DIRS` and `HIDDEN_DIRS`
- `bin/update-strings` — remove `./eepsmedia/plugins/scrambler` from `TRANSLATED_PLUGIN_ROOTS`
- `src/data_interactive_map.json` — remove scrambler, testimate, simmer, norma, Choosy entries
  (`published-plugins.json` and `plugins.md` are generated and will follow)

And in the `codap` repo on branch `master`: `bin/strings-pull-plugins` documents Scrambler as one
of the plugins it covers, which stops being true once the above is done.
```

- [ ] **Step 2: Remove the resolved case-mismatch issue**

Delete these three lines from the Known Issues list:

```markdown
- **Case mismatch:** the monorepo refers to `plugins/Choosy` (capital C) but the directory is
  `choosy`. This works only because macOS is case-insensitive and would break a Linux build.
  Worth settling on one spelling here.
```

- [ ] **Step 3: Update the lotti known issue to mention the checker**

Find the lotti entry in Known Issues and append to it:

```markdown
  `bin/check-links.mjs` detects this — run `node bin/check-links.mjs lotti` to see the three
  broken refs. lotti is not in the deploy manifest, so CI does not check it.
```

- [ ] **Step 4: Verify no stale references remain**

```bash
grep -n "unresolved\|Case mismatch\|piggy-back" CLAUDE.md; echo "exit=$?"
```

Expected: `exit=1` (grep found nothing).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the deployment mechanism in CLAUDE.md

Replaces the 'Deployment (unresolved)' section now that the mechanism exists,
and removes the Choosy case-mismatch known issue, which Task 1 resolved."
```

---

### Task 6: Open PR 1

- [ ] **Step 1: Run the full check suite one final time**

```bash
node --test 'bin/lib/*.test.mjs' && node bin/check-links.mjs
echo "exit=$?"
```

Expected: 8 tests pass, four `ok` lines, `exit=0`.

- [ ] **Step 2: Confirm no deployable plugin bytes changed**

This is the defining constraint of PR 1. The only plugin-path changes must be the Choosy rename:

```bash
git diff --stat master...HEAD -- plugins/ common/
```

Expected: only `plugins/choosy/... => plugins/Choosy/...` rename lines, with `0 insertions, 0 deletions` of content. Any other plugin change belongs in PR 2 — move it.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin CODAP-1423-deploy-design
```

**Write the PR body to a file using your editor, then pass it with `--body-file`.** Do NOT use a
heredoc (`cat > file <<'EOF'`) — heredocs fail to parse in this environment, especially when the
body contains apostrophes or `<...>`. Going straight to a file avoids the failed-then-retry dance.

Create `pr1-body.md` with this content:

```markdown
Gives this repo its own deployment mechanism, replacing the CODAP V2 build that the
extraction from `codap-data-interactives` severed.

Design: `docs/superpowers/specs/2026-07-31-eepsmedia-deployment-design.md`

## What this adds

- **`.github/workflows/ci.yml`** — `check` on every push/PR (unit tests + link check);
  `deploy` on `<plugin>-<version>` tags.
- **`.github/deploy-manifest.json`** — its keys define the deployable set.
- **`bin/check-links.mjs`** — verifies every relative `src`/`href` resolves. The only
  automated guard available; there is no build and no test suite.
- **`bin/plugin-version.mjs`** — extracts `constants.version` for tag validation.
- **`plugins/choosy` → `plugins/Choosy`** — required. S3 and CODAP both use capital C,
  and Actions runs on case-sensitive Linux.

## What this deliberately does NOT do

No deployable plugin bytes change. Under this design a plugin content change cannot ship
until that plugin is tagged, so bundling content here would leave the repo and S3 diverged.
The Simmer version bump and vendored-code removal are PR 2.

## Blocked on

`arn:aws:iam::612297603577:role/eepsmedia` does not exist yet. This PR is safe to merge
without it — the `check` job is fully functional; only `deploy` is gated.
```

Then:

```bash
gh pr create --title "feat: tag-triggered deployment to codap-resources" --body-file pr1-body.md
rm pr1-body.md
```

---

# PR 2 — Simmer, and the first live test

Branch from `master` **after PR 1 merges**.

---

### Task 7: Bump Simmer's version and remove the vendored interpreter

Resolves CODAP-1460. Verified: codap.xyz's `2026a` is byte-identical to this repo's `2025a` across all 27 other files — only the version string differs. Both already pin `blockly@11`.

**Files:**
- Modify: `plugins/simmer/src/simmer.js:242`
- Delete: `plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/` (27 files, 2.3 MB)

**Interfaces:**
- Consumes: `bin/check-links.mjs`, `bin/plugin-version.mjs` from PR 1.
- Produces: `readVersion('simmer') === '2026a'`, which tag `simmer-2026a` requires.

- [ ] **Step 1: Branch from master**

```bash
git checkout master && git pull
git checkout -b simmer-2026a
```

- [ ] **Step 2: Confirm the vendored directory is unreferenced**

Never delete 2.3 MB on trust. Verify first:

```bash
grep -rniE "neilfraser|acorn|new Interpreter|interpreter\.js" \
  --include=*.html --include=*.js --include=*.json --include=*.css --include=*.md . \
  | grep -v "^\./\.git/" | grep -v "NeilFraser-JS-Interpreter-1f48e30/"
echo "exit=$?"
```

Expected: no output, `exit=1`. Any hit means stop and investigate.

- [ ] **Step 3: Bump the version**

In `plugins/simmer/src/simmer.js` line 242, change:

```javascript
        version: '2025a',
```

to:

```javascript
        version: '2026a',
```

- [ ] **Step 4: Verify the extractor sees the new version**

```bash
node bin/plugin-version.mjs simmer
```

Expected: `2026a`

- [ ] **Step 5: Remove the vendored interpreter**

```bash
git rm -r --quiet plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/
```

- [ ] **Step 6: Verify nothing broke**

```bash
node --test 'bin/lib/*.test.mjs' && node bin/check-links.mjs
du -sh plugins/simmer
```

Expected: tests pass, four `ok` lines, and `plugins/simmer` drops from 2.6M to roughly 300K.

- [ ] **Step 7: Commit**

The message is multi-line, so **write it to a file with your editor and pass it with `-F`.** Do NOT
use a heredoc — heredocs fail to parse in this environment. Create `simmer-commit.txt` with:

```text
feat(simmer): bump to 2026a and drop the unused vendored JS-Interpreter

Resolves CODAP-1460. The ticket reported that CODAP's plugin menu opens Simmer
2025a while codap.xyz serves 2026a, and inferred codap.xyz had newer code. It
does not: 27 of the 28 files under src/, strings/, css/ and art/ are
byte-identical, and the only difference is the version string itself. Both
already pin blockly@11.

The labels diverged because the Blockly v12 crash was hotfixed directly
(0aee332 touched only index.html, leaving the version alone) while Tim fixed it
independently, bumped to 2026a, and redeployed codap.xyz without pushing back.
Labelling this 2026a is accurate — the code genuinely matches what he published.

Also removes plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/, 2.3 MB of
Simmer's 2.6 MB and referenced by nothing in the repo. It is an unpacked tarball
of https://github.com/NeilFraser/JS-Interpreter pinned at
1f48e30b7736adf8f77b49a82f9d7236e9d1654a (2023-02-14), added ten days later in
bb497b3 and never wired up. Upstream remains active, so anyone building Blockly
step-through execution later should pull a current release rather than revive a
3.5-year-old snapshot. Recover with: git show bb497b3
```

Then:

```bash
git add -A
git commit -F simmer-commit.txt
rm simmer-commit.txt
```

- [ ] **Step 8: Push and open PR 2**

```bash
git push -u origin simmer-2026a
```

Create `pr2-body.md` with your editor (again: no heredoc):

```markdown
Resolves CODAP-1460, and is the first live test of the deployment mechanism added in PR 1.

## The version bump

CODAP-1460 reported that the plugin menu opens Simmer `2025a` while codap.xyz serves `2026a`,
and inferred codap.xyz had newer code. **It does not.** 27 of the 28 files under `src/`,
`strings/`, `css/` and `art/` are byte-identical; only the version string differs. Both already
pin `blockly@11`. Findings are recorded on the ticket.

## The vendored removal

`plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/` is 2.3 MB of Simmer's 2.6 MB and is
referenced by nothing. An unpacked tarball of NeilFraser/JS-Interpreter pinned at `1f48e30`
(2023-02-14), added ten days later and never wired up. Tim does not deploy it either — every
file in it 404s on codap.xyz.

## Why this is the first deploy

It exercises tag parsing, manifest lookup, version validation, the link checker, a real content
sync, and `--delete` (exactly 27 expected deletions) in one pass — with an unusually
well-understood blast radius, since the resulting plugin is byte-identical to what codap.xyz has
served for a month.
```

Then:

```bash
gh pr create --title "feat(simmer): bump to 2026a and drop unused vendored JS-Interpreter" --body-file pr2-body.md
rm pr2-body.md
```

---

### Task 8: First deploy (BLOCKED on IAM role)

**Do not start until `arn:aws:iam::612297603577:role/eepsmedia` exists** and PR 2 has merged.

- [ ] **Step 1: Dry-run and review the diff**

```bash
git checkout master && git pull
aws s3 sync plugins/simmer/ s3://codap-resources/plugins/eepsmedia/plugins/simmer/ \
  --delete --cache-control "no-cache" --dryrun | grep "^(dryrun) delete:" | wc -l
```

Expected: **exactly 27** deletions, all under `NeilFraser-JS-Interpreter-1f48e30/`. Anything else is a red flag — stop and investigate rather than proceeding.

- [ ] **Step 2: Tag and push**

```bash
git tag simmer-2026a
git push origin simmer-2026a
```

Watch the Actions run. The `Validate tag against constants.version` step must report `tag version = 2026a` and `source version = 2026a`.

If the sync step fails with an ACL error, the bucket does **not** have Object Ownership enforced after all — add `--acl public-read` to both `aws s3 sync` commands in `ci.yml` and re-run. (The design omits it based on story-builder's working job; this is the step that confirms or refutes that.)

- [ ] **Step 3: Confirm the uploaded objects are publicly readable**

The workflow deliberately passes no `--acl`. Verify that objects are still world-readable via direct bucket access — if this returns 403, the omission was wrong and `--acl public-read` is required.

```bash
curl -sI "https://codap-resources.concord.org/plugins/eepsmedia/plugins/simmer/index.html" \
  | head -1
```

Expected: `HTTP/2 200`. A `403` means stop — fix the ACL handling before invalidating anything.

- [ ] **Step 4: One-time CloudFront invalidation**

Objects currently on S3 carry no `Cache-Control` at all, so they are subject to heuristic freshness and must be flushed once. Use the **stripped** path — `/codap-resources/plugins/...` matches nothing because a viewer-request function rewrites the URI before the cache key is computed.

```bash
for D in E1RS9TZVZBEEEC E7WVRGISCR2VR E26XOJN7T3CJO; do
  aws cloudfront create-invalidation --distribution-id $D --paths "/plugins/eepsmedia/*"
done
```

- [ ] **Step 5: Verify the edge actually refetched**

A `Completed` status proves nothing.

```bash
for host in codap.concord.org codap3.concord.org; do
  echo "--- $host ---"
  curl -sI "https://$host/codap-resources/plugins/eepsmedia/plugins/simmer/index.html" \
    | grep -iE "x-cache|last-modified"
done
```

Expected: `x-cache: Miss from cloudfront` plus a current `last-modified` on the first request. A `Hit` with a stale `last-modified` means the wrong path was invalidated.

- [ ] **Step 6: Confirm the version users see**

```bash
curl -s "https://codap.concord.org/codap-resources/plugins/eepsmedia/plugins/simmer/src/simmer.js" \
  | grep -n "version"
```

Expected: `version: '2026a',`

- [ ] **Step 7: Confirm the vendored directory is gone from S3**

```bash
aws s3 ls s3://codap-resources/plugins/eepsmedia/plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/
echo "exit=$?"
```

Expected: no output, non-zero exit.

- [ ] **Step 8: Verify the steady-state no-invalidation claim**

This is load-bearing — it is the entire reason the workflow needs no CloudFront permissions. On the **next** deploy after this one, skip the invalidation and confirm the edge still serves the new content. If it does not, add `cloudfront:CreateInvalidation` on all three distributions to the IAM role and invalidate on every deploy.

- [ ] **Step 9: Close CODAP-1460**

Comment with the deployed version and the verification output, then transition to Done.

---

## Blocker

**`arn:aws:iam::612297603577:role/eepsmedia` does not exist.** Infra must create it, trusting this repo's GitHub OIDC and granting write to `s3://codap-resources/plugins/eepsmedia/*`. This mirrors the existing `role/story-builder`, so it is a known ask.

Tasks 1–7 are all unblocked. Only Task 8 requires the role.

## Out of scope

POEditor synchronization — its own spec. Scrambler's string pull still works standalone
(`cd plugins/scrambler && npm install && npm run strings:pull`); Testimate's procedure is
undocumented and needs Tim. Scrambler's two years of stranded translations will ship on its
first tag regardless.
