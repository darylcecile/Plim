---
"@plim/collaboration": minor
---

Keep remote presence cursors stable across edits. Remote carets are stored as absolute `{path, offset}` positions, so any concurrent edit (your own typing or a third peer's confirmed ops) used to leave them pointing at the wrong text until that peer next broadcast — drifting, then visibly jumping.

`Collaborator` now remaps every stored remote selection over the same ops it already uses to keep the local caret steady: over local transaction ops as you type, and over a confirmed remote batch (excluding the ops a peer authored itself, whose own broadcast already reflects them). Carets whose block is deleted are dropped (hidden) until the peer broadcasts afresh, rather than rendered at a stale location.

Adds `PresenceTracker.mapSelections(mapper)` — a ledger-agnostic hook to remap remote carets while leaving each peer's liveness `clock`/`lastSeen` untouched, so a peer's next genuine broadcast still wins.
