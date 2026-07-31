# Deploying eepsmedia plugins to codap-resources

**Date:** 2026-07-31
**Status:** Approved design, not yet implemented
**Scope:** Deployment only. POEditor synchronization is deliberately excluded — see
[Out of scope](#out-of-scope).

## Problem

This repo was extracted from `codap-data-interactives` on 2026-07-31 (CODAP-1423), promoting the
monorepo's `eepsmedia/` directory to the repo root. The extraction severed the only mechanism that
shipped these plugins: the monorepo's `bin/build` copied them into a CODAP **V2** release zip, and
V3 updates were made by piggy-backing on a V2 build and hand-copying files to S3. No more V2 builds
are planned, so this repo currently has no way to deploy.

That gap is already costing something. Comparing S3 against `master`:

| Plugin | S3 `index.html` | Latest local commit | Undeployed work |
|---|---|---|---|
| Choosy | 2024-03-21 | 2022-07-18 | none |
| scrambler | 2024-03-21 | 2026-07-31 | 5 translation-string commits (`b071741`, `e598196`, `f1bd926`, `4996686`, `f74487d`) |
| simmer | 2026-06-24 | 2026-06-25 | none (Blockly v11 pin was hand-copied) |
| testimate | 2026-02-12 | 2026-04-13 | `3668848` — always recalculate test at the beginning of a randomization |

Scrambler's updated translations have been stranded for over two years.

## Key insight

**The S3 layout already mirrors this repo exactly.** The bucket contains:

```
s3://codap-resources/plugins/eepsmedia/
├── common/
└── plugins/{Choosy,scrambler,simmer,testimate}/
```

Because the extraction promoted `eepsmedia/` to the root, a sync of this repo's root into
`s3://codap-resources/plugins/eepsmedia/` *is* the entire deploy. There is no build step — every
plugin is static assets served as-is, and `index.html` is the artifact.

This means **nothing in the `codap` repo needs to change.** `standard-plugins.json` keeps pointing
at `/eepsmedia/plugins/<name>/index.html`, and every saved CODAP document keeps resolving. That is
an explicit non-goal of this design, not an accident.

## Design

### Trigger and tag format

Deploys are triggered by pushing a **per-plugin git tag** of the form `<directory>-<version>`:

```
testimate-2026e
simmer-2025a
Choosy-2021m
scrambler-1.7
```

Every plugin already carries a `constants.version` that is reported to CODAP through its
`*.connect.js` (`version: <plugin>.constants.version`). The tag reuses that existing, already-visible
version rather than inventing a parallel scheme:

| Plugin | Version source | Value | Quote style |
|---|---|---|---|
| Choosy | `plugins/Choosy/src/choosy.js:363` | `2021m` | single |
| scrambler | `plugins/scrambler/src/scrambler.js:453` | `1.7` | double |
| simmer | `plugins/simmer/src/simmer.js:242` | `2025a` | single |
| testimate | `plugins/testimate/src/testimate.js:248` | `2026e` | backtick |

CI validates the tag against the source constant and fails on mismatch, so "forgot to bump the
version" is caught at deploy time. **The version regex must accept all three quote styles.**

The tag prefix is the **directory name verbatim**, including capital `Choosy`. This is mildly
inconsistent-looking next to `scrambler`, but it preserves a single spelling across repo, tag, S3,
CODAP's plugin map, and saved documents — with no second mapping rule to remember.

### Workflow structure

A single `.github/workflows/ci.yml`, following the org convention (story-builder,
noaa-codap-plugin, and cloud-file-manager all use `ci.yml` holding both check and deploy jobs).

```yaml
on:
  push:
    branches: [master]
    tags: ['Choosy-*', 'scrambler-*', 'simmer-*', 'testimate-*']
  pull_request:

jobs:
  check:     # every push + PR — link-check all four plugins
  deploy:    # needs: check; if: startsWith(github.ref, 'refs/tags/')
```

On a tag push both jobs run, `check` gating `deploy`. On a PR or a master push, only `check` runs.

The `check` job runs against **all four plugins**, not just the one being deployed — a `common/`
change can break a plugin nobody was touching, and this catches it.

Deploy job steps, for tag `testimate-2026e`:

1. **Parse** `PLUGIN=testimate`, `VERSION=2026e` from the tag.
2. **Look up** the version source file in `.github/deploy-manifest.json`.
3. **Validate** that `constants.version` in that file equals `2026e`; fail otherwise.
4. **Sanity-check** that `plugins/testimate/index.html` exists and is non-empty — refuse to sync
   otherwise, since `--delete` against an empty tree would wipe production.
5. **Authenticate** via OIDC: `aws-actions/configure-aws-credentials@v6`, assuming
   `arn:aws:iam::612297603577:role/eepsmedia`, region `us-east-1`.
6. **Sync the plugin**, then **sync `common/`**.

```bash
aws s3 sync plugins/testimate/ \
  s3://codap-resources/plugins/eepsmedia/plugins/testimate/ --delete \
  --exclude "node_modules/*" --exclude ".idea/*" \
  --cache-control "no-cache"

aws s3 sync common/ \
  s3://codap-resources/plugins/eepsmedia/common/ --delete \
  --exclude "node_modules/*" --exclude ".idea/*" \
  --cache-control "no-cache"
```

Plus:

- `concurrency: {group: eepsmedia-deploy, cancel-in-progress: false}` so two deploys never
  interleave mid-sync.
- `workflow_dispatch` as an escape hatch, to re-deploy an existing tag without inventing a version
  bump. Rollback is therefore: push a tag on a revert commit, or dispatch an earlier tag.

### Why a manifest rather than convention

`.github/deploy-manifest.json` maps plugin directory to version source file:

```json
{
  "Choosy":    { "versionFile": "plugins/Choosy/src/choosy.js" },
  "scrambler": { "versionFile": "plugins/scrambler/src/scrambler.js" },
  "simmer":    { "versionFile": "plugins/simmer/src/simmer.js" },
  "testimate": { "versionFile": "plugins/testimate/src/testimate.js" }
}
```

Two reasons this is a file rather than a naming convention:

1. The path is **not derivable** after the Choosy rename — the directory is capitalized but the
   file inside is not (`plugins/Choosy/src/choosy.js`), so `plugins/<P>/src/<P>.js` breaks.
2. Its four keys **are the definition of the deployable set.** `norma` and `lotti` are excluded by
   simply not appearing, which is more legible than an exclusion list.

### `common/` is synced on every plugin deploy

`common/` is shared by all four plugins and has no version of its own. Every plugin deploy also
syncs it. It is diff-based and small, so this is usually a no-op, and it guarantees a `common/` fix
can never sit stranded waiting for a release it doesn't belong to.

The accepted trade-off: a `common/` change rides along with an unrelated plugin's release. Given
`common/` last changed in 2022, this is close to theoretical.

Both syncs use `--delete`, on the principle that the repo is the artifact. For `common/` this
carries a specific risk — deleting a file that some *other* plugin still references — which is
precisely what the link checker catches, and why it runs against all four plugins on every push
rather than only against the plugin being deployed.

### `--delete` semantics and verified safety

`--delete` is the one flag in this design capable of damaging production, so its behaviour was
verified empirically against the live bucket with `--dryrun` rather than assumed.

**Verified: there are currently zero orphans.** Dry runs of all four plugins and `common/` against
their S3 destinations report **0 deletions** in every case. S3 holds nothing the repo does not.
`--delete` can therefore only ever remove what is deliberately removed from the repo.

**`--exclude` does NOT protect against orphans — it creates them.** The exclude filter applies to
the *destination* listing as well as the source, so excluded keys are invisible to `--delete` and
are left on S3 permanently. Verified:

| Sync of `plugins/simmer/` | Deletions |
|---|---|
| `--delete` | 0 — the vendored dir exists in the source, so nothing is orphaned |
| `--delete --exclude "NeilFraser-JS-Interpreter-1f48e30/*"` | 0 — excluded keys are skipped on *both* sides |
| `--delete`, with the directory removed from the repo | 27 — exactly that directory, nothing else |

The practical consequence: **excluding a directory stops it being uploaded but strands whatever is
already on S3 forever.** Removing it from the repo is the only approach that both stops the upload
and cleans the bucket. This is counter-intuitive enough to be worth stating explicitly — the
tidy-looking fix is the one that silently leaves orphans.

### Caching

Everything deploys with `Cache-Control: no-cache`, uniformly — no per-file-type split, and
specifically **not** `no-store` on HTML.

**Why uniform.** story-builder splits its headers (long-lived `immutable` on content-hashed chunks,
`no-store` on HTML) because there the asymmetry is real: `index.html` is the only mutable file and
the sole pointer to which hashed chunks to load. This repo has **zero content-hashed filenames** —
verified — so `index.html` is just one of ~30 equally mutable, equally unhashed files that it loads
by plain name (Testimate 33 asset refs, Simmer 19, Choosy 16, Scrambler 12).

**Why that matters.** The failure mode here is not "HTML references chunks that no longer exist" —
it is the **half-updated plugin**: a new `testimate.js` paired with a stale
`strings/testimate_German.json`. This is not hypothetical; the codap-resources skill documents it
happening to the onboarding plugin, where lookups returned raw keys like
`~onboarding1.mammals.table.title`. Hardening only `index.html` would guarantee the manifest is
fresh while the files it loads might not be — which *is* the half-updated case. Keeping the whole
file set on one policy is what actually prevents it.

**Why `no-cache` and not `no-store`.** They are equivalent for staleness — both require contacting
the origin before content is reused. `no-cache` means "store it, but revalidate before reuse": the
browser sends `If-None-Match: <etag>` and an unchanged file returns `304 Not Modified` with an empty
body. `no-store` forgoes that and re-downloads in full every time. Same correctness, more bandwidth.

`must-revalidate` was considered and **rejected**. Plain `no-cache` permits a cache to serve a stale
copy when revalidation fails (origin unreachable); `must-revalidate` would force an error instead.
A stale-but-working plugin is preferable to a hard failure during a transient outage.

**No `--size-only`.** The codap-resources skill recommends it because timestamps never match between
local files and S3, but it misses same-size content changes — which is exactly why that skill then
has to work around itself by explicitly `cp`-ing `index.html` afterward. The whole payload is at
most ~10 MB (testimate 5.0M + common 4.8M, 122 files total), so uploading everything on every deploy
is cheaper than the workaround and removes the trap entirely.

**No `--acl public-read`.** The codap-resources skill documents passing it, but story-builder's
working deploy omits it, which implies the bucket has Object Ownership enforced (ACLs disabled) —
where passing `--acl` fails outright. Following the working precedent. **Verify on first deploy.**

### CloudFront

Steady-state deploys need **no invalidation**. CloudFront honors `Cache-Control: no-cache` by
revalidating with the origin, so once objects carry that header, new content is served immediately.

This claim is load-bearing — it is the entire reason the workflow needs no CloudFront permissions —
so **confirm it on the second deploy**, not just the first. Deploy a changed file without
invalidating and check that `codap.concord.org` and `codap3.concord.org` serve the new
`last-modified`. If they do not, the fallback is to add `cloudfront:CreateInvalidation` on all three
distributions to the IAM role and invalidate the stripped path on every deploy.

The **first deploy is the exception.** Objects currently on S3 were synced with no `Cache-Control`
at all, so they are subject to heuristic freshness (roughly 10% of the age since `Last-Modified` —
for 2024-era files, weeks of staleness). They must be flushed once, by hand.

### Link checker

`bin/check-links.mjs` — plain Node, no dependencies. Verifies that every relative `src`/`href` in
each plugin's `index.html` resolves to a file that exists in the repo. External URLs (Blockly,
Google Fonts) are skipped.

