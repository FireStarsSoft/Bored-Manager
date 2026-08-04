# Architecture decision records

Architecture decision records (ADRs) capture decisions that are expensive, security-sensitive,
or difficult to reverse. Copy `0000-template.md`, assign the next four-digit number, and keep the
file after a decision is superseded. Never rewrite accepted history; link the replacement ADR.

An ADR is required for changes to trust roots, privileged boundaries, wire compatibility,
database/migration policy, destructive lifecycle behavior, systemd-container isolation, network
ownership, release signing, or the supported-platform matrix.

Statuses are `proposed`, `accepted`, `rejected`, `deprecated`, or `superseded by ADR-NNNN`.

## Records

- [ADR 0001: Release trust and package updates](0001-release-trust-and-package-updates.md)
- [ADR 0002: Feasibility gates block production](0002-feasibility-gates-block-production.md)
- [ADR 0003: Generate clients from versioned contracts](0003-generated-contract-clients.md)
