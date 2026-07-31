# Setting up the `eepsmedia` deploy role

`.github/workflows/ci.yml` assumes `arn:aws:iam::612297603577:role/eepsmedia` via GitHub OIDC.
**That role does not exist yet** — it must be created before any deploy can run. Everything else in
the workflow (the `check` job) works without it.

## Why not just run the org's standard script

[`concord-consortium/starter-projects`](https://github.com/concord-consortium/starter-projects)
provides `scripts/create-deploy-role.sh <repo-name>`, which is how `story-builder`'s role was
created. It does three things: creates the role with a GitHub OIDC trust policy, tags it
`RepoName=<repo>`, and attaches the shared managed policy `S3-deploy-by-role-tag`.

**The third step is wrong for this repo.** That managed policy grants access only to:

```
arn:aws:s3:::models-resources/${aws:PrincipalTag/RepoName}/*
```

These plugins do not live in `models-resources` and never have — verified, there is nothing
eepsmedia-related in that bucket. They deploy only to `codap-resources`. Attaching the managed
policy would grant write access to a `models-resources/eepsmedia/*` path that will never be used.

`story-builder` needed both because it genuinely deploys to both buckets (its `ci.yml` syncs to
`models-resources` *and* `codap-resources`, plus a per-version archive). It covers `codap-resources`
with an extra inline policy named `story-builder-supplemental`. We need only the `codap-resources`
half.

So: use the same trust policy the script generates, but attach a single `codap-resources` policy
instead of the managed one.

## Create the role

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

The role name **must** be `eepsmedia` — `ci.yml` hard-codes that ARN. The trust policy is
byte-equivalent to what the standard script generates for this repo name, so the role remains
recognisable to anyone familiar with the org convention.

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

Expect the ARN `arn:aws:iam::612297603577:role/eepsmedia`, a `sub` condition of
`repo:concord-consortium/eepsmedia:*`, the inline policy `eepsmedia-codap-resources`, and **no**
attached managed policies.

The real test is the first tagged deploy — see the first-deploy procedure in
`docs/superpowers/specs/2026-07-31-eepsmedia-deployment-design.md`.
