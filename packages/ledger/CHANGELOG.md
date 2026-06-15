# @plim/ledger

## 0.1.0

### Minor Changes

- 8016478: Introduce `@plim/ledger`: the transaction ledger / sync layer for
  bring-your-own CRDT or OT engines, extracted out of `@plim/core` into its own
  package. The API is identical — only the import path changes from `@plim/core`
  to `@plim/ledger`.

  Framework-agnostic primitives that sit alongside core's transaction, history,
  and snapshot APIs:

  - **`TransactionLedger`** — an ordered, append-only log of committed
    transactions. `record`/`attach` capture forward edits, `apply`/`applyRange`
    replay them as a pure fold, and `replay(editor)` reapplies them in a single
    `setState` (no history pollution). Ledgers stay sorted by a deterministic
    total order (`timestamp → lamport → source → id`) via binary-search insertion.
  - **`LedgerRecord` / `LedgerSnapshot`** — a self-contained, JSON-serializable
    intermediary type carrying an id-keyed `touches` conflict surface, so merge
    and conflict detection need no document at merge time.
    `serialize`/`deserialize` round-trip a whole ledger.
  - **Merge & diff** — `mergeLedgers` / `diffLedgers` produce a deduped,
    chronologically-ordered union and report `onlyInA` / `onlyInB` / `common`.
  - **Conflict resolution** — `findConflicts`, `recordsConflict`, and
    `resolveConflicts` with pluggable strategies (`lastWriteWins`,
    `firstWriteWins`, `preferSource`).
  - **Rebase (OT position mapping)** — `rebaseRecord` / `rebaseRecords` transform
    a record's positions into the coordinate space of concurrent edits, with
    conservative bails for genuinely unmappable cases.

  See `examples/ledger-kitchen-sink` for a record → merge → detect → resolve →
  rebase → diff → serialize walkthrough.

### Patch Changes

- Updated dependencies [8016478]
  - @plim/core@0.1.1
