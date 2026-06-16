# @plim/collaboration

## 0.1.3

### Patch Changes

- e8869f7: Keep remote presence cursors stable across edits. Remote carets are stored as absolute `{path, offset}` positions, so any concurrent edit (your own typing or a third peer's confirmed ops) used to leave them pointing at the wrong text until that peer next broadcast — drifting, then visibly jumping.

  `Collaborator` now remaps every stored remote selection over the same ops it already uses to keep the local caret steady: over local transaction ops as you type, and over a confirmed remote batch (excluding the ops a peer authored itself, whose own broadcast already reflects them). Carets whose block is deleted are dropped (hidden) until the peer broadcasts afresh, rather than rendered at a stale location.

  Adds `PresenceTracker.mapSelections(mapper)` — a ledger-agnostic hook to remap remote carets while leaving each peer's liveness `clock`/`lastSeen` untouched, so a peer's next genuine broadcast still wins.

- Updated dependencies
  - @plim/core@0.1.3
  - @plim/ledger@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [d733374]
  - @plim/core@0.1.2
  - @plim/ledger@0.1.2

## 0.1.1

### Patch Changes

- Align versions with the rest of the @plim packages (0.1.1).
- Updated dependencies
  - @plim/ledger@0.1.1

## 0.1.0

### Minor Changes

- 8016478: Introduce `@plim/collaboration`: the real-time collaboration layer
  (`Collaborator`, `CollabHub`, presence) built on top of `@plim/ledger`,
  extracted out of `@plim/core` into its own package. The API is identical — only
  the import path changes from `@plim/core` to `@plim/collaboration`.

  Server-authoritative optimistic OT (the shape ProseMirror's `collab` uses): an
  authority owns the one canonical ordered log and broadcasts records already in
  canonical position, so every peer's confirmed document is identical by
  construction.

  - **`Collaborator`** — wraps an editor and a `Transport`; local edits apply
    instantly as optimistic `pending`, confirmed batches ack/rebase/rebuild, and
    the local caret is always preserved (never replaced by a remote selection).
  - **Presence / awareness** — `PresenceTracker` plus `setPresence` /
    `patchPresence` / `peers` share ephemeral cursor and status state, never
    written to the ledger, lamport-guarded and TTL-pruned.
  - **Transport & authority** — `CollabHub` is the transport-agnostic server half;
    `createMemoryNetwork` provides an in-process hub and loopback `Transport`s
    with optional latency for demos and tests. `VersionVector` helpers and the
    `CollabMessage` wire DSL round out the protocol.
  - **Late join / reconnect** — `sync()` pulls every missing canonical record and
    fast-forwards to the authority's head.

  Convergence is locked in by a four-peer randomized fuzz test and guarded by a
  benchmark suite. See `examples/collab-kitchen-sink` for one shared document
  served over a real WebSocket by a tiny Hono + `CollabHub` backend.

### Patch Changes

- Updated dependencies [8016478]
- Updated dependencies [8016478]
  - @plim/core@0.1.1
  - @plim/ledger@0.1.0
