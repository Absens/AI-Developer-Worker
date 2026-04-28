# Internal Tracker Migrations

Phase 7A only adds the core PostgreSQL schema skeleton. It is not wired into
runtime startup, and the in-memory adapter remains test/local-only.

The following production tables are intentionally staged for later Phase 7
work: `task_leases`, idempotency records, `agent_runs`, `quality_gate_runs`,
GitLab merge/review metadata, review-fix state, `sync_cursors`, raw external
snapshots, task proposals, proposal evidence, retention metadata, audit
redaction records, auth/service-token records, and operational metrics tables.
