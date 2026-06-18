export interface StorageAdapter {
load(key: string): Promise<string | null>;
save(key: string, value: string): Promise<void>;
remove(key: string): Promise<void>;
keys?(): Promise<string[]>;
}

export type DocumentStore = {
load(): Promise<string | null>;
save(value: string): Promise<void>;
remove(): Promise<void>;
};

export function createDocumentStore(options: { adapter: StorageAdapter; key: string }): DocumentStore {
const { adapter, key } = options;
return {
load: () => adapter.load(key),
save: (value) => adapter.save(key, value),
remove: () => adapter.remove(key),
};
}
