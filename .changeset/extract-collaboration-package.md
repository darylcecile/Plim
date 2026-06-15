---
'@plim/collaboration': minor
---

Introduce `@plim/collaboration`: the real-time collaboration layer
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
