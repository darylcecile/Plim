# @plim/storage

Durable persistence primitives for Plim documents. `@plim/storage` is framework-agnostic: it stores serialized `Snapshot` strings behind a small adapter interface, then composes those adapters with debounced autosave.

## Autosave to localStorage

```ts
import { createAutosave, createLocalStorageAdapter } from '@plim/storage';

const autosave = createAutosave({
editor,
adapter: createLocalStorageAdapter(),
key: 'doc',
});

await autosave.load();
```

Autosave listens to `editor.onTransaction`, waits for the debounce window, then saves `new Snapshot(editor).serialize()`. Use `saveNow()` to bypass the debounce, `flush()` to save pending work, `load()` to restore a saved snapshot, and `stop()` to unsubscribe.

## Storage adapters

Every adapter is string-in/string-out. Values are serialized Plim snapshots.

```ts
interface StorageAdapter {
load(key: string): Promise<string | null>;
save(key: string, value: string): Promise<void>;
remove(key: string): Promise<void>;
keys?(): Promise<string[]>;
}
```

Built-ins:

- `createMemoryAdapter()` for tests, servers, and SSR-safe ephemeral storage.
- `createLocalStorageAdapter({ storage, prefix })` for browser localStorage, with injectable storage for tests.
- `createIndexedDBAdapter({ dbName, storeName, indexedDB })` for async browser persistence, with injectable IndexedDB for tests.
- `createTransportAdapter(transport, { timeoutMs, requestId })` for saving through a remote peer.

## Transport/server-document pattern

`createTransportAdapter` uses `@plim/transports` (`send`, `onMessage`, `close`) to request persistence from another endpoint. The client sends:

```ts
type StorageTransportMessage =
| { type: 'save'; key: string; value: string }
| { type: 'remove'; key: string }
| { type: 'load'; key: string; id: string }
| { type: 'loaded'; key: string; id: string; value: string | null };
```

A server peer listens for `save`, `remove`, and `load`. For each `load`, reply with `loaded` using the same `id` and `key`; the adapter ignores unrelated replies and rejects if the timeout elapses.
