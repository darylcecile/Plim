import { Snapshot } from '@plim/core';
import type { EditorState } from '@plim/core';
import type { StorageAdapter } from './adapter.js';

export type PersistableEditor = {
getState(): EditorState;
onTransaction(cb: (...args: any[]) => void): () => void;
restoreSnapshot(snap: Snapshot): void;
};

export interface AutosaveOptions {
editor: PersistableEditor;
adapter: StorageAdapter;
key: string;
debounceMs?: number;
serialize?: (editor: PersistableEditor) => string;
onSave?: (value: string) => void;
onError?: (err: unknown) => void;
saveOnStart?: boolean;
}

export interface Autosave {
saveNow(): Promise<void>;
flush(): Promise<void>;
load(): Promise<boolean>;
stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 800;

export function createAutosave(options: AutosaveOptions): Autosave {
const { editor, adapter, key } = options;
const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
const serialize = options.serialize ?? ((persistableEditor: PersistableEditor) => new Snapshot(persistableEditor).serialize());
let timer: ReturnType<typeof setTimeout> | null = null;
let pending = false;
let stopped = false;

const cancel = (): void => {
if (timer) clearTimeout(timer);
timer = null;
};

const handleError = (error: unknown): void => {
options.onError?.(error);
};

const performSave = async (): Promise<void> => {
if (stopped) return;
cancel();
pending = false;
try {
const value = serialize(editor);
await adapter.save(key, value);
options.onSave?.(value);
} catch (error) {
handleError(error);
throw error;
}
};

const schedule = (): void => {
if (stopped) return;
pending = true;
cancel();
timer = setTimeout(() => {
void performSave().catch(() => {});
}, debounceMs);
};

const unsubscribe = editor.onTransaction(schedule);

if (options.saveOnStart === true) {
void performSave().catch(() => {});
}

return {
async saveNow() {
await performSave();
},
async flush() {
if (!pending || stopped) return;
await performSave();
},
async load() {
try {
const value = await adapter.load(key);
if (value === null) return false;
editor.restoreSnapshot(Snapshot.deserialize(value));
return true;
} catch (error) {
handleError(error);
throw error;
}
},
stop() {
if (stopped) return;
stopped = true;
cancel();
pending = false;
unsubscribe();
},
};
}
