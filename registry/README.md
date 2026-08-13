# Module registry

`modules.json` in this folder is the catalog of community modules that have been reviewed and are vouched for. The app reads it from the `main` branch of the configured update repo (`settings.update.repo`, default `FireStarsSoft/Bored-Manager`):

```
https://raw.githubusercontent.com/<repo>/main/registry/modules.json
```

and caches the result in `data/registry-cache.json` for 24 hours (Settings -> Modules -> Catalog can force a refetch). See `server/services/registry.ts`.

## Schema

```jsonc
{
  "registryVersion": 1,
  "modules": [
    {
      "id": "hello",
      "name": "Hello",
      "description": "Uptime demo module",
      "author": "Bored Manager",
      "homepage": "https://github.com/FireStarsSoft/Bored-Manager",
      "version": "2.0.0",
      "minAppVersion": "0.1.0",
      "download": "https://github.com/FireStarsSoft/Bored-Manager/releases/download/<tag>/hello-2.0.0.zip",
      "sha256": "<hex sha256 of that exact .zip file>",
      "verifiedAt": "2026-08-13"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Must match the module's own `module.json` id. |
| `name`, `description`, `author` | Shown in the catalog. |
| `homepage` | Optional; opened in a new tab from the catalog. |
| `version` | The version that was reviewed - not necessarily the module's latest. |
| `minAppVersion` | Optional, same meaning as in `module.json`. |
| `download` | Direct link to the reviewed archive - a GitHub release asset. |
| `sha256` | hex SHA-256 of that exact zip file (e.g. `sha256sum <file>.zip`). This is what "verified" is checked against - a listed `id` with a different hash is treated the same as not being listed at all. |
| `verifiedAt` | `YYYY-MM-DD` the entry was last reviewed. |

A file that fails to parse, or whose `registryVersion` this app does not speak, is treated as an empty catalog rather than an error - nothing here can make an install fail, only leave it unverified.

## How the app uses this file

- Every module install or update - from the catalog, a URL, or an uploaded file - hashes the archive and looks up its manifest `id` here. A match on both `id` and `sha256` adds a `catalog-verified` check; anything else adds a `unverified-source` warning the user has to confirm past.
- This is a trust signal, not a security boundary: a module still runs with the same access to the target machine as the app itself. Sha256 only proves the bytes match what was reviewed, nothing is code-signed.

## Adding an entry

Open a pull request adding one object to `modules` above, with `download` pointing at a GitHub release asset and `sha256` computed from that exact file. A maintainer reviews the module's code before merging.
