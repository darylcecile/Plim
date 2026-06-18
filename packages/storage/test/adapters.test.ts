import { createMemoryTransportPair } from '@plim/transports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
createIndexedDBAdapter,
createLocalStorageAdapter,
createMemoryAdapter,
createTransportAdapter,
type StorageTransportMessage,
} from '@plim/storage';

class MemoryStorage implements Storage {
private readonly values = new Map<string, string>();

get length(): number {
return this.values.size;
}

clear(): void {
this.values.clear();
}

getItem(key: string): string | null {
return this.values.get(key) ?? null;
}

key(index: number): string | null {
return [...this.values.keys()][index] ?? null;
}

removeItem(key: string): void {
this.values.delete(key);
}

setItem(key: string, value: string): void {
this.values.set(key, value);
}
}

class FakeRequest<T> {
result!: T;
error: DOMException | null = null;
onsuccess: ((event: Event) => void) | null = null;
onerror: ((event: Event) => void) | null = null;
onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;

succeed(value: T): void {
this.result = value;
this.onsuccess?.(new Event('success'));
}
}

class FakeObjectStore {
constructor(private readonly values: Map<string, string>) {}

get(key: IDBValidKey): IDBRequest<string | undefined> {
const request = new FakeRequest<string | undefined>();
setTimeout(() => request.succeed(this.values.get(String(key))), 0);
return request as IDBRequest<string | undefined>;
}

put(value: string, key: IDBValidKey): IDBRequest<IDBValidKey> {
const request = new FakeRequest<IDBValidKey>();
setTimeout(() => {
this.values.set(String(key), value);
request.succeed(key);
}, 0);
return request as IDBRequest<IDBValidKey>;
}

delete(key: IDBValidKey): IDBRequest<undefined> {
const request = new FakeRequest<undefined>();
setTimeout(() => {
this.values.delete(String(key));
request.succeed(undefined);
}, 0);
return request as IDBRequest<undefined>;
}

getAllKeys(): IDBRequest<IDBValidKey[]> {
const request = new FakeRequest<IDBValidKey[]>();
setTimeout(() => request.succeed([...this.values.keys()]), 0);
return request as IDBRequest<IDBValidKey[]>;
}
}

class FakeDatabase {
readonly stores = new Map<string, Map<string, string>>();
readonly objectStoreNames = {
contains: (name: string): boolean => this.stores.has(name),
};

createObjectStore(name: string): FakeObjectStore {
const values = new Map<string, string>();
this.stores.set(name, values);
return new FakeObjectStore(values);
}

transaction(storeName: string): { objectStore: (name: string) => FakeObjectStore } {
return {
objectStore: (name: string) => {
if (name !== storeName) throw new Error(`unexpected store ${name}`);
const values = this.stores.get(name);
if (!values) throw new Error(`missing store ${name}`);
return new FakeObjectStore(values);
},
};
}
}

class FakeIndexedDBFactory {
private readonly databases = new Map<string, FakeDatabase>();

open(name: string): IDBOpenDBRequest {
const request = new FakeRequest<FakeDatabase>();
setTimeout(() => {
let db = this.databases.get(name);
const isNew = !db;
if (!db) {
db = new FakeDatabase();
this.databases.set(name, db);
}
request.result = db;
if (isNew) request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
request.onsuccess?.(new Event('success'));
}, 0);
return request as IDBOpenDBRequest;
}
}

describe('createMemoryAdapter', () => {
it('round-trips values and reports keys', async () => {
const adapter = createMemoryAdapter();
expect(await adapter.load('missing')).toBeNull();
await adapter.save('a', 'one');
await adapter.save('b', 'two');
expect(await adapter.load('a')).toBe('one');
expect(await adapter.keys?.()).toEqual(['a', 'b']);
await adapter.remove('a');
expect(await adapter.load('a')).toBeNull();
});
});

describe('createLocalStorageAdapter', () => {
afterEach(() => {
vi.unstubAllGlobals();
});

it('uses an injected Storage with a prefix', async () => {
const storage = new MemoryStorage();
const adapter = createLocalStorageAdapter({ storage, prefix: 'plim:' });
expect(await adapter.load('missing')).toBeNull();
await adapter.save('doc', 'snapshot');
expect(storage.getItem('plim:doc')).toBe('snapshot');
expect(await adapter.load('doc')).toBe('snapshot');
expect(await adapter.keys?.()).toEqual(['doc']);
await adapter.remove('doc');
expect(await adapter.load('doc')).toBeNull();
});

it('throws clearly when no storage is available', () => {
vi.stubGlobal('localStorage', undefined);
expect(() => createLocalStorageAdapter()).toThrow(/localStorage is not available/);
});
});

describe('createTransportAdapter', () => {
it('saves and loads through a transport peer', async () => {
const [client, server] = createMemoryTransportPair<StorageTransportMessage>();
const values = new Map<string, string>();
server.onMessage((message) => {
if (message.type === 'save') values.set(message.key, message.value);
if (message.type === 'remove') values.delete(message.key);
if (message.type === 'load') {
server.send({ type: 'loaded', key: message.key, id: message.id, value: values.get(message.key) ?? null });
}
});
const adapter = createTransportAdapter(client, { requestId: () => 'r1' });
await adapter.save('doc', 'snapshot');
expect(await adapter.load('doc')).toBe('snapshot');
await adapter.remove('doc');
expect(await adapter.load('doc')).toBeNull();
});

it('rejects loads that do not receive a matching response before timeout', async () => {
vi.useFakeTimers();
try {
const [client] = createMemoryTransportPair<StorageTransportMessage>();
const adapter = createTransportAdapter(client, { timeoutMs: 25, requestId: () => 'r1' });
const load = adapter.load('doc');
const assertion = expect(load).rejects.toThrow(/timed out loading/);
await vi.advanceTimersByTimeAsync(25);
await assertion;
} finally {
vi.useRealTimers();
}
});
});

describe('createIndexedDBAdapter', () => {
it('round-trips values through an injected IndexedDB factory', async () => {
const indexedDB = new FakeIndexedDBFactory() as unknown as IDBFactory;
const adapter = createIndexedDBAdapter({ dbName: 'test-db', storeName: 'docs', indexedDB });
expect(await adapter.load('missing')).toBeNull();
await adapter.save('doc', 'snapshot');
await adapter.save('other', 'value');
expect(await adapter.load('doc')).toBe('snapshot');
expect(await adapter.keys?.()).toEqual(['doc', 'other']);
await adapter.remove('doc');
expect(await adapter.load('doc')).toBeNull();
});
});
