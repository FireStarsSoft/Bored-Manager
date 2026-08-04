# Security policy

## Supported versions

Bored Manager has not published a supported release. The `main` branch and development artifacts
receive no security support and must not be exposed to untrusted networks. This table will be
updated when the first signed release is available.

| Version | Supported |
| --- | --- |
| Development snapshots | No |
| Stable release | Not yet available |

## Reporting a vulnerability

Do not open a public issue, discussion, pull request, or chat transcript for a suspected
vulnerability. Use GitHub's **Security → Report a vulnerability** private reporting form for
`FireStarsSoft/Bored-Manager`. If private reporting is unavailable, contact the repository owner
through the private contact method shown on the FireStarsSoft GitHub organization profile and ask
for a secure reporting channel without including exploit details in the first message.

Include, when safe:

- affected version, commit, component, and deployment topology;
- exact prerequisites and minimal reproduction steps;
- security impact and whether exploitation was observed;
- logs with credentials, tokens, cookies, private keys, terminal secrets, and addresses redacted;
- a suggested mitigation or patch, if available.

Do not access data that is not yours, persist on a system, degrade availability, or publish a
proof of concept before a coordinated fix. We will acknowledge a valid private report as soon as
maintainer capacity allows. Response and disclosure timelines will be agreed with the reporter;
there is no guaranteed SLA before the project reaches a supported release.

## Security boundaries

- Access to a Docker Engine socket is root-equivalent.
- `bored-agentd` runs as root inside managed containers.
- `bored-managerd` runs unprivileged; a narrowly scoped root helper owns package updates.
- Web TLS, agent mTLS, release signing, and SSH host-key trust are independent trust domains.
- Release artifacts are accepted only after offline Ed25519 signature, hash, size, and Debian
  metadata verification.
- Package removal is non-destructive. Docker-resource purge requires explicit group selection,
  typed confirmation, and agreement between database ownership and Docker labels.

Never submit real CA material, SSH private keys, agent keys, enrollment challenges, authentication
cookies, backup passphrases, or unredacted support bundles.

## Release-key incident

If a release signing key is suspected to be compromised, maintainers must stop promotion, preserve
evidence, publish an advisory through a previously trusted channel, revoke the affected key in the
release policy, and require an explicit trust-root transition. A repository commit alone cannot
silently replace the embedded release key.
