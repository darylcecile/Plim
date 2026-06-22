---
title: Snapshots
description: Full state captures for autosave, restore, and sending documents over the wire.
---

Snapshots are full state captures - handy for autosave/restore, "revert to here"
buttons, or sending the document over the wire.

See [`Snapshot`](/api/core/) in the `@plim/core` API reference for the full surface.

```ts
import { Snapshot } from '@plim/core';

const snap = new Snapshot(editor);          // or new Snapshot(editor.getState())
const json = snap.serialize();              // store this anywhere

// later...
const restored = Snapshot.deserialize(json);
editor.restoreSnapshot(restored);
```

`restoreSnapshot` replaces state directly - it does not push a history entry, so
undo/redo will not roll across the restore. Wrap restores in your own confirmation flow
if that matters.

:::note
Snapshots ship a whole state. If you want the *stream of edits* instead - for sync or
CRDT use cases - reach for the [ledger](/guides/ledger-and-sync/).
:::
