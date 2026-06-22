# @plim/collaboration

Fast real-time multi-peer editing for the [Plim](https://github.com/darylcecile/plim) block editor: optimistic OT via `Collaborator`, the transport-agnostic `CollabHub` server half, live presence/awareness, and version vectors. Built on `@plim/ledger`.

## Install

```sh
pnpm add @plim/collaboration @plim/ledger @plim/core
```

## Comments & replies

Notion-style **comments with threaded replies**: select text, leave a comment, reply, resolve. It ships as part of this package and works out of the box, but every layer is replaceable.

How it's modelled:

- A **comment is a mark in the document** (`commentMark`, attrs `{ threadId }`). Because the highlight lives in the doc it rides the editor's OT/collab rebasing for free — the range moves with the text and survives concurrent edits. The Markdown serializer drops unknown marks, so export stays clean.
- **Thread content** (comment bodies, replies, authors, resolved state) lives *outside* the doc in a `CommentStore` — an observable, event-sourced, last-writer-wins store that converges across peers.
- The store syncs over any [`@plim/transports`](https://github.com/darylcecile/plim/tree/main/packages/transports) channel via `CommentSync`, so cross-tab / cross-client comments need zero bespoke networking.

### Out of the box

```ts
import {
  commentMark,
  CommentStore,
  CommentSync,
} from '@plim/collaboration';
import { BroadcastChannelTransport } from '@plim/transports';
import '@plim/collaboration/comments.css'; // default, overridable styling

// 1. Register the mark on your editor driver so the highlight renders and the
//    editor's selection toolbar gains a "Comment" button automatically.
registeredMarks: [/* …your marks…, */ commentMark],

// 2. Create a store (one per client; give each peer a unique `actor`).
const store = new CommentStore({ actor: crypto.randomUUID() });

// 3. (Optional) sync threads across tabs / clients over any transport.
new CommentSync(store, new BroadcastChannelTransport('my-doc-comments'));
```

In React, mount one component alongside your editor — it opens the composer when the toolbar button fires, renders the thread popover when a highlight is clicked, and keeps resolved/active state in sync:

```tsx
import { CommentsLayer } from '@plim/react';

<CommentsLayer editor={handle} store={store} currentUser={{ id: 'me', name: 'You' }} />
```

That's the whole feature: register the mark, mount the layer. Selecting text shows the editor's native toolbar with a 💬 **Comment** button; clicking a highlight opens its thread.

### Extending it

- **Custom trigger / UI.** The toolbar button is decoupled via a DOM event. Dispatch `COMMENT_COMPOSE_EVENT` (a `CustomEvent<CommentComposeDetail>`) from anywhere — a button, a keyboard shortcut, a menu — and `CommentsLayer` opens the composer for the current selection.
- **Custom rendering.** `@plim/react` also exports the building blocks (`CommentThreadCard`, `CommentCard`, `CommentComposer`, `useComments`) so you can compose your own panel instead of `CommentsLayer`.
- **Custom styling.** `comments.css` is a single `@layer plim-comments` stylesheet driven by `--plim-comment-*` CSS variables, matching the rest of the editor. Override the variables (or any class) without `!important`.
- **Custom transport.** Anything implementing the `Transport<T>` interface from `@plim/transports` works with `CommentSync` — in-memory, `BroadcastChannel`, reconnecting WebSocket, or your own.
- **Direct doc/store access.** Pure doc helpers (`addCommentMark`, `removeCommentMark`, `findCommentRanges`, `commentThreadIdsInSelection`, `allCommentThreadIds`) and the observable `CommentStore` (`createThread`, `addComment`, `resolveThread`, `deleteThread`, `subscribe`, …) are all public for headless or server-side use.

See [`examples/notion-clone`](https://github.com/darylcecile/plim/tree/main/examples/notion-clone) for a full wiring with cross-tab sync.

## API surface

- **Real-time editing** — `Collaborator`, `CollaboratorOptions`, `CollabStatus`, `createMemoryNetwork` / `MemoryNetwork`.
- **Server half** — `CollabHub`, `HubClient`, `InMemoryAuthority`, `SubmitResult`.
- **Presence** — `PresenceTracker`, `Peer`, `PeerPresence`, `PresenceState`.
- **Version vectors** — `versionVectorOf`, `mergeVersionVectors`, `recordsAfter`, `coversRecord`, `VersionVector`.
- **Comments** — `commentMark`, `CommentStore`, `CommentSync` / `createCommentSync`, the doc helpers (`addCommentMark`, `removeCommentMark`, `findCommentRanges`, `commentMarkRanges`, `commentThreadIdsInSelection`, `allCommentThreadIds`), and the `COMMENT_COMPOSE_EVENT` / `COMMENT_MARK_NAME` / `COMMENT_THREAD_ATTR` constants.

## Where to go next

- **The sync primitives underneath** — [`@plim/ledger`](https://github.com/darylcecile/plim/tree/main/packages/ledger).
- **The wire** — [`@plim/transports`](https://github.com/darylcecile/plim/tree/main/packages/transports).
- **Comments UI** — [`@plim/react`](https://github.com/darylcecile/plim/tree/main/packages/react) (`CommentsLayer` and friends).
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md#collaboration-api).
- **Live demo** — [`examples/collab-kitchen-sink`](https://github.com/darylcecile/plim/tree/main/examples/collab-kitchen-sink).

## License

See the [LICENSE](./LICENSE) file in this package.
