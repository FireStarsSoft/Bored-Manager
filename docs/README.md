# Documentation

| File | Read it when you want to |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | understand how the app is put together: the Express/ws server, the RPC, multi-client, polling, modules, history |
| [DEVELOPMENT.md](DEVELOPMENT.md) | set the project up, find where a change belongs, add a block type |
| [MODULES.md](MODULES.md) | know how the app manages modules: lifecycle, catalog, integrity, what an update does to them |
| [MODULE-RULESET.md](MODULE-RULESET.md) | **write a module** — the v2 manifest, `main/index.ts`, every UI block, and every installer check |
| [DEPLOYMENT.md](DEPLOYMENT.md) | package a release, install it, or understand the update transaction |
| [MAINTENANCE.md](MAINTENANCE.md) | release a version: the checklist, schema versions, reviewing a community module |
| [CHANGELOGS.MD](CHANGELOGS.MD) | see what changed per app version |
| [examples/hello/](examples/hello/) | copy a complete, working v2 module as a starting point |

The user-facing overview — features, requirements, installation, troubleshooting — is in [../README.MD](../README.MD).

Each module also documents itself, in `modules/<id>/README.md` and `modules/<id>/CHANGELOG.md`. Those are readable from inside the app: Settings → Modules → Details.
