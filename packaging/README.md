# Debian packaging

`scripts/build-deb.sh` assembles two root-owned Debian packages with `dpkg-deb`:

- `bored-manager`: `bored-managerd`, `bmctl`, the update helper, systemd units, and desktop entry.
- `bored-manager-agent`: `bored-agentd`, its systemd unit, and the locked `bored-shell` account.

Maintainer scripts create only package users/directories and reload systemd. They deliberately do
not start services, delete state, install Docker, change a firewall, or delete Docker resources.
The verified installer controls enable/start and local-Docker opt-in.

The manager unit runs unprivileged with a strict filesystem sandbox. The agent is root because it
must operate systemd/service files inside a managed container; it still receives kernel, clock,
namespace, and temporary-directory hardening that does not prevent typed service actions. The
update helper is network-denied and must enforce its own Unix-peer and package verification policy.

The manager package includes the already-built SPA at `/usr/share/bored-manager/web`; package
assembly fails if `web/dist/index.html` is absent.

Build output is placed in `dist/` by default. Package filenames retain release SemVer. Inside the
Debian control metadata, pre-release SemVer `-alpha.N` is translated to Debian `~alpha.N` so it
sorts before the corresponding stable release.

Development packages contain a non-key placeholder at
`/usr/share/bored-manager/release-signing.pub`; the helper must reject it. A release build must pass
`--release-public-key packaging/release/release-public-key.pem`. Manager-downloaded update payloads
are staged only below `/var/cache/bored-manager/staged`.
