# Internal Tracker Migrations

Phase 7A adds the core PostgreSQL schema skeleton. Phase 7B adds the atomic
queue tables for `task_leases` and persisted `idempotency_keys`. The internal
tracker is still not wired into runtime startup; provider selection belongs to
Phase 7C, and the in-memory adapter remains test/local-only.

The following production tables are intentionally staged for later Phase 7
work: `agent_runs`, `quality_gate_runs`, GitLab merge/review metadata,
review-fix state, `sync_cursors`, raw external snapshots, task proposals,
proposal evidence, retention metadata, audit redaction records,
auth/service-token records, and operational metrics tables.

Stale queue recovery is implemented by treating expired unreleased leases as
inactive and eagerly marking them released inside the PostgreSQL claim
transaction before new leases are inserted. The partial unique indexes therefore
protect only active lease rows.
