---
"@plim/core": minor
---

Add `invertOps` / `invertOp` (and the `findBlockPathById` helper) for computing the op-based inverse of a transaction at dispatch time. `invertOps` walks a transaction's ops forward to capture the pre-op state of each op, then folds per-op inverses in reverse order so applying the result to the post-transaction state reproduces the original document; it returns `null` when any op is not faithfully invertible (the caller can then fall back to a snapshot restore). `HistoryEntry` gains optional `ops`, `inverse`, and `selectionBefore` fields to carry this data.
