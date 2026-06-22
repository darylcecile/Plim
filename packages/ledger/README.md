# @plim/ledger

Record, replay, merge, diff, and rebase transactions for the [Plim](https://github.com/darylcecile/plim) block editor. This is the **bring-your-own sync / CRDT layer**: a `TransactionLedger` is an append-only, serializable, replayable log of committed transactions, with conservative conflict detection and operational-transform rebase. It is runtime-agnostic (no DOM) and built directly on `@plim/core`.

Snapshots ([`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core)) ship a whole document state; the ledger ships the **stream of edits**. If you want a turnkey real-time experience, use [`@plim/collaboration`](https://github.com/darylcecile/plim/tree/main/packages/collaboration), which is built on top of this package.

## Install

```sh
pnpm add @plim/ledger @plim/core
```

## The `LedgerRecord`

The unit of exchange is the `LedgerRecord` — a small, JSON-safe record of one transaction's ops, stamped with an `id`, a wall-clock `timestamp`, a logical `lamport` clock, an optional `source`, and a pre-computed, id-keyed conflict surface (`touches`).

## Record → replay → merge → resolve / rebase

```ts
import {
  TransactionLedger,
  mergeLedgers, findConflicts, resolveConflicts,
  rebaseRecord, applyLedgerRecord, lastWriteWins,
} from '@plim/ledger';

// 1. Record — attach a ledger to an editor, or record transactions by hand.
const ledger = new TransactionLedger({ source: 'clientA' });
const detach = ledger.attach(editor);                 // records every committed tx (incl. undo/redo)

// 2. Replay — onto any editor seeded with the same base (one setState, no history noise).
ledger.replay(otherEditor);                            // side-effecting
const state = ledger.apply(otherEditor.getState());    // pure fold

// 3. Serialize — ship the log over the wire and rebuild it.
const remote = TransactionLedger.deserialize(ledger.serialize());

// 4. Merge — chronological union, deduped by id.
const merged = mergeLedgers(ledger, remote);

// 5a. Resolve — pick a winner when records overlap…
const { kept, dropped } = resolveConflicts(merged.records, lastWriteWins);

// 5b. …or rebase — keep both sides by transforming positions (git-rebase for edits).
const r = rebaseRecord(remote.records[0]!, ledger.records[0]!, editor.getState().doc);
if (r.ok) editor.setState(applyLedgerRecord(editor.getState(), r.record));
```

## `TransactionLedger`

Construct with `new TransactionLedger({ source?, compare? })`. Key surface:

- `attach(editor, options?)` — record every committed transaction; returns a detach function.
- `record(tx, options?)` — record a single transaction by hand.
- `replay(editor)` — replay the whole log onto an editor (side-effecting).
- `apply(state)` / `applyRange(state, start?, end?)` — pure folds returning new state.
- `onRecord(listener)` — observe records as they're appended.
- `serialize()` / `TransactionLedger.deserialize(payload, options?)` — round-trip the log.
- `records`, `length`, `clock`, `comparator` — read-only accessors.

## Merge, conflicts & rebase helpers

- **Merge / diff:** `mergeLedgers`, `diffLedgers`, `compareRecords`.
- **Conflicts:** `findConflicts`, `recordsConflict`, `resolveConflicts`, plus strategies `lastWriteWins`, `firstWriteWins`, and `preferSource`. Define your own via the `ConflictStrategy` type.
- **Rebase (OT):** `rebaseRecord`, `rebaseRecords`, `rebaseBlockPath`, `rebaseTextPoint`, returning `{ ok: false, reason }` instead of guessing when a concurrent change tears a range across blocks.
- **Apply / inspect:** `applyLedgerRecord`, `recordFromTransaction`, `computeTouches`, `summarizeRecord`.

## Guarantees

Conflict detection is **conservative** (it flags rather than silently clobbers), works **document-free** at merge time (records carry their own id-keyed `touches`), and is **order-independent**. Ordering defaults to `timestamp → lamport → source → id` and is fully overridable via `new TransactionLedger({ compare })`.

**Undo/redo are recorded.** Undo and redo flow through the normal `dispatch` path as real transactions carrying inverse ops (undo) or original ops (redo), so an attached ledger records them like any other edit and `replay()` reproduces the source editor's *current* document faithfully.

## Where to go next

- **Turnkey collaboration** — [`@plim/collaboration`](https://github.com/darylcecile/plim/tree/main/packages/collaboration) (optimistic OT, `CollabHub`, presence, comments).
- **The wire** — [`@plim/transports`](https://github.com/darylcecile/plim/tree/main/packages/transports).
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md#ledger--sync-api).
- **Two-client playground** — [`examples/ledger-kitchen-sink`](https://github.com/darylcecile/plim/tree/main/examples/ledger-kitchen-sink).

## License

See the [LICENSE](./LICENSE) file in this package.
