# ADR 0003: Generate clients from versioned contracts

- Status: Accepted
- Date: 2026-08-04
- Decision owners: FireStarsSoft maintainers

## Context

The REST and agent protocols must remain reviewable before runtime implementations diverge. The
repository needs deterministic Go and TypeScript clients, committed generated output, and breaking
change detection. Generator/runtime versions must also remain compatible with Go 1.26.5, Node
24.18.x, and TypeScript 6.0.x.

## Decision

OpenAPI 3.0.3 is the canonical REST dialect for v1. Ogen 1.23.0 generates the Go client and
`@hey-api/openapi-ts` 0.99.0 generates the self-contained Fetch/TypeScript client. The npm tree
overrides `js-yaml` to the patched 4.3.0 release because the generator's transitive constraint
otherwise selects a vulnerable version. Protobuf uses Buf 1.72.0 with exact remote plugin versions
declared in `api/proto/buf.gen.yaml`.

`scripts/generate-contracts.sh` is the only supported generation entry point. Generated output is
committed. CI runs oasdiff 1.27.0 and `buf breaking` against the base revision, regenerates all
clients/bindings, and rejects any drift, including newly untracked output.

## Consequences

- Contract changes and their generated consumers remain in one pull request.
- OpenAPI 3.1-only keywords cannot be introduced until both pinned generators pass an explicit
  migration gate; vendor extensions may document invariants that 3.0 cannot express directly.
- Deleted Protobuf fields must be reserved and fail the Buf compatibility check otherwise.
- Runtime code may migrate from the current handwritten pre-alpha adapters to generated clients
  incrementally, but it may not define a competing public schema.
