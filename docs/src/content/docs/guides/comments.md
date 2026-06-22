---
title: Comments & replies
description: Notion-style comments with threaded replies that ride the OT/collab layer.
---

Notion-style **comments with threaded replies** (select text -> comment -> reply ->
resolve) ship in `@plim/collaboration`. A comment is a `commentMark` in the document, so
the highlight rides OT/collab and moves with the text; the thread bodies live out-of-band
in an observable, convergent `CommentStore` that syncs over any
[`@plim/transports`](/api/transports/) channel.

See the [`@plim/collaboration` API reference](/api/collaboration/) for the comment
helpers and stores, and [`@plim/react`](/api/react/) for the UI components.

It works by registering one mark and mounting one component - the editor's selection
toolbar gains a comment button automatically, and clicking a highlight opens its thread:

```tsx
import { commentMark, CommentStore, CommentSync } from '@plim/collaboration';
import { BroadcastChannelTransport } from '@plim/transports';
import { CommentsLayer } from '@plim/react';
import '@plim/collaboration/comments.css'; // default, overridable styling

// 1. register the mark on your driver:  registeredMarks: [..., commentMark]
// 2. one store per client (unique actor); optionally sync across tabs/clients:
const store = new CommentStore({ actor: crypto.randomUUID() });
new CommentSync(store, new BroadcastChannelTransport('my-doc-comments'));

// 3. mount the layer next to your editor:
<CommentsLayer editor={handle} store={store} currentUser={{ id: 'me', name: 'You' }} />;
```

## Everything is replaceable

Every layer is replaceable: trigger the composer from your own UI by dispatching
`COMMENT_COMPOSE_EVENT`; build a custom panel from the exported `CommentThreadCard` /
`CommentCard` / `CommentComposer` / `useComments`; restyle via the `--plim-comment-*`
CSS variables; or drive the pure doc helpers (`addCommentMark`, `removeCommentMark`,
`findCommentRanges`) and the headless `CommentStore` directly.

:::tip
See `examples/notion-clone` for a wired demo with cross-tab sync.
:::
