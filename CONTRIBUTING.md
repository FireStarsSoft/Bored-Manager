# Contributing to Bored Manager

Thank you for helping build Bored Manager. The project is security-sensitive infrastructure, so
changes must be reviewable, reproducible, and conservative about privileges and data deletion.

## Development environment

Use Ubuntu 24.04 amd64, directly or under WSL2. The pinned toolchains are Go 1.26.5, Node 24.18.x,
TypeScript 6.0.x, and React 19.2.x. Contract generation additionally pins ogen 1.23.0, Buf 1.72.0,
and `@hey-api/openapi-ts` 0.99.0. Use npm with the committed lockfile.

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl git make shellcheck dpkg-dev
git clone https://github.com/FireStarsSoft/Bored-Manager.git
cd Bored-Manager
make test
make build
```

Do not develop release packaging on Kali, alter generated files by hand, or commit local secrets,
keys, databases, coverage output, binaries, package artifacts, or support bundles.

## Change workflow

1. Open or reference an issue that states user impact and acceptance criteria.
2. Create a focused branch from current `main`.
3. For public API/protocol changes, edit OpenAPI/Protobuf first and run compatibility checks.
4. For database changes, add a forward migration, backup/restore coverage, and downgrade behavior.
5. For a privileged operation, update the threat model and add an ADR.
6. Add tests at the lowest useful level and update `README.MD` for operator-visible behavior.
7. Run the local checks, then open a pull request. Do not force-push after review begins unless a
   reviewer asks; if unavoidable, announce it and preserve review context.

```bash
make generate
make lint
make test
make build
bash scripts/check-docs.sh
```

## Pull-request requirements

- Keep generated code and its source contract in the same pull request.
- Preserve manager N compatibility with agent N and N-1.
- Use bounded queues, timeouts, cancellation, and backpressure for network/background work.
- Never weaken signature, SSH host-key, mTLS, CSRF, WebSocket Origin, or destructive-confirmation
  checks to make a test pass.
- Never add `--privileged`, `CAP_SYS_ADMIN`, host namespaces, unconfined AppArmor/seccomp, Docker
  socket mode `0666`, or unauthenticated Docker TCP as a fallback.
- Package removal must not delete user data or Docker resources.
- Include release notes when behavior, configuration, migration, compatibility, or recovery changes.

The repository uses squash merges. Commit subjects should be imperative and specific, for example
`agent: bound enrollment retry queue`. Sign commits when your environment supports it.
Repository-owner controls are maintained through the
[GitHub governance runbook](docs/runbooks/github-governance.md).

## Documentation

`README.MD` is the canonical English operator guide. Every shell block must parse with Bash and
must not contain a live credential or private network value. Commands for unreleased features must
be explicitly marked planned/unavailable. Links and documented CLI commands are checked in CI.

## Testing expectations

- Unit tests cover state transitions and failure paths.
- Integration tests use real SQLite and manager/agent transports where relevant.
- Packaging changes test install, repeat install, upgrade, rollback, remove, and residue.
- Security-sensitive changes include negative tests.
- Scale or networking claims need a reproducible lab report; simulations do not replace required
  real-container gates.

## Dependencies

Prefer the standard library and existing dependencies. Explain any new dependency's purpose,
maintenance health, license, privilege/network behavior, and effect on reproducible builds. Pin
GitHub Actions by full commit SHA and package dependencies through lockfiles.

## Reporting security issues

Do not use a public pull request for an undisclosed vulnerability. Follow [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under Apache-2.0.
