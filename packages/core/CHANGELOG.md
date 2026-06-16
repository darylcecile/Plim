# @plim/core

## 0.1.3

### Patch Changes

- Patch bump to keep all @plim packages on the same version for a synchronized release.

## 0.1.2

### Patch Changes

- d733374: Add `invertOps` / `invertOp` (and the `findBlockPathById` helper) for computing the op-based inverse of a transaction at dispatch time. `invertOps` walks a transaction's ops forward to capture the pre-op state of each op, then folds per-op inverses in reverse order so applying the result to the post-transaction state reproduces the original document; it returns `null` when any op is not faithfully invertible (the caller can then fall back to a snapshot restore). `HistoryEntry` gains optional `ops`, `inverse`, and `selectionBefore` fields to carry this data.

## 0.1.1

### Patch Changes

- 8016478: Move the transaction ledger and collaboration layers out of `@plim/core` into
  the new `@plim/ledger` and `@plim/collaboration` packages. `@plim/core` no
  longer re-exports those symbols — import `TransactionLedger`, `Collaborator`,
  `CollabHub`, and friends from their dedicated packages instead. No core runtime
  behaviour changed.

## 0.1.0

### Minor Changes

- 8b5568f: Add a real-time collaboration layer (`Collaborator`) on top of the transaction ledger.

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
  - **Transport & authority** — `CollabHub` is the transport-agnostic server half
    of the protocol (handshake, submit→linearize→broadcast, delta `sync`, presence
    relay); wrap any socket as a one-method `HubClient` and it linearizes every
    peer's edits into one canonical order. `createMemoryNetwork` provides an
    in-process hub (`InMemoryAuthority`) and loopback `Transport`s with optional
    (possibly dynamic) latency for demos and tests. `VersionVector` helpers
    (`versionVectorOf`, `recordsAfter`, `coversRecord`, `mergeVersionVectors`)
    summarize per-source progress, and the `CollabMessage` wire DSL is a small
    JSON-safe discriminated union.
  - **Late join / reconnect** — `sync()` pulls every canonical record the client
    is missing and fast-forwards to the authority's head.
  - **`seq`** — `LedgerRecord` gains an optional per-source `seq` counter that
    drives version vectors.

  Convergence is proved by construction and locked in by a four-peer randomized
  fuzz test; a benchmark suite guards author/integrate/rebase/presence throughput
  against regressions. See the new `examples/collab-kitchen-sink` for one shared
  document served over a real WebSocket by a tiny Hono + `CollabHub` backend — open
  it in two browser tabs to edit together live, with inline remote carets, a
  presence roster, a version-vector inspector, and offline-then-reconnect resync.

- 7e5e783: Add a transaction ledger / sync layer for bring-your-own CRDT or OT engines.

  New, framework-agnostic primitives in `@plim/core` that sit alongside the
  existing transaction, history, and snapshot APIs:

  - **`TransactionLedger`** — an ordered, append-only log of committed
    transactions. `record`/`attach` capture forward edits, `apply`/`applyRange`
    replay them as a pure fold, and `replay(editor)` reapplies them in a single
    `setState` (no history pollution). Ledgers stay sorted by a deterministic
    total order (`timestamp → lamport → source → id`) via binary-search insertion.
  - **`LedgerRecord` / `LedgerSnapshot`** — a self-contained, JSON-serializable
    intermediary type. Records deep-clone their ops/meta and carry an id-keyed
    `touches` set (the conflict surface resolved once against the base document),
    so merging and conflict detection need no document at merge time.
    `serialize`/`deserialize` round-trip a whole ledger (versioned like
    `SnapshotData`).
  - **Merge & diff** — `mergeLedgers` / `ledger.merge` produce a deduped,
    chronologically-ordered union; `diffLedgers` / `ledger.diff` report
    `onlyInA` / `onlyInB` / `common` by record id.
  - **Conflict resolution** — `findConflicts`, `recordsConflict`, and
    `resolveConflicts` with pluggable strategies (`lastWriteWins`,
    `firstWriteWins`, `preferSource`) for the "drop one side" path.
  - **Rebase (OT position mapping)** — `rebaseRecord` / `rebaseRecords` transform
    a record's positions into the coordinate space of concurrent edits (the "keep
    both" path), with conservative bails for genuinely unmappable cases.

  See the new `examples/ledger-kitchen-sink` for a two-client demo exercising
  record → merge → detect → resolve → rebase → diff → serialize end to end.

## 0.0.4

### Patch Changes

- Fixed bug with handle affordances and selection replacement

## 0.0.3

### Patch Changes

- 4adc206: Fix mention ActionPanel alignment

## 0.0.2

### Patch Changes

- 2d1ec6b: Package size reduction (removed map files from distributed library)
