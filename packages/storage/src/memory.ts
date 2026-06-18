import type { StorageAdapter } from './adapter.js';

export function createMemoryAdapter(): StorageAdapter {
const values = new Map<string, string>();
return {
async load(key) {
return values.get(key) ?? null;
},
async save(key, value) {
values.set(key, value);
},
async remove(key) {
values.delete(key);
},
async keys() {
return [...values.keys()];
},
};
}
