# Deploying

How plugins in this repo reach CODAP, and the non-obvious things that will bite you.

For the one-paragraph version — bump the version, push a tag — see
[CLAUDE.md](../CLAUDE.md#deployment). This document is for whoever is actually running or debugging
a deploy.

## Where things go

`s3://codap-resources/plugins/eepsmedia/` mirrors this repo's root exactly:

```
s3://codap-resources/plugins/eepsmedia/
├── common/                      ←  common/
└── plugins/<name>/              ←  plugins/<name>/
```

There is no build step, so **the repo is the artifact**. A deploy is `aws s3 sync` and nothing more.
Because the layout already matches, CODAP needs no changes: `standard-plugins.json` and every saved
document keep resolving to `/eepsmedia/plugins/<name>/index.html`.

## `--delete` semantics — read this before changing the sync

The workflow syncs with `--delete`, which is the only flag here capable of damaging production.
Its behaviour was verified against the live bucket with `--dryrun`.

**`--exclude` does not protect files from `--delete`. It strands them.** The exclude filter applies
to the *destination* listing as well as the source, so excluded keys become invisible to `--delete`
and stay on S3 permanently. Measured, syncing `plugins/simmer/`:

| Command | Deletions |
|---|---|
| `--delete` | 0 — the directory exists in the source, so nothing is orphaned |
| `--delete --exclude "SomeDir/*"` | 0 — excluded keys are skipped on *both* sides |
| `--delete`, directory removed from the repo | 27 — exactly that directory |

So **excluding a directory stops it being uploaded but never cleans it up.** Removing it from the
repo is the only approach that does both. This is counter-intuitive: the tidy-looking fix is the one
that silently leaves orphans forever.

As of 2026-07-31 there were **zero orphans** across all four plugins and `common/` — S3 held nothing
the repo did not. If a dry run ever shows unexpected deletions, stop and investigate rather than
proceeding.

## Caching — why everything is `no-cache`

Every file uploads with `Cache-Control: no-cache`, uniformly. Not `no-store`, not
`must-revalidate`, and no per-file-type split.

**`no-cache` means "store it, but revalidate before reuse"** — not "don't cache." The browser keeps
the file plus its `ETag`; later loads send `If-None-Match` and an unchanged file comes back as
`304 Not Modified` with an empty body. The steady-state cost is one header-only round-trip per file.
`no-store` would be the expensive one: a full re-download every time, with no correctness gain,
since both require contacting the origin before content is reused.

**Why uniform, and not just on `index.html`.** Nothing in this repo is content-hashed, so
`index.html` is one of ~30 equally mutable files that it loads by plain name. The failure mode here
is not "HTML points at chunks that no longer exist" — it is the **half-updated plugin**: a new
`testimate.js` paired with a stale `strings/testimate_German.json`. Hardening only the HTML would
guarantee a fresh manifest while its contents went stale, which *is* the half-updated case. Keeping
the whole file set on one policy is what prevents it.

**`must-revalidate` was considered and rejected.** It would forbid serving a stale copy when
revalidation fails (origin unreachable). A stale-but-working plugin beats a hard failure during a
transient outage.

**No `--size-only`.** It misses same-size content changes. The whole payload is ~10 MB, so uploading
everything every time is cheaper than the workarounds that flag requires.

**No `--acl public-read`.** The bucket has Object Ownership enforced, where passing `--acl` fails
outright. This follows `story-builder`'s working deploy — see [Still to do](#still-to-do) for the
verification that confirms it.

## CloudFront

**Steady-state deploys need no invalidation.** CloudFront honours `Cache-Control: no-cache` by
revalidating with the origin, so once objects carry that header, new content is served immediately.
This is why the deploy role needs no CloudFront permissions at all.

If you ever do need to invalidate, there are three distributions and **the path is not the one you
would expect**:

| Distribution | Serves | Invalidation path |
|---|---|---|
| `E1RS9TZVZBEEEC` | `codap-resources.concord.org` (direct) | `/plugins/eepsmedia/*` |
| `E7WVRGISCR2VR` | `codap3.concord.org` | `/plugins/eepsmedia/*` |
| `E26XOJN7T3CJO` | `codap.concord.org`, `codap2to3.concord.org` | `/plugins/eepsmedia/*` |

> 🛑 Use the **stripped** path `/plugins/eepsmedia/*`, **not** `/codap-resources/plugins/eepsmedia/*`.
> The `/codap-resources/*` behaviour has a viewer-request function (`StripCodapResourcesPrefix`)
> that rewrites the URI *before* the cache key is computed, so objects are cached under the stripped
> key. An invalidation on the pre-rewrite path matches nothing — it reports `Completed` while purging
> zero objects, and stale content keeps being served.

Production V3 does **not** load from `codap-resources.concord.org`; it uses a relative
`/codap-resources/...` path served by the app distributions. Invalidating only `E1RS9TZVZBEEEC`
leaves production users on stale files.

```bash
for D in E1RS9TZVZBEEEC E7WVRGISCR2VR E26XOJN7T3CJO; do
  aws cloudfront create-invalidation --distribution-id $D --paths "/plugins/eepsmedia/*"
done
```

**A `Completed` status proves nothing** — CloudFront reports no match count, so a wrong-path no-op
looks identical to a real purge. Verify by re-requesting:

```bash
for host in codap.concord.org codap3.concord.org; do
  echo "--- $host ---"
  curl -sI "https://$host/codap-resources/plugins/eepsmedia/plugins/simmer/index.html" \
    | grep -iE "x-cache|last-modified"
done
```

Expect `x-cache: Miss from cloudfront` plus a new `last-modified` on the first request. A `Hit` with
a stale `last-modified` after a `Completed` invalidation means you invalidated the wrong path.

## Still to do

Setup is not finished. In order:

**1. Provision the IAM role.** `arn:aws:iam::612297603577:role/eepsmedia` does not exist, and no
deploy can run without it. See [`docs/iam/README.md`](iam/README.md) — note that the org's standard
`create-deploy-role.sh` is *not* sufficient on its own.

**2. Ship Simmer 2026a.** Bump `constants.version` in `plugins/simmer/src/simmer.js` from `2025a` to
`2026a`, resolving CODAP-1460. Verified: codap.xyz's `2026a` is byte-identical to this repo's
`2025a` across all 27 other files — only the version string differs, and both already pin
`blockly@11`. The labels diverged because the Blockly v12 crash was hotfixed without a version bump
while Tim fixed it independently, bumped, and redeployed codap.xyz without pushing back.

In the same change, remove `plugins/simmer/NeilFraser-JS-Interpreter-1f48e30/` — **2.3 MB of
Simmer's 2.6 MB**, referenced by nothing. It is an unpacked tarball of
[NeilFraser/JS-Interpreter](https://github.com/NeilFraser/JS-Interpreter) pinned at
`1f48e30b7736adf8f77b49a82f9d7236e9d1654a` (2023-02-14), added ten days later in `bb497b3` and never
wired up. Upstream is still active, so anyone building Blockly step-through execution later should
pull a current release rather than revive a 3.5-year-old snapshot. Recover with `git show bb497b3`.

**3. Run the first deploy.** It is not a no-op — Scrambler has ~2 years of stranded translation
commits and Testimate has an undeployed bugfix (`3668848`).

- Dry-run first. Expected deletions: **exactly the 27 keys** of the removed vendored directory, and
  nothing else.
- Confirm objects are publicly readable, since the workflow passes no `--acl`:
  `curl -sI https://codap-resources.concord.org/plugins/eepsmedia/plugins/simmer/index.html`
  should return `200`. A `403` means the Object Ownership assumption was wrong — add
  `--acl public-read` to both sync steps.
- Invalidate CloudFront **once**. Objects currently on S3 carry no `Cache-Control` at all, so they
  are subject to heuristic freshness (roughly 10% of age since `Last-Modified` — for 2024-era files,
  weeks). This one-time flush is what puts them under `no-cache`.

**4. Verify the no-invalidation claim.** On the *second* deploy, skip the invalidation and confirm
the edge still serves new content. This is load-bearing — it is the entire reason the workflow needs
no CloudFront permissions. If it does not hold, add `cloudfront:CreateInvalidation` on all three
distributions to the role and invalidate on every deploy.

## Not covered here

**POEditor synchronization.** Scrambler's pull still works standalone
(`cd plugins/scrambler && npm install && npm run strings:pull`); Testimate's procedure is
undocumented. See [CLAUDE.md](../CLAUDE.md#internationalization). The two are coupled: Scrambler's
`src/strings/strings.json` is a deployed artifact, and its translations sat unshipped for two years
because both mechanisms were missing at once.
