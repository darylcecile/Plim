---
'@plim/core': minor
---

Add a transaction ledger / sync layer for bring-your-own CRDT or OT engines.

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
