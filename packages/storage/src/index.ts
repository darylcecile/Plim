export type { DocumentStore, StorageAdapter } from './adapter.js';
export { createDocumentStore } from './adapter.js';
export { createAutosave } from './autosave.js';
export type { Autosave, AutosaveOptions, PersistableEditor } from './autosave.js';
export { createIndexedDBAdapter } from './indexed-db.js';
export type { IndexedDBAdapterOptions } from './indexed-db.js';
export { createLocalStorageAdapter } from './local-storage.js';
export type { LocalStorageAdapterOptions } from './local-storage.js';
export { createMemoryAdapter } from './memory.js';
export { createTransportAdapter } from './transport-adapter.js';
export type {
StorageTransportLoadedMessage,
StorageTransportLoadMessage,
StorageTransportMessage,
StorageTransportRemoveMessage,
StorageTransportSaveMessage,
TransportAdapterOptions,
} from './transport-adapter.js';
