---
title: Storage & autosave
description: Durable persistence behind a tiny adapter, plus debounced snapshot autosave.
---

`@plim/storage` is the durable counterpart to the sync primitives: it persists
serialized `Snapshot` strings behind a tiny `StorageAdapter` and composes them with
debounced autosave. Adapters ship for memory, `localStorage`, IndexedDB, and any
[`@plim/transports`](/api/transports/) channel (the server-document pattern).

See the [`@plim/storage` API reference](/api/storage/) for every adapter and
`createAutosave`.

```ts
import { createAutosave, createLocalStorageAdapter } from '@plim/storage';

const autosave = createAutosave({ editor, adapter: createLocalStorageAdapter(), key: 'doc' });

await autosave.load();   // restore a saved snapshot into the editor
// Edits now debounce-save automatically: saveNow() bypasses, flush() forces, stop() unsubscribes.
```

Adapters are string-in/string-out (`load` / `save` / `remove` / optional `keys`), so you
can drop in your own backend. Pairs naturally with [snapshots](/guides/snapshots/) (what
gets persisted) and the [ledger](/guides/ledger-and-sync/) (the edit stream).
