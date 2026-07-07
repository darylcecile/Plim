# @plim/ledger

## 0.4.0

### Minor Changes

- 9b3a12c: Add `PlimInputBox`, a stripped-down single-block editor for chat/comment-style composers.

  `PlimInputBox` is a mini `PlimEditor`: a single block only (Enter never splits), with no
  `+` add button and no drag handle, plus a configurable placeholder. It still supports the
  non-multi-block extensions — mojis, markdown input rules, slash commands, mentions and
  inline formatting — while skipping multi-block concerns (the collab hub, ledger and
  transport are simply not wired up). Enter submits, Shift+Enter inserts a soft newline, and
  Cmd/Ctrl+Enter always submits; the input clears on submit by default. Multi-paragraph
  pastes collapse to soft newlines so the input stays single-block.

  Pop-up menus (slash, mention) now anchor to the whole input box in single-block mode, so
  they flip cleanly above the composer instead of covering the text being typed.

### Patch Changes

- Updated dependencies [9b3a12c]
  - @plim/core@0.4.0

## 0.3.0

### Minor Changes

- Align all `@plim` package versions with a minor bump so every published package
  stays in lockstep at the same version, including the new `@plim/mojis` package.
- 94b47dd: Add three optional, non-breaking add-on packages:

  - **`@plim/html`** — a headless, SSR-safe serializer that renders a Plim document model to an HTML string (`serializeToHTML`) with overridable per-block / per-mark renderers and escaped-by-default output. No DOM, so it runs in Node, edge runtimes, email, and SEO pipelines.
  - **`@plim/storage`** — durable persistence primitives: pluggable `StorageAdapter`s (memory, `localStorage`, IndexedDB, and a `@plim/transports` server-document adapter) composed with debounced snapshot autosave (`createAutosave`).
  - **`@plim/test-utils`** — runner-agnostic testing helpers (fluent document/mark builders, a headless `createTestEditor` backed by the real driver, `applyTx`, and inspectors/assertions) for unit-testing custom blocks, marks, and extensions without a browser.

  These are additive primitives; no existing API changes. All `@plim/*` packages are bumped together to keep the suite on a single synchronized version.

### Patch Changes

- Updated dependencies [30ad81e]
- Updated dependencies [94b47dd]
  - @plim/core@0.3.0

## 0.2.0

### Minor Changes

- d670d8d: Add comments & threaded replies, and a new `@plim/transports` package.

  - **`@plim/transports`** (new): tiny, zero-dep duplex-channel primitives — the `Transport<T>` interface, in-memory loopback pair + broadcast bus, `BroadcastChannelTransport`, a reconnecting `WebSocketTransport`, and `mapTransport` codecs. The wire that collaboration and comments sync over.
  - **`@plim/core`**: explicit `addMark` / `removeMark` transaction ops (alongside the existing `toggleMark`), with faithful inversion for undo. Needed for precise comment apply/remove.
  - **`@plim/ledger`**: rebase + conflict handling extended to the new `addMark` / `removeMark` ops so comment highlights converge under concurrent edits.
  - **`@plim/collaboration`**: Notion-style comments & replies. A comment is a `commentMark` in the document (so the highlight rides OT/collab and moves with the text); thread bodies live in an observable, last-writer-wins `CommentStore` synced over any `@plim/transports` channel via `CommentSync`. Ships default, overridable styling at `@plim/collaboration/comments.css`.
  - **`@plim/react`**: drop-in `<CommentsLayer>` plus composable `CommentThreadCard` / `CommentCard` / `CommentComposer` / `useComments`. Register `commentMark` and mount the layer — the editor's selection toolbar gains a Comment button automatically; clicking a highlight opens its thread. The composer trigger is decoupled via `COMMENT_COMPOSE_EVENT` so any UI can drive it.

### Patch Changes

- Updated dependencies [d670d8d]
  - @plim/core@0.2.0

## 0.1.3

### Patch Changes

- Patch bump to keep all @plim packages on the same version for a synchronized release.
- Updated dependencies
  - @plim/core@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [d733374]
  - @plim/core@0.1.2

## 0.1.1

### Patch Changes

- Align versions with the rest of the @plim packages (0.1.1).

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
