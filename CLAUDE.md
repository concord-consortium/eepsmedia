# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Repository Overview

CODAP plugins authored by EEPS Media (Tim Erickson / Epistemological Engineering). Each plugin
is a web app that runs in an iframe and talks to [CODAP](https://github.com/concord-consortium/codap)
via postMessage, using the
[CODAP Data Interactive Plugin API](https://github.com/concord-consortium/codap/wiki/CODAP-Data-Interactive-Plugin-API).

This repo was extracted from the `codap-data-interactives` monorepo on 2026-07-31 using
`git-filter-repo`, promoting the monorepo's `eepsmedia/` directory to the repo root. Git history
was preserved (102 commits back to 2021-04-28). See CODAP-1423.

## There Is No Build Step

**Every plugin is static assets served as-is.** There are no webpack configs, no bundlers, no
transpilation. Do not go looking for a build; `index.html` is the artifact.

Only two plugins have a `package.json`, and neither builds anything:
- `plugins/scrambler/package.json` — `strings:pull*` scripts only (i18n, see below)
- `plugins/lotti/package.json` — a stub with no dependencies

There *is* Node tooling in `bin/`, but it is deploy tooling, not a build: it validates versions and
checks links, and never produces or transforms a deployed file. It has **no dependencies** and no
root `package.json` — it uses only Node's standard library and built-in test runner, so there is
nothing to `npm install` at the repo root.

(If you've read the monorepo's CLAUDE.md, note that its "Webpack + vanilla JS" description of
Scrambler/Testimate/Simmer is stale and was never true of this code.)

## Layout

```
common/           shared libraries used by all plugins
  src/            codapInterface.js, iframe-phone.js, pluginHelper.js, pluginLang.js,
                  codap_helper.js, codap_helper_newAPI.js, kcpcommon.js, raphael.js, ...
  art/            shared images
  jquery/         vendored jQuery + jQuery UI
  sweetalert2/    vendored
plugins/
  Choosy/ lotti/ norma/ scrambler/ simmer/ testimate/
bin/              deploy tooling (no dependencies)
  lib/            manifest.mjs, links.mjs + their *.test.mjs
  check-links.mjs, plugin-version.mjs
docs/
  deploying.md    operator guide: --delete semantics, caching, CloudFront
  iam/            deploy role setup, policy documents
.github/
  deploy-manifest.json    the deployable set
  workflows/ci.yml        check + deploy jobs
```

`Choosy` is capitalized deliberately: S3, CODAP's `standard-plugins.json`, and saved documents all
use that spelling, so the repo matches. The other five are lowercase.

Plugins reference shared code with `../../common/...` from their `index.html`, which resolves to
`common/` at the repo root. This worked identically inside the monorepo — nothing referenced the
monorepo's root-level `Common/` (capital C), which is a *separate* copy used by non-EEPS plugins.

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
changes on the next load. **No deploy needs a CloudFront invalidation** — verified, not assumed.

Local checks (no dependencies, Node 24):

```bash
node --test 'bin/lib/*.test.mjs'   # unit tests
node bin/check-links.mjs           # link-check all deployable plugins
node bin/plugin-version.mjs simmer # print a plugin's constants.version
```

The pipeline is live — first deploy was `simmer-2026a` on 2026-07-31. Operational detail
(`--delete` semantics, caching rationale, the CloudFront stripped-path gotcha) is in
`docs/deploying.md`; the deploy role and its two non-obvious traps are in `docs/iam/README.md`.

**If a deploy ever fails at "Could not assume role with OIDC", it is almost certainly not a
permissions problem** — see the immutable subject claim section of `docs/iam/README.md`.

Corresponding cleanup still pending in the `codap-data-interactives` monorepo:
- `bin/build` — remove eepsmedia from `STATIC_PLUGIN_DIRS` and `HIDDEN_DIRS`
- `bin/update-strings` — remove `./eepsmedia/plugins/scrambler` from `TRANSLATED_PLUGIN_ROOTS`
- `src/data_interactive_map.json` — remove scrambler, testimate, simmer, norma, Choosy entries
  (`published-plugins.json` and `plugins.md` are generated and will follow)

And in the `codap` repo on branch `master`: `bin/strings-pull-plugins` documents Scrambler as one
of the plugins it covers, which stops being true once the above is done.

## Internationalization

**Scrambler and Testimate are both translated via POEditor, but only Scrambler is automated.**
Both draw from CODAP's POEditor project #125447, which currently holds application `DG.*` strings
and plugin `DG.plugin.*` strings together. (Plugin strings arguably don't belong in the same
project as application strings, but separating them is a task for another day.)

**Scrambler** — automated, and the automation was just severed by the extraction. The chain used
to be: the CODAP v2 build ran `bin/strings-pull-plugins`, which invoked the monorepo's root
`npm run strings:pull` → `bin/update-strings`, whose `TRANSLATED_PLUGIN_ROOTS` included
`./eepsmedia/plugins/scrambler`. Neither of those wrappers exists here, so run it directly:

```bash
cd plugins/scrambler && npm install && npm run strings:pull
```

Strings land in `plugins/scrambler/src/strings/strings.json`, filtered on the prefix
`DG.plugin.Scrambler`. The script requires a POEditor API token and will refuse to run without
one; supply it either as `--APIToken=<token>` on the command line or as an `APIToken=` (or
`API_TOKEN=`) line in `$HOME/.porc`.

**Testimate** — POEditor-localized but with no tooling at all. It ships
`strings/testimate_{English,German,Spanish}.json` (plus a stale `testimate_German.2024.json`) and
loads them through `strings/localize.js`. There is no `package.json` and no pull script, and
Testimate appears in neither `bin/update-strings` nor CODAP's `bin/strings-pull-plugins`. Its
Programmer Guide devotes exactly one sentence to the subject — "We use `POEditor` to help with
localization" — and that sentence is the last line of the file. So the procedure is manual and
undocumented; ask Tim Erickson before assuming how it works. Worth capturing here once known.

**Lotti and Norma** carry per-language JSON under `strings/` with no evident POEditor wiring.

Re-establishing an automated translation pull is still open — the v2 build was the only thing
driving it, and deployment (above) deliberately did not take it on. Note the two are coupled:
Scrambler's `src/strings/strings.json` is a deployed artifact, so a pull is only half the job —
the strings do not reach users until Scrambler is tagged.

## Known Issues (all pre-existing, carried over from the monorepo)

- `plugins/lotti/index.html:27-29` loads `../common/iframe-phone.js` (and two siblings), which
  resolves to `plugins/common/` — a directory that does not exist. Almost certainly should be
  `../../common/`. Lotti ships nowhere, so this has gone unnoticed.
  `bin/check-links.mjs` detects this — run `node bin/check-links.mjs lotti` to see the three
  broken refs. lotti is not in the deploy manifest, so CI does not check it.
- `common/src/kcpcommon.css` and `common/src/dsg.css` reference `../img/*.png` and
  `../art/pause.png` that don't exist. Both files are referenced by nothing in this repo — dead.
- `plugins/scrambler/bin/pull-dev-strings:12` expects a sibling CODAP checkout at a path that no
  longer makes sense post-extraction. Dev-only script, not part of any deploy.
- **Scrambler's version is inconsistent and uses a different scheme.** `src/scrambler.js` says
  `1.7` while `package.json` says `1.6.0`, and every other plugin uses a year-letter scheme
  (`2026e`, `2025a`, …). Deliberately left alone — it's Tim's to decide. Note the deploy validator
  reads the *source* constant, so `package.json`'s number never affects a deploy; a Scrambler tag
  is `scrambler-1.7`.
- `norma` was registered in the monorepo's plugin map but never copied into a release; `lotti` was
  referenced nowhere at all. Decide whether either is still wanted.

## External Runtime Dependencies

`plugins/simmer/index.html:36` loads Blockly from `https://unpkg.com/blockly@11/blockly.min.js`.
The major version is pinned deliberately — Blockly v12 removed `getAllVariables()`, which Simmer
depends on. Do not loosen that pin without testing Simmer's variable handling.
