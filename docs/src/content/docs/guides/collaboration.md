---
title: Collaboration
description: Real-time, multi-peer editing with optimistic OT, presence, and late-join sync.
---

A `Collaborator` turns the ledger primitives into a drop-in, real-time, multi-peer
editing experience: optimistic local edits, automatic convergence, live
presence/cursors, and late-join delta sync - no merge code on your side. The model is
**server-authoritative optimistic OT** (the shape ProseMirror's `collab` uses): an
authority owns the one canonical ordered log and broadcasts records already in canonical
position, so **every peer's confirmed document is identical by construction**.

See the [`@plim/collaboration` API reference](/api/collaboration/) for the full
contract.

```ts
import { Collaborator, createMemoryNetwork } from '@plim/collaboration';

// In-process hub with an embedded authority (swap for your own Transport in production).
const net = createMemoryNetwork({ origin: baseDoc });

const alice = new Collaborator({ peer: { id: 'alice', name: 'Alice' }, editor, transport: net.connect() });
alice.onChange((s) => render(s));          // { head, pending, inflight }
alice.setPresence({ status: 'editing' });  // ephemeral awareness (never logged to the ledger)
alice.peers;                                // remote cursors to render

// Local edits flow automatically: each committed transaction applies instantly
// (optimistic) and reconciles when the authority confirms it.

const dave = new Collaborator({ peer: { id: 'dave' }, editor: daveEditor, transport: net.connect() });
dave.sync();                                // late join: pull the backlog, fast-forward to head
```

Local edits apply **instantly** and sit in `pending` until confirmed; the **local caret
is always preserved** (shifted to track remote inserts, never replaced by a remote
cursor, never disturbed when your own edit is acked). At quiescence every peer's
confirmed document equals the authority's - provable, and locked in by a four-peer
randomized fuzz convergence test.

## A real server with `CollabHub`

For a **real** server, drop the in-process `createMemoryNetwork` and reach for
`CollabHub` - the transport-agnostic server half of the protocol. Wrap any socket as a
`HubClient` and it linearizes submissions and broadcasts canonical records for you:

```ts
import { CollabHub, type HubClient } from '@plim/collaboration';

const hub = new CollabHub(baseDoc);
// per connection:
const client: HubClient = { send: (m) => socket.send(JSON.stringify(m)) };
hub.add(client);
socket.on('message', (raw) => hub.receive(client, JSON.parse(raw)));
socket.on('close', () => hub.remove(client));
```

:::tip
See `examples/collab-kitchen-sink` for one shared document served over a real WebSocket
by a tiny Hono + `CollabHub` backend - open it in two tabs and edit together.
:::

Next: add [comments & replies](/guides/comments/), which ride the same OT/collab layer.
