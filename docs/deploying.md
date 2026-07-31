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

## Status

**The pipeline is live.** The IAM role exists and the first deploy — `simmer-2026a`, 2026-07-31 —
ran end to end: tag validated, role assumed, both trees synced, CloudFront flushed, and
`codap.concord.org` and `codap3.concord.org` both serving `2026a`.

Settled by that run:

- **The `codap-resources`-only IAM policy is sufficient** — no `AccessDenied`.
- **Omitting `--acl` is correct** — objects are publicly readable, confirming Object Ownership is
  enforced on the bucket.
- **`--delete` behaved exactly as predicted** — 27 deletions, all the removed vendored directory.

### The one-time CloudFront flush is done

Objects on S3 previously carried no `Cache-Control` at all, leaving them on heuristic freshness
(roughly 10% of age since `Last-Modified` — weeks, for 2024-era files). All three distributions were
invalidated at the stripped path on 2026-07-31, and both app hosts returned
`x-cache: Miss from cloudfront` with the new `last-modified`. Anything the deploy touches now carries
`no-cache`.

### Still open

**Verify the no-invalidation claim.** On the *next* deploy, skip the invalidation and confirm the
edge still serves the new content. This is load-bearing — it is the entire reason the workflow needs
no CloudFront permissions. If it does not hold, add `cloudfront:CreateInvalidation` on all three
distributions to the role and invalidate on every deploy.

### The other three plugins are already current

Content-compared against S3 on 2026-07-31: `Choosy` and `testimate` are byte-identical, and
`scrambler` differs only in `package.json` — a dev-only file the plugin never loads. They need a tag
only when they next actually change.

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
