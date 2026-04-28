# Phase 7D Agent API Boundary

Phase 7D keeps the internal agent workflow boundary in-process.

The worker calls `AgentWorkflowService`, which mirrors the future workflow-first
HTTP contract:

- claim;
- lifecycle events;
- analysis and decomposition decisions;
- clarification questions and human answers;
- validation runs;
- merge request publication;
- lease heartbeat and release.

No externally reachable `/api/agent/...` HTTP routes are enabled in this phase.
Because there is no exposed agent HTTP surface, there is no anonymous claim,
heartbeat, release, validation, or publish API to secure yet. Service-token HTTP
authentication is intentionally left for the first phase that exposes these
operations over HTTP.
