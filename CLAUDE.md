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
  choosy/ lotti/ norma/ scrambler/ simmer/ testimate/
```

Plugins reference shared code with `../../common/...` from their `index.html`, which resolves to
`common/` at the repo root. This worked identically inside the monorepo — nothing referenced the
monorepo's root-level `Common/` (capital C), which is a *separate* copy used by non-EEPS plugins.

## Deployment (unresolved — active work)

These plugins historically shipped as part of the CODAP **V2** build: the monorepo's `bin/build`
copied them into a release zip. For **V3**, updates have been deployed by piggy-backing on a V2
build and manually copying files to the V3 S3 destination.

With no more V2 builds planned, this repo needs its own deployment mechanism. That decision is
open. Because there's no build step, the question is only how static files reach S3/CODAP — not
how to build them.

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

Re-establishing a translation pull for this repo is part of the deployment work below — the v2
build was the only thing driving it.

## Known Issues (all pre-existing, carried over from the monorepo)

- `plugins/lotti/index.html:27-29` loads `../common/iframe-phone.js` (and two siblings), which
  resolves to `plugins/common/` — a directory that does not exist. Almost certainly should be
  `../../common/`. Lotti ships nowhere, so this has gone unnoticed.
- **Case mismatch:** the monorepo refers to `plugins/Choosy` (capital C) but the directory is
  `choosy`. This works only because macOS is case-insensitive and would break a Linux build.
  Worth settling on one spelling here.
- `common/src/kcpcommon.css` and `common/src/dsg.css` reference `../img/*.png` and
  `../art/pause.png` that don't exist. Both files are referenced by nothing in this repo — dead.
- `plugins/scrambler/bin/pull-dev-strings:12` expects a sibling CODAP checkout at a path that no
  longer makes sense post-extraction. Dev-only script, not part of any deploy.
- `norma` was registered in the monorepo's plugin map but never copied into a release; `lotti` was
  referenced nowhere at all. Decide whether either is still wanted.

## External Runtime Dependencies

`plugins/simmer/index.html:36` loads Blockly from `https://unpkg.com/blockly@11/blockly.min.js`.
The major version is pinned deliberately — Blockly v12 removed `getAllVariables()`, which Simmer
depends on. Do not loosen that pin without testing Simmer's variable handling.
