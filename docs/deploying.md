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
outright. Confirmed by the first deploy: objects are publicly readable without it — see
[Status](#status).

## CloudFront

**Deploys need no invalidation. Not the first one for a plugin, not any of them.** CloudFront
honours `Cache-Control: no-cache` by revalidating with the origin, and every file under
`plugins/eepsmedia/` already carries that header. This is why the deploy role needs no CloudFront
permissions at all, and why the workflow has no invalidation step.

> Earlier versions of this document described a one-time invalidation needed the first time each
> plugin deployed. That is **done and no longer applies** — it was only ever required to migrate
> objects off the header-less state they were left in by the old manual copies. All four plugins
> were migrated on 2026-07-31. There is nothing left to remember.

The commands below are kept for the rare case of needing a manual flush — a bad upload, or an
object that somehow lands without the right header. **The path is not the one you would expect**:

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

## Status

**The pipeline is live, and all four plugins have been deployed through it.** On 2026-07-31 each was
tagged at its then-current version and deployed end to end:

| Tag | Notes |
|---|---|
| `simmer-2026a` | First deploy. Version bump + vendored-code removal (CODAP-1460). |
| `Choosy-2021m` | Exercised the capitalized directory on a case-sensitive Linux runner. |
| `scrambler-1.7` | Also brought S3's stale dev-only `package.json` into line. |
| `testimate-2026e` | No content change; header fix only. |

The last three were tagged at their existing versions deliberately — not to mark a change, but to
put every plugin's files under `Cache-Control: no-cache` (see below) and to prove each plugin's
deploy path works.

Settled by these runs:

- **The `codap-resources`-only IAM policy is sufficient** — no `AccessDenied`.
- **Omitting `--acl` is correct** — objects are publicly readable, confirming Object Ownership is
  enforced on the bucket.
- **`--delete` behaved exactly as predicted** — 27 deletions, all the removed vendored directory.

### The invalidation debt is cleared — permanently

Objects on S3 previously carried no `Cache-Control` at all, leaving them on heuristic freshness
(roughly 10% of age since `Last-Modified` — weeks, for 2024-era files). **Every file under
`plugins/eepsmedia/` now carries `no-cache`**, and all three distributions were invalidated at the
stripped path after the last deploy. Both app hosts serve `cache-control: no-cache` for all four
plugins.

**No future deploy needs an invalidation.** That was previously an assumption; it has now been
measured — see below.

### Verified: `no-cache` is honored, so deploys need no invalidation

This was the load-bearing assumption behind the workflow having no CloudFront permissions at all.
Measured directly against `codap3.concord.org`:

```
req at t+0s:  x-cache: RefreshHit from cloudfront
req at t+2s:  x-cache: RefreshHit from cloudfront
req at t+4s:  x-cache: RefreshHit from cloudfront
```

`RefreshHit` means CloudFront revalidated with the origin before serving. It does that on **every**
request, so a deploy is picked up immediately.

**One wrinkle worth knowing**, because it looks alarming: requests issued within the same second
return a plain `Hit from cloudfront` — served from cache with no revalidation. That is the cache
policy's `MinTTL: 1` (policy `S3-CORS`: MinTTL 1, DefaultTTL 86400, MaxTTL 31536000), which forces a
minimum 1-second cache regardless of origin headers. A one-second staleness window is irrelevant to
deploys. If you test this by firing several `curl`s in a row you will see `Hit` and may wrongly
conclude `no-cache` is being ignored — **space the requests more than a second apart.**

> Note a re-deploy of *unchanged* content cannot test this: identical bytes produce an identical
> ETag, so revalidation returns `304` and the edge serves its cached copy either way. Observing
> `RefreshHit` is the meaningful signal, not a changed `last-modified`.

> An earlier version of this document claimed Scrambler had "~2 years of stranded translations" and
> Testimate an undeployed bugfix. **Both were wrong.** That came from comparing `index.html` upload
> dates on S3 against git-log dates — but `index.html` does not change when `src/` or `strings/` do,
> so its timestamp says nothing about whether the rest of the plugin is current. Scrambler's
> `strings.json` had in fact been hand-synced on 2025-12-30. **Compare content, not timestamps.**

## Not covered here

**POEditor synchronization.** Scrambler's pull still works standalone
(`cd plugins/scrambler && npm install && npm run strings:pull`); Testimate's procedure is
undocumented. See [CLAUDE.md](../CLAUDE.md#internationalization). The two are coupled: Scrambler's
`src/strings/strings.json` is a deployed artifact, so pulling strings is only half the job — they
do not reach users until Scrambler is tagged.
