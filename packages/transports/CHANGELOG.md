# @plim/transports

## 0.3.0

### Minor Changes

- Align all `@plim` package versions with a minor bump so every published package
  stays in lockstep at the same version, including the new `@plim/mojis` package.
- 94b47dd: Add three optional, non-breaking add-on packages:

  - **`@plim/html`** — a headless, SSR-safe serializer that renders a Plim document model to an HTML string (`serializeToHTML`) with overridable per-block / per-mark renderers and escaped-by-default output. No DOM, so it runs in Node, edge runtimes, email, and SEO pipelines.
  - **`@plim/storage`** — durable persistence primitives: pluggable `StorageAdapter`s (memory, `localStorage`, IndexedDB, and a `@plim/transports` server-document adapter) composed with debounced snapshot autosave (`createAutosave`).
  - **`@plim/test-utils`** — runner-agnostic testing helpers (fluent document/mark builders, a headless `createTestEditor` backed by the real driver, `applyTx`, and inspectors/assertions) for unit-testing custom blocks, marks, and extensions without a browser.

  These are additive primitives; no existing API changes. All `@plim/*` packages are bumped together to keep the suite on a single synchronized version.

## 0.2.0

### Minor Changes

- d670d8d: Add comments & threaded replies, and a new `@plim/transports` package.

  - **`@plim/transports`** (new): tiny, zero-dep duplex-channel primitives — the `Transport<T>` interface, in-memory loopback pair + broadcast bus, `BroadcastChannelTransport`, a reconnecting `WebSocketTransport`, and `mapTransport` codecs. The wire that collaboration and comments sync over.
  - **`@plim/core`**: explicit `addMark` / `removeMark` transaction ops (alongside the existing `toggleMark`), with faithful inversion for undo. Needed for precise comment apply/remove.
  - **`@plim/ledger`**: rebase + conflict handling extended to the new `addMark` / `removeMark` ops so comment highlights converge under concurrent edits.
  - **`@plim/collaboration`**: Notion-style comments & replies. A comment is a `commentMark` in the document (so the highlight rides OT/collab and moves with the text); thread bodies live in an observable, last-writer-wins `CommentStore` synced over any `@plim/transports` channel via `CommentSync`. Ships default, overridable styling at `@plim/collaboration/comments.css`.
  - **`@plim/react`**: drop-in `<CommentsLayer>` plus composable `CommentThreadCard` / `CommentCard` / `CommentComposer` / `useComments`. Register `commentMark` and mount the layer — the editor's selection toolbar gains a Comment button automatically; clicking a highlight opens its thread. The composer trigger is decoupled via `COMMENT_COMPOSE_EVENT` so any UI can drive it.
