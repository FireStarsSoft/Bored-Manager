# Troubleshooting and support runbook

## Triage order

1. Establish user impact, start time, recent update/config/provision action, and affected scope.
2. Record `bmctl version`, package version, system time, disk/inode space, and service state.
3. Capture manager and relevant agent journals for a bounded time window.
4. Check listeners/routes/TLS before changing credentials or identity.
5. Check durable job/lease state before retrying an action.
6. Preserve failed release assets, update markers, SQLite/WAL files, and ownership evidence.
7. Apply one reversible correction, then verify freshness and cleanup.

## Safe collection

```bash
bmctl version
sudo bmctl health
sudo bmctl diagnostics
dpkg-query -W bored-manager bored-manager-agent 2>/dev/null || true
sudo systemctl status bored-managerd.service --no-pager
sudo journalctl -u bored-managerd.service --since "1 hour ago" --no-pager
df -h /var/lib/bored-manager /var/cache/bored-manager
df -i /var/lib/bored-manager /var/cache/bored-manager
ss -ltn
```

Generate a support bundle only with the released diagnostics command. Before sharing, inspect it
for private keys, cookies, authorization headers, enrollment challenges, SSH credentials, CA
export material, terminal secrets, internal hostnames/addresses, and user service output.

## Prohibited shortcuts

- Do not delete dpkg lock files, SQLite `-wal`/`-shm`, agent identity, or update markers.
- Do not use `chmod 666` on a Docker socket or expose port 2375.
- Do not accept a changed SSH host key without out-of-band verification.
- Do not skip release signatures/hashes or install an unsigned draft.
- Do not edit SQLite directly to clear a job, alert, migration, or ownership row.
- Do not kill only the terminal shell; verify the PTY process group and descendants are gone.
- Do not run purge selectors against names, prefixes, globs, or labels alone.

## Escalation evidence

Provide the minimal reproduction, timestamp/timezone, versions, topology, redacted diagnostics,
expected/actual state, and whether retry/restart/rollback changed the symptom. Security-sensitive
evidence follows `SECURITY.md`, not a public issue.
