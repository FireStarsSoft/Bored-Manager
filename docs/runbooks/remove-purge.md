# Remove and purge runbook

## Non-destructive remove

Package removal stops and disables package units and removes dpkg-owned executables/units. It
preserves manager configuration, SQLite, CA, backups, cached artifacts, agent identity, monitored
services, and all Docker objects. Capture `dpkg-query`, systemd, listener, and ownership inventory
before removal.

Use the normal package manager only after reading the release-specific notes. Never add maintainer
scripts that delete `/var/lib/bored-manager`, `/var/lib/bored-manager-agent`, or Docker objects on
`remove`.

## Explicit purge workflow

Purge is performed through the released `bmctl purge` wizard before final package purging:

1. Export a timestamped inventory/ownership manifest and verify its hash.
2. Select Keep/Delete independently for manager state/CA, backups, cache/images, agent identity,
   containers, networks/reservations, volumes, and DHCP plugin.
3. Show exact eligible object IDs. Names or prefixes are insufficient.
4. Require database ownership and `io.firestarssoft.bored-manager.*` labels to agree.
5. Exclude ambiguous, missing-label, externally owned, or user-created resources.
6. Display dependencies and block deletion that would leave a selected kept resource invalid.
7. Require the exact typed confirmation generated for this purge plan.
8. Execute from leaves to roots, record every result, and remain retry-safe.
9. Remove package-owned components last.

If ownership evidence conflicts, stop and investigate. Never resolve ambiguity by broadening a
selector.

## Residue verification

For each selected group, verify systemd units, process trees, listeners, Unix sockets, lock/staging
files, configuration/state/cache paths, users/groups, cron/timers, and exact Docker IDs. Resources
selected Keep must still work. Attach the pre-purge manifest and final verification report to the
audit record.

Do not use recursive filesystem deletion as a substitute for this runbook.
