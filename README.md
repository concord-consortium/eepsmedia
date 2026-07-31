# eepsmedia plugins for CODAP

CODAP plugins authored by [EEPS Media](https://www.eeps.com/) (Tim Erickson / Epistemological
Engineering), maintained by the [Concord Consortium](https://concord.org).

Each plugin is a small web app that runs in an iframe inside
[CODAP](https://github.com/concord-consortium/codap) and talks to it over `postMessage`, using the
[CODAP Data Interactive Plugin API](https://github.com/concord-consortium/codap/wiki/CODAP-Data-Interactive-Plugin-API).

## The plugins

| Plugin | What it does | Ships |
|---|---|---|
| [Choosy](plugins/Choosy) | Organize and simplify datasets, especially those with many attributes | ✅ |
| [Scrambler](plugins/scrambler) | Test hypotheses by randomly varying an attribute | ✅ |
| [Simmer](plugins/simmer) | Build block-programmed simulations that generate data | ✅ |
| [Testimate](plugins/testimate) | Test hypotheses using classical inferential methods | ✅ |
| [Norma](plugins/norma) | Generate a sample dataset from a normal distribution | ❌ |
| [Lotti](plugins/lotti) | "Lottery Explorer" — play scenario-based games of chance and emit the results into CODAP | ❌ |

The four marked ✅ appear in CODAP's plugin menu and deploy from this repo. `Norma` and `Lotti`
have never been deployed — see [Known Issues](CLAUDE.md#known-issues-all-pre-existing-carried-over-from-the-monorepo).

**`Choosy` is capitalized deliberately.** S3, CODAP's plugin map, and saved documents all use that
spelling. The other five directories are lowercase.

## There is no build step

**Every plugin is static assets served as-is.** No bundler, no transpilation, no `webpack.config`.
`index.html` is the artifact — it loads its `src/*.js` directly via script tags.

This is the single most important thing to know about this repo. Don't go looking for a build.

## Layout

```
common/           shared libraries used by every plugin
  src/            codapInterface.js, iframe-phone.js, pluginHelper.js, ...
  art/            shared images
  jquery/         vendored jQuery + jQuery UI
  sweetalert2/    vendored
plugins/
  Choosy/ lotti/ norma/ scrambler/ simmer/ testimate/
bin/              deploy tooling (link checker, version extraction)
docs/             design docs and IAM setup
```

Plugins reference shared code as `../../common/...` from their `index.html`, which resolves to
`common/` at the repo root.

## Running a plugin locally

Serve the repo root, then point CODAP at your local copy with the `di` query parameter:

```bash
python3 -m http.server 8080
```

Then open CODAP with:

```
https://codap3.concord.org/?di=http://localhost:8080/plugins/simmer/index.html
```

If your browser blocks the local plugin as mixed content, run CODAP locally too and use an
`http://localhost` URL for both.

## Checks

No dependencies to install — these use Node's built-in test runner (Node 20+; CI uses 24):

```bash
node --test bin/lib/*.test.mjs      # unit tests
node bin/check-links.mjs            # verify every relative src/href resolves
node bin/plugin-version.mjs simmer  # print a plugin's version
```

`bin/check-links.mjs` is the only automated guard on the plugins themselves — there is no build and
no plugin test suite. It runs on every push and pull request, against all four deployable plugins,
because a change in `common/` can break a plugin nobody was touching.

## Deploying

Bump the plugin's `constants.version`, then push a tag named `<directory>-<version>`:

```bash
git tag simmer-2026a && git push origin simmer-2026a
```

CI validates the tag against the version constant in the source and refuses to deploy on a
mismatch, so a release can never ship with a stale version number. It then syncs the plugin and
`common/` to `s3://codap-resources/plugins/eepsmedia/`.

Full details in [CLAUDE.md](CLAUDE.md#deployment); design rationale and the first-deploy procedure
in [the design doc](docs/superpowers/specs/2026-07-31-eepsmedia-deployment-design.md).

## Internationalization

Scrambler and Testimate are both translated via [POEditor](https://poeditor.com/), but only
Scrambler is automated:

```bash
cd plugins/scrambler && npm install && npm run strings:pull
```

Testimate's translations are maintained manually, and the procedure is undocumented. Simmer, Norma,
and Lotti carry per-language files with no POEditor wiring. See
[CLAUDE.md](CLAUDE.md#internationalization).

## History

Extracted from
[`codap-data-interactives`](https://github.com/concord-consortium/codap-data-interactives) on
2026-07-31 with `git-filter-repo`, promoting that monorepo's `eepsmedia/` directory to the repo
root. History is preserved back to 2021-04-28.

## License

[MIT](LICENSE.md) — Copyright (c) 2021-2026 Concord Consortium.
