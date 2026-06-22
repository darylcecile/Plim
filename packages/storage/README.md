# @plim/storage

Durable persistence primitives for [Plim](https://github.com/darylcecile/plim) documents. `@plim/storage` is framework-agnostic: it stores serialized `Snapshot` strings behind a small adapter interface, then composes those adapters with debounced autosave. It is the durable counterpart to the ledger/transport sync layer, and is **optional**.

## Install

```sh
pnpm add @plim/storage @plim/core
```

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

## Document store

`createDocumentStore({ adapter, key })` binds any `StorageAdapter` to a single key and returns a small `{ load, save, remove }` handle — convenient when you want to read/write one document without threading the key through every call.

## Where to go next

- **Snapshots** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core) (`Snapshot`).
- **The wire** — [`@plim/transports`](https://github.com/darylcecile/plim/tree/main/packages/transports) (used by `createTransportAdapter`).
- **Sync layer** — [`@plim/ledger`](https://github.com/darylcecile/plim/tree/main/packages/ledger) and [`@plim/collaboration`](https://github.com/darylcecile/plim/tree/main/packages/collaboration).

## License

See the [LICENSE](./LICENSE) file in this package.
