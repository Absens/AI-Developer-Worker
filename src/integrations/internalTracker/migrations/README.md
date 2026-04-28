# Internal Tracker Migrations

Phase 7A adds the core PostgreSQL schema skeleton. Phase 7B adds the atomic
queue tables for `task_leases` and persisted `idempotency_keys`. Later Phase 7
migrations add worker runtime records, Yandex bridge state, AI proposals, and
Phase 7H operational hardening indexes/cleanup metadata.

Apply migrations with:

```bash
npm run tracker:migrate
```

The runner stores applied versions in `internal_tracker_schema_migrations`.
Production preflight fails when this metadata is missing, any migration is
pending, required indexes are absent, or transactional `FOR UPDATE SKIP LOCKED`
claim support is unavailable.

Stale queue recovery is implemented by treating expired unreleased leases as
inactive and eagerly marking them released inside the PostgreSQL claim
transaction before new leases are inserted. The partial unique indexes therefore
protect only active lease rows.
