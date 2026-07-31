# Setting up the `eepsmedia` deploy role

`.github/workflows/ci.yml` assumes `arn:aws:iam::612297603577:role/eepsmedia` via GitHub OIDC.

**The role exists** — created 2026-07-31 and confirmed working by the first deploy (`simmer-2026a`)
the same day. This document records how it was built and, more importantly, the two ways the
obvious approach gets it wrong.

> ⚠️ **Creating a deploy role for another Concord repo? Read
> [The immutable subject claim](#the-immutable-subject-claim) first.** The org's standard script
> produces a role that *cannot be assumed at all* by any repository created or transferred after
> **2026-07-15** — see GitHub's changelog,
> [Immutable subject claims for GitHub Actions OIDC tokens](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)
> and the [OpenID Connect reference](https://docs.github.com/actions/reference/openid-connect-reference).

## Why not just run the org's standard script

[`concord-consortium/starter-projects`](https://github.com/concord-consortium/starter-projects)
provides `scripts/create-deploy-role.sh <repo-name>`, which is how `story-builder`'s role was
created. It does three things: creates the role with a GitHub OIDC trust policy, tags it
`RepoName=<repo>`, and attaches the shared managed policy `S3-deploy-by-role-tag`.

**Two of those three are wrong for this repo** — one because of the bucket, one because of the
subject claim. Both had to be corrected before a deploy would work.

### Wrong #1 — the managed policy is for the wrong bucket

That managed policy grants access only to:

```
arn:aws:s3:::models-resources/${aws:PrincipalTag/RepoName}/*
```

These plugins do not live in `models-resources` and never have — verified, there is nothing
eepsmedia-related in that bucket. They deploy only to `codap-resources`. Attaching the managed
policy would grant write access to a `models-resources/eepsmedia/*` path that will never be used.

`story-builder` needed both because it genuinely deploys to both buckets (its `ci.yml` syncs to
`models-resources` *and* `codap-resources`, plus a per-version archive). It covers `codap-resources`
with an extra inline policy named `story-builder-supplemental`. We need only the `codap-resources`
half, so this role gets a single inline policy instead of the managed one.

### Wrong #2 — the trust policy's subject claim

The script hardcodes `repo:${GITHUB_ORG}/${REPO_NAME}:*`, which is the **legacy** subject format.
This repo is new enough to use the immutable format, so a role built that way cannot be assumed at
all. Details below.

> The first version of this role was created by copying `story-builder`'s trust policy verbatim —
> verified byte-identical, which felt like a virtue and was in fact the bug. `story-builder` is a
> 2020 repo on the legacy format. **Matching a working precedent is only safe when the precedent is
> subject to the same rules.**

## The immutable subject claim

**This is the failure that is hardest to diagnose, because the error message points somewhere else.**

GitHub changed the default OIDC subject claim format. Per
[the changelog](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/),
**every repository created or transferred after 2026-07-15** embeds the numeric owner and repo IDs
in its `sub` claim, delimited by `@`. Older repositories keep the legacy name-only format unless
they opt in.

`eepsmedia` was created 2026-07-31, so its tokens carry:

```
repo:concord-consortium@319219/eepsmedia@1318683401:ref:refs/tags/simmer-2026a
```

not the legacy:

```
repo:concord-consortium/eepsmedia:ref:refs/tags/simmer-2026a
```

A trust policy matching `repo:concord-consortium/eepsmedia:*` therefore **never matches**, and the
assume-role call fails with:

```
Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

That message reads like a *permissions* problem, so the instinct is to widen the policy. That is the
wrong fix — the permissions were always fine; the subject string simply did not match.

**Diagnose it by asking GitHub what it will actually send:**

```bash
gh api /repos/concord-consortium/<repo>/actions/oidc/customization/sub
```

The `sub_claim_prefix` field is the literal prefix GitHub puts in the token. Compare it against the
`StringLike` value in the role's trust policy — if they differ, that is the bug. For reference:

| Repo | Created | `sub_claim_prefix` |
|---|---|---|
| `eepsmedia` | 2026-07-31 | `repo:concord-consortium@319219/eepsmedia@1318683401` |
| `story-builder` | 2020-11-18 | `repo:concord-consortium/story-builder` |

**The committed trust policy accepts both forms**, so it keeps working if GitHub's defaults shift
again or the repo is ever opted back. Both are precisely scoped to this one repository; the
ID-based form is arguably the stronger of the two, since IDs survive renames and cannot be
resurrected by re-registering a name.

**This affects the whole org.** `create-deploy-role.sh` in
[`concord-consortium/starter-projects`](https://github.com/concord-consortium/starter-projects)
hardcodes `repo:${GITHUB_ORG}/${REPO_NAME}:*`, so it will mint an unusable role for every new repo
from here on. Worth fixing upstream.

## Create the role

These are the commands that produced the working role. To recreate it from scratch, or to adapt for
another repo, **first regenerate the `sub` values** for that repo from its
`sub_claim_prefix` (see above) — do not copy this one's.

```bash
aws iam create-role \
  --role-name eepsmedia \
  --assume-role-policy-document file://docs/iam/eepsmedia-trust-policy.json \
  --tags Key=RepoName,Value=eepsmedia \
  --query 'Role.Arn' --output text

aws iam put-role-policy \
  --role-name eepsmedia \
  --policy-name eepsmedia-codap-resources \
  --policy-document file://docs/iam/eepsmedia-codap-resources-policy.json
```

The role name **must** be `eepsmedia` — `ci.yml` hard-codes that ARN. Apart from the subject-claim
values, the role follows the org convention closely enough to stay recognisable: same OIDC provider,
same `aud` condition, same `RepoName` tag.

If you need to correct the trust policy on an existing role, `update-assume-role-policy` replaces it
in place — no need to delete and recreate:

```bash
aws iam update-assume-role-policy --role-name eepsmedia \
  --policy-document file://docs/iam/eepsmedia-trust-policy.json
```

The `RepoName` tag is retained for consistency even though nothing consumes it here; it only carries
meaning for the `models-resources` managed policy we are deliberately not attaching.

## Why the S3 policy is shaped this way

- **`s3:ListBucket` with a prefix condition is required by `--delete`.** The sync must enumerate the
  destination to discover orphans; without it the deploy fails.
- **One prefix covers both syncs.** The workflow writes to `plugins/eepsmedia/plugins/<name>/` and
  `plugins/eepsmedia/common/`, both under `plugins/eepsmedia/*`.
- **No `s3:GetObject` is needed.** `aws s3 sync` from local to S3 compares against the bucket
  listing and never downloads. `story-builder`'s equivalent policy omits it too.
- **No `s3:PutObjectAcl`.** The workflow deliberately passes no `--acl`; the bucket has Object
  Ownership enforced. If the first deploy fails on an ACL error, that assumption was wrong — see the
  first-deploy procedure in the design doc.

## Verify

```bash
aws iam get-role --role-name eepsmedia \
  --query 'Role.[Arn,AssumeRolePolicyDocument.Statement[0].Condition.StringLike]'
aws iam list-role-policies --role-name eepsmedia
aws iam list-attached-role-policies --role-name eepsmedia
```

Expect the ARN `arn:aws:iam::612297603577:role/eepsmedia`, the inline policy
`eepsmedia-codap-resources`, **no** attached managed policies, and a `sub` condition listing **both**
forms:

```json
[
  "repo:concord-consortium@319219/eepsmedia@1318683401:*",
  "repo:concord-consortium/eepsmedia:*"
]
```

A `sub` condition containing only the second line is the broken configuration described above.

**Confirmed working.** The `simmer-2026a` deploy on 2026-07-31 assumed the role, synced both trees,
and served `2026a` from production. That run also settled two open questions:

- **The `codap-resources`-only policy is sufficient** — the sync completed with no `AccessDenied`,
  so nothing from `models-resources` was needed.
- **Omitting `--acl` is correct** — objects are publicly readable without it, confirming the bucket
  has Object Ownership enforced.
