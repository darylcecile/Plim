---
title: Ledger & sync
description: An append-only, serializable, replayable log of transactions - the layer you build sync and CRDTs on.
---

A `TransactionLedger` is an append-only, serializable, replayable log of committed
transactions - the layer you build your own sync / CRDT engine on. Snapshots ship whole
states; the ledger ships the *stream of edits*. The unit of exchange is the
`LedgerRecord`: a small, JSON-safe record of one transaction's ops, stamped with an
`id`, a wall-clock `timestamp`, a logical `lamport` clock, an optional `source`, and a
pre-computed id-keyed conflict surface (`touches`).

See the [`@plim/ledger` API reference](/api/ledger/) for every symbol used below.

```ts
import { TransactionLedger, mergeLedgers, findConflicts, resolveConflicts, rebaseRecord, applyLedgerRecord, lastWriteWins } from '@plim/ledger';

// 1. Record - subscribe a ledger to an editor, or record transactions by hand.
const ledger = new TransactionLedger({ source: 'clientA' });
const detach = ledger.attach(editor);          // records every committed transaction (incl. undo/redo)

// 2. Replay - onto any editor seeded with the same base (one setState, no history noise).
ledger.replay(otherEditor);                     // side-effecting
const state = ledger.apply(otherEditor.getState()); // pure fold

// 3. Serialize - ship the log over the wire and rebuild it.
const remote = TransactionLedger.deserialize(ledger.serialize());

// 4. Merge - chronological union, deduped by id.
const merged = mergeLedgers(ledger, remote);

// 5a. Resolve - pick a winner when records overlap...
const { kept, dropped } = resolveConflicts(merged.records, lastWriteWins);

// 5b. ...or rebase - keep both sides by transforming positions (git-rebase for edits).
const r = rebaseRecord(remote.records[0]!, ledger.records[0]!, editor.getState().doc);
if (r.ok) editor.setState(applyLedgerRecord(editor.getState(), r.record));
```

## Guarantees

Conflict detection is **conservative** (it would rather flag a conflict than silently
clobber), works **document-free** at merge time (records carry their own id-keyed
`touches`), and is **order-independent**. Rebase handles text edits and block
insert/remove/split/move precisely, and returns `{ ok: false, reason }` - rather than
guessing - when a concurrent change tears a range across blocks or deletes content a
record depends on. Ordering is `timestamp -> lamport -> source -> id` by default and
fully overridable via `new TransactionLedger({ compare })`.

## Undo/redo are recorded

Undo and redo flow through the normal `dispatch` path as real transactions carrying
inverse ops (undo) or the original ops (redo), computed at dispatch time. An attached
ledger therefore records them like any other edit, so `replay()` reproduces the source
editor's *current* document faithfully across undo/redo - e.g. type `A`, type `B`, undo,
type `C` replays to `AC`, not `ACB`. (If a transaction is not op-invertible the editor
falls back to a snapshot restore for that one undo, which is not recorded.)

:::tip
See `examples/ledger-kitchen-sink` for two editors syncing through every one of these
primitives. For a drop-in real-time experience built on top of the ledger, see
[Collaboration](/guides/collaboration/).
:::