This is the only automated guard available: there is no build and no test suite. It has demonstrated
value — `plugins/lotti/index.html:27-29` loads `../common/iframe-phone.js`, which resolves to
`plugins/common/`, a directory that does not exist, and this has gone unnoticed for years precisely
because nothing checks. Running on Linux, it also catches case errors that macOS silently forgives.

## Implementation

### Repo changes

| Change | Notes |
|---|---|
| `git mv plugins/choosy plugins/Choosy` | Two-step through a temp name to survive the case-insensitive filesystem. |
| `.github/workflows/ci.yml` | Check + deploy jobs, as above. |
| `.github/deploy-manifest.json` | Plugin → version source file. |
| `bin/check-links.mjs` | Link checker. |
| `git rm -r plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/` | Remove dead vendored code — see below. |
| `CLAUDE.md` | Rewrite the "Deployment (unresolved — active work)" section; remove the case-mismatch entry from Known Issues. |

**Removing the vendored JS-Interpreter.** `plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/` is
**2.3 MB of Simmer's 2.6 MB** and is referenced by nothing anywhere in the repo.

It is an unpacked GitHub tarball (hence the `owner-repo-shortsha` directory name, and the absence of
a `.git`) of [NeilFraser/JS-Interpreter](https://github.com/NeilFraser/JS-Interpreter) — "a sandboxed
JavaScript interpreter in JavaScript", Apache-2.0, by the creator of Blockly. It is Blockly's
companion library for stepping through generated code while highlighting blocks as they execute.

- Pinned at upstream commit `1f48e30b7736adf8f77b49a82f9d7236e9d1654a`, dated **2023-02-14**.
- Added in `bb497b3` ("Added `simmer`") on **2023-02-24**, ten days later.

So it was downloaded fresh while Simmer was first being built, evidently for the standard Blockly
step-through integration, and never wired up. It has been dormant for 3.5 years while upstream stayed
active (last push 2026-06-17). Tim does not deploy it either — every file in it 404s on
`codap.xyz/plugins/simmer/`.

Removing it is safe and reversible: `git show bb497b3` recovers it, and anyone building step-through
execution later should pull a current release from the live upstream rather than revive a stale
snapshot. The commit message should record the upstream URL and pinned SHA so that intent is not
lost. The first Simmer deploy then cleans all 27 keys from S3 in the same pass.

**The Choosy rename.** S3 contains exactly one spelling — `plugins/eepsmedia/plugins/Choosy/`,
capital C, with no lowercase variant — and V3's `standard-plugins.json` and saved documents both
point there. The repo directory is `choosy`. This *must* be resolved rather than papered over:
GitHub Actions runs on Linux, which is case-sensitive, and the monorepo's `rsync` from `Choosy/`
only ever worked because macOS is not.

Renaming the directory is internally free — verified that no capital-`Choosy` reference exists
anywhere in the repo except CLAUDE.md prose, and the plugin's own asset paths are all relative.

### First deploy procedure

The first deploy ships real pending work, so it gets a one-time procedure:

1. **Dry-run each plugin manually** (`aws s3 sync --dryrun`) and review the diff before any tag
   exists. This has already been done once and returned **0 orphans across all four plugins and
   `common/`** (see [`--delete` semantics and verified safety](#--delete-semantics-and-verified-safety)),
   so the expected deletions on the first real deploy are exactly the 27 keys of the removed
   vendored JS-Interpreter directory — and nothing else. Anything beyond that is a red flag: stop
   and investigate rather than proceeding.
2. **Tag and deploy.** Scrambler picks up ~2 years of stranded translations; Testimate picks up
   `3668848`.
3. **One-time CloudFront invalidation**, all three distributions, at the **stripped** path
   `/plugins/eepsmedia/*`:

   ```bash
   for D in E1RS9TZVZBEEEC E7WVRGISCR2VR E26XOJN7T3CJO; do
     aws cloudfront create-invalidation --distribution-id $D --paths "/plugins/eepsmedia/*"
   done
   ```

   **Not** `/codap-resources/plugins/eepsmedia/*`. The `/codap-resources/*` behavior has a
   viewer-request function (`StripCodapResourcesPrefix`) that rewrites the URI *before* the cache
   key is computed, so objects are cached under the stripped key. An invalidation on the pre-rewrite
   path matches nothing, reports `Completed`, and purges zero objects.

4. **Verify** — a `Completed` status proves nothing:

   ```bash
   for host in codap.concord.org codap3.concord.org; do
     echo "--- $host ---"
     curl -sI "https://$host/codap-resources/plugins/eepsmedia/plugins/testimate/index.html" \
       | grep -iE "x-cache|last-modified"
   done
   ```

   Expect `x-cache: Miss from cloudfront` plus the new `last-modified` on the first request. A `Hit`
   with a stale `last-modified` means the wrong path was invalidated.

Steady state then reduces to: push tag → workflow syncs → done.

## Blocker

**The IAM role does not exist yet.** Infra must create `role/eepsmedia` in account `612297603577`,
trusting this repo's GitHub OIDC and granting write to `s3://codap-resources/plugins/eepsmedia/*`.
This mirrors the existing `role/story-builder`, so it is a known ask rather than a novel one.

Until it exists, deploys remain manual via the codap-resources skill. Everything else in this design
— the rename, the workflow, the manifest, the link checker — can be built and merged first; only the
deploy job's final steps are gated.

## Out of scope

**POEditor synchronization**, covered by its own spec. Recorded here because the two meet at a
deployed artifact:

- **Scrambler** is automated and still works standalone (`cd plugins/scrambler && npm install &&
  npm run strings:pull`) — the extraction severed only the two wrapper layers, not the script. Its
  output, `plugins/scrambler/src/strings/strings.json`, is a file this design deploys.
- **Testimate** is POEditor-localized with no tooling at all, and its format is a different shape
  entirely — nested per-language files (`{"testimate": {"flags":…, "staticStrings": {…}}}`) rather
  than flat `DG.plugin.*` keys. Its procedure is undocumented; ask Tim Erickson.

Scrambler's two years of stranded translations are the symptom of both gaps at once — the strings
were pulled, committed, and then had nowhere to go.

## Open items

- **CODAP-1460 is the first real exercise of this design.** The ticket reports that CODAP's plugin
  menu opens Simmer `2025a` while codap.xyz serves `2026a`, and infers codap.xyz has newer code.
  Verified: it does not. Of the 28 files under `src/`, `strings/`, `css/`, and `art/`, 27 are
  byte-identical, and the only difference is the version string on `src/simmer.js:242`. Both serve
  `blockly@11`. The labels diverged because the Blockly v12 crash was hotfixed directly in
  `codap-data-interactives` without a version bump (`0aee332` touched only `index.html`), while Tim
  fixed it independently, bumped to `2026a`, and redeployed codap.xyz without pushing back.
  The fix is therefore one line — bump `constants.version` to `2026a` — plus a deploy. Findings are
  recorded on the ticket. Note this also shows the guard working in the direction that matters:
  under this design the hotfix could not have shipped without a tag, and the tag could not have
  existed without a version bump.
- **Scrambler's version is inconsistent** — `1.7` in source, `1.6.0` in `package.json`, and a
  semver-ish scheme where every other plugin uses year-letter. Flagged, deliberately not changed:
  it is Tim's to decide, not a side effect of setting up deploys. Note the validator reads the
  *source* constant, so `package.json`'s number never affects a deploy.
- **`norma` and `lotti` are excluded.** Neither has ever been on S3. `norma` (version `2026a`) was
  registered in the monorepo's plugin map but never copied into a release; `lotti` was referenced
  nowhere. Whether either should ship is Tim's call. `lotti` would need its broken `../common/`
  paths fixed first — which the new link checker would catch.
- **`--acl public-read`** — confirm on first deploy whether the bucket accepts or rejects it.
- **Monorepo and codap cleanup** — the list already in CLAUDE.md (`bin/build`, `bin/update-strings`,
  `data_interactive_map.json`), plus updating the codap-resources skill to describe this repo's tag
  procedure instead of the V2-build path it currently documents.
