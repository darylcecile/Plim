import type { StorageAdapter } from './adapter.js';

export interface LocalStorageAdapterOptions {
storage?: Storage;
prefix?: string;
}

export function createLocalStorageAdapter(options: LocalStorageAdapterOptions = {}): StorageAdapter {
const storage = options.storage ?? globalThis.localStorage;
if (!storage) {
throw new Error('@plim/storage: localStorage is not available. Pass { storage } to createLocalStorageAdapter() or choose another adapter for this environment.');
}
const prefix = options.prefix ?? '';
const toStorageKey = (key: string): string => `${prefix}${key}`;
const fromStorageKey = (key: string): string => key.slice(prefix.length);

return {
async load(key) {
return storage.getItem(toStorageKey(key));
},
async save(key, value) {
storage.setItem(toStorageKey(key), value);
},
async remove(key) {
storage.removeItem(toStorageKey(key));
},
async keys() {
const keys: string[] = [];
for (let i = 0; i < storage.length; i++) {
const key = storage.key(i);
if (key?.startsWith(prefix)) keys.push(fromStorageKey(key));
}
return keys;
},
};
}
