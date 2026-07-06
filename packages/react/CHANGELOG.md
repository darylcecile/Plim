# @plim/react

## 0.3.0

### Minor Changes

- Align all `@plim` package versions with a minor bump so every published package
  stays in lockstep at the same version, including the new `@plim/mojis` package.

### Patch Changes

- Updated dependencies
- Updated dependencies [30ad81e]
- Updated dependencies [94b47dd]
  - @plim/collaboration@0.3.0
  - @plim/core@0.3.0
  - @plim/editor@0.3.0

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
  - @plim/collaboration@0.2.0
  - @plim/core@0.2.0
  - @plim/editor@0.2.0

## 0.1.3

### Patch Changes

- Patch bump to keep all @plim packages on the same version for a synchronized release.
- Updated dependencies
  - @plim/core@0.1.3
  - @plim/editor@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [d733374]
- Updated dependencies [d733374]
  - @plim/editor@0.1.2
  - @plim/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [8016478]
  - @plim/core@0.1.1
  - @plim/editor@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [8b5568f]
- Updated dependencies [7e5e783]
  - @plim/core@0.1.0
  - @plim/editor@0.1.0

## 0.0.4

### Patch Changes

- Fixed bug with handle affordances and selection replacement
- Updated dependencies
  - @plim/editor@0.0.4
  - @plim/core@0.0.4

## 0.0.3

### Patch Changes

- 4adc206: Fix mention ActionPanel alignment
- Updated dependencies [4adc206]
  - @plim/editor@0.0.3
  - @plim/core@0.0.3

## 0.0.2

### Patch Changes

- 2d1ec6b: Package size reduction (removed map files from distributed library)
- Updated dependencies [2d1ec6b]
  - @plim/editor@0.0.2
  - @plim/core@0.0.2
