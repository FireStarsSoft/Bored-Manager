# GitHub repository governance runbook

Repository settings are security controls and are not fully represented by tracked files. Apply
and audit this runbook with an organization/repository administrator after CI exists.

## Merge policy

- Default branch is `main`.
- Allow squash merge only; delete head branches after merge.
- Disable force-push and deletion for `main` and tags matching `v*`.
- Require a pull request, one approving review, code-owner review, conversation resolution, and
  approval dismissal after new commits.
- Require branches to be current before merge and require signed commits when contributor tooling
  is ready.
- Do not grant bypass to GitHub Actions. Keep an audited emergency owner path at the organization
  layer rather than a routine repository bypass.

Required checks should include the CI Go, Web, Scripts/Debian, Contract, Documentation, and CodeQL
jobs. Add a check only after it has completed successfully once on `main`; otherwise GitHub cannot
resolve the context reliably.

## Actions policy

- Default `GITHUB_TOKEN` permission is read-only; do not allow workflows to create/approve pull
  requests.
- Allow GitHub-authored actions and explicitly reviewed pinned third-party actions only.
- Every `uses:` reference is a 40-character commit SHA with a version comment.
- Release jobs alone receive explicit `contents: write`, `id-token: write`, attestation, and
  artifact-metadata permissions.
- Configure the `release` environment with required reviewer approval and no self-approval.
- Never run a self-hosted/lab runner job for a pull request from a fork. Lab workflows accept only
  protected-branch commits or manually selected protected tags.

## Security features

Enable Dependabot alerts/updates, dependency graph, secret scanning, push protection, private
vulnerability reporting, and CodeQL default/setup status. Enable automatic token revocation where
the organization supports it. Review bypass events and dismissed alerts rather than treating
feature enablement as completion.

## Ruleset verification

After changes, use `gh api` or the GitHub settings UI to capture:

- repository merge/default permission settings;
- active repository rulesets and their bypass actors;
- branch/tag protection resolution for `main` and a test `v0.0.0-governance` ref pattern;
- Actions allowed-action and workflow-permission settings;
- required `release` environment reviewers;
- security-and-analysis feature state.

Store the redacted audit result with the release evidence. Re-audit quarterly and after owner,
organization, Actions-policy, or GitHub-plan changes.
