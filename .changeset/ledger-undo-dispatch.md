---
"@plim/editor": minor
---

Undo and redo now flow through the normal `dispatch` path as real transactions instead of restoring a whole `EditorState` snapshot. `dispatch` records each transaction's forward ops plus their computed inverse on the history entry; undo commits the inverse ops and redo commits the original ops (both with `meta.addToHistory = false`, a `meta.history` tag, and a restored caret via `meta.nextSelection`). Because these transactions fire the editor's transaction listeners, an attached `TransactionLedger` records undo/redo and `replay()` stays faithful to the live document across them. Non-invertible transactions transparently fall back to the previous snapshot-restore behavior so undo never breaks.
