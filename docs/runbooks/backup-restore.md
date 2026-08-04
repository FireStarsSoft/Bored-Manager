# Backup and restore runbook

> Status: design runbook. Commands that mutate Bored Manager state are intentionally deferred
> until the matching `bmctl backup`/`restore` implementation and release are available.

## Backup objective

A recoverable set contains an online SQLite backup, configuration, schema and application version,
release metadata, encrypted CA export, and a checksum manifest. Copying the live SQLite main file
without its WAL coordination is not a backup.

## Before backup

1. Confirm `sudo bmctl health` and `bmctl version`.
2. Confirm the destination is outside `/var/lib/bored-manager` and has enough space.
3. Check that no update or migration is active.
4. Choose a new high-entropy CA-export passphrase. Supply it through the interactive prompt or a
   protected file descriptor supported by the release, never a command-line option/environment.
5. Record current package version with `dpkg-query -W bored-manager`.

## Create and verify

Use the exact backup command in the installed release's `bmctl backup --help`. The command must use
SQLite's online backup API, write into a new staging directory, fsync, create hashes, then rename
the completed set atomically. Verification must independently check checksums, SQLite integrity,
schema version, metadata completeness, and decryptability of the CA export without exposing keys.

Copy the verified set to offline or independently administered storage. Default retention is seven
daily sets, but never expire the only backup known to match the currently installed package.

## Restore decision

- If only configuration is invalid, restore a reviewed configuration copy; do not replace the DB.
- If SQLite is corrupt and CA state is healthy, restore the newest compatible verified set.
- If the CA is missing, recover the encrypted CA export. If impossible, conduct a CA-reset incident
  and re-enroll agents; do not fabricate continuity.
- If an update migration failed, use the automatic N-1 package and its matching pre-update backup.

## Restore procedure

1. Isolate public/LAN listeners while retaining local console access.
2. Capture diagnostics and make a read-only copy of damaged state for investigation.
3. Verify the backup on a separate path and confirm version/migration compatibility.
4. Stop `bored-managerd.service` and confirm it has no child processes.
5. Invoke the released `bmctl restore` recovery mode; never copy files over a running database.
6. Start the manager locally, then verify SQLite integrity, schema version, CA chain, admin access,
   agent inventory, durable jobs, network reservations, audit history, and artifact metadata.
7. Re-enable the intended listener. Watch reconnect and service-state freshness before declaring
   recovery complete.
8. Preserve timestamps, backup identifier, commands, result, and incident linkage in the audit log.

## Acceptance

Restore is successful only if `sudo bmctl health` is healthy, package and application versions agree,
agents reconnect without new identities, ownership inventory is intact, no migration reruns
unexpectedly, and a new post-restore online backup verifies.
