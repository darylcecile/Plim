import type { StorageAdapter } from './adapter.js';

export interface IndexedDBAdapterOptions {
dbName?: string;
storeName?: string;
indexedDB?: IDBFactory;
}

const DEFAULT_DB_NAME = 'plim-storage';
const DEFAULT_STORE_NAME = 'snapshots';

export function createIndexedDBAdapter(options: IndexedDBAdapterOptions = {}): StorageAdapter {
const factory = options.indexedDB ?? globalThis.indexedDB;
if (!factory) {
throw new Error('@plim/storage: indexedDB is not available. Pass { indexedDB } to createIndexedDBAdapter() or choose another adapter for this environment.');
}
const dbName = options.dbName ?? DEFAULT_DB_NAME;
const storeName = options.storeName ?? DEFAULT_STORE_NAME;
const dbPromise = openDatabase(factory, dbName, storeName);

return {
async load(key) {
const db = await dbPromise;
return requestToPromise<string | undefined>(db.transaction(storeName, 'readonly').objectStore(storeName).get(key)).then((value) => value ?? null);
},
async save(key, value) {
const db = await dbPromise;
await requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key));
},
async remove(key) {
const db = await dbPromise;
await requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
},
async keys() {
const db = await dbPromise;
const keys = await requestToPromise<IDBValidKey[]>(db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys());
return keys.filter((key): key is string => typeof key === 'string');
},
};
}

function openDatabase(factory: IDBFactory, dbName: string, storeName: string): Promise<IDBDatabase> {
return new Promise((resolve, reject) => {
const request = factory.open(dbName, 1);
request.onupgradeneeded = () => {
const db = request.result;
if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
};
request.onerror = () => reject(request.error ?? new Error('@plim/storage: failed to open IndexedDB database'));
request.onsuccess = () => resolve(request.result);
});
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
return new Promise((resolve, reject) => {
request.onerror = () => reject(request.error ?? new Error('@plim/storage: IndexedDB request failed'));
request.onsuccess = () => resolve(request.result);
});
}
