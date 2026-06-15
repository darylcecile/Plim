---
'@plim/core': minor
---

Add a real-time collaboration layer (`Collaborator`) on top of the transaction ledger.

A fast, framework-agnostic collaboration layer in `@plim/core` that turns the
ledger primitives into drop-in multi-peer editing. The model is
server-authoritative optimistic OT (the shape ProseMirror's `collab` uses): an
authority owns the one canonical ordered log and broadcasts records already in
canonical position, so every peer's confirmed document is identical by
construction — convergence never depends on client-side rebase quality.

- **`Collaborator`** — wraps an editor (`CollabEditor`, satisfied structurally
  by the core editor handle) and a `Transport`. Local edits apply instantly and
  are held as `pending`; exactly one record is in flight at a time so every
  authority rebase is the simple single-record case. Confirmed batches ack the
  client's own record, rebase the rest of `pending` over concurrent remote ops
  (dropping any that can no longer be placed — canonical wins, deterministically),
  and rebuild the editor as `confirmedDoc + pending`. The local caret is always
  preserved or shifted to track remote inserts — never replaced by a remote
  selection, and never disturbed when the client's own edit is acked.
- **Presence / awareness** — `PresenceTracker` plus `setPresence` /
  `patchPresence` / `peers` share ephemeral cursor and status state on the same
  transport. Presence is never written to the ledger (throwaway and fast),
  lamport-guarded against stale updates, and TTL-pruned.
- **Transport & authority** — `createMemoryNetwork` provides an in-process hub
  (`InMemoryAuthority`) and loopback `Transport`s with optional (possibly
  dynamic) latency for demos and tests. `VersionVector` helpers
  (`versionVectorOf`, `recordsAfter`, `coversRecord`, `mergeVersionVectors`)
  summarize per-source progress, and the `CollabMessage` wire DSL is a small
  JSON-safe discriminated union.
- **Late join / reconnect** — `sync()` pulls every canonical record the client
  is missing and fast-forwards to the authority's head.
- **`seq`** — `LedgerRecord` gains an optional per-source `seq` counter that
  drives version vectors.

Convergence is proved by construction and locked in by a four-peer randomized
fuzz test; a benchmark suite guards author/integrate/rebase/presence throughput
against regressions. See the new `examples/collab-kitchen-sink` for three live
editors sharing one document — concurrent bursts, a latency slider, late-join
delta sync, and presence/version-vector inspectors.
