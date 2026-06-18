import { Snapshot, type EditorState } from '@plim/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, createMemoryAdapter, type PersistableEditor, type StorageAdapter } from '@plim/storage';

class StubEditor implements PersistableEditor {
private listeners = new Set<() => void>();
restored: Snapshot | null = null;

constructor(private state: EditorState) {}

getState(): EditorState {
return this.state;
}

onTransaction(cb: () => void): () => void {
this.listeners.add(cb);
return () => this.listeners.delete(cb);
}

restoreSnapshot(snap: Snapshot): void {
this.restored = snap;
this.state = snap.data.state;
}

replaceText(text: string): void {
this.state = stateWithText(text);
for (const listener of [...this.listeners]) listener();
}
}

function stateWithText(text: string): EditorState {
return {
doc: { type: 'doc', children: [{ id: 'p1', type: 'paragraph', text: [{ text }] }] },
selection: { anchor: { path: [0], offset: text.length }, head: { path: [0], offset: text.length } },
};
}

function textFromState(state: EditorState): string {
return state.doc.children[0]?.text?.[0]?.text ?? '';
}

afterEach(() => {
vi.useRealTimers();
});

describe('createAutosave', () => {
it('debounces one transaction into one save', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const adapter = createMemoryAdapter();
const save = vi.spyOn(adapter, 'save');
createAutosave({ editor, adapter, key: 'doc', debounceMs: 50 });
editor.replaceText('changed');
expect(save).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(50);
expect(save).toHaveBeenCalledTimes(1);
expect(JSON.parse((await adapter.load('doc')) ?? '{}').state.doc.children[0].text[0].text).toBe('changed');
});

it('coalesces rapid transactions into one save', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const adapter = createMemoryAdapter();
const save = vi.spyOn(adapter, 'save');
createAutosave({ editor, adapter, key: 'doc', debounceMs: 50 });
editor.replaceText('one');
await vi.advanceTimersByTimeAsync(25);
editor.replaceText('two');
await vi.advanceTimersByTimeAsync(49);
expect(save).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(save).toHaveBeenCalledTimes(1);
expect(JSON.parse((await adapter.load('doc')) ?? '{}').state.doc.children[0].text[0].text).toBe('two');
});

it('saveNow bypasses and cancels the debounce', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const adapter = createMemoryAdapter();
const save = vi.spyOn(adapter, 'save');
const autosave = createAutosave({ editor, adapter, key: 'doc', debounceMs: 50 });
editor.replaceText('now');
await autosave.saveNow();
expect(save).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(50);
expect(save).toHaveBeenCalledTimes(1);
});

it('flush saves a pending debounce immediately', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const adapter = createMemoryAdapter();
const save = vi.spyOn(adapter, 'save');
const autosave = createAutosave({ editor, adapter, key: 'doc', debounceMs: 50 });
editor.replaceText('flush');
await autosave.flush();
expect(save).toHaveBeenCalledTimes(1);
});

it('loads an existing snapshot into the editor', async () => {
const source = new Snapshot(stateWithText('saved'));
const editor = new StubEditor(stateWithText('empty'));
const adapter = createMemoryAdapter();
await adapter.save('doc', source.serialize());
const autosave = createAutosave({ editor, adapter, key: 'doc' });
await expect(autosave.load()).resolves.toBe(true);
expect(editor.restored).toBeInstanceOf(Snapshot);
expect(textFromState(editor.getState())).toBe('saved');
});

it('reports false when load finds no data', async () => {
const editor = new StubEditor(stateWithText('empty'));
const adapter = createMemoryAdapter();
const autosave = createAutosave({ editor, adapter, key: 'doc' });
await expect(autosave.load()).resolves.toBe(false);
});

it('stop prevents later saves', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const adapter = createMemoryAdapter();
const save = vi.spyOn(adapter, 'save');
const autosave = createAutosave({ editor, adapter, key: 'doc', debounceMs: 50 });
autosave.stop();
editor.replaceText('ignored');
await vi.advanceTimersByTimeAsync(50);
expect(save).not.toHaveBeenCalled();
});

it('routes save errors to onError', async () => {
vi.useFakeTimers();
const editor = new StubEditor(stateWithText('start'));
const error = new Error('save failed');
const onError = vi.fn();
const adapter: StorageAdapter = {
load: async () => null,
save: async () => {
throw error;
},
remove: async () => {},
};
createAutosave({ editor, adapter, key: 'doc', debounceMs: 50, onError });
editor.replaceText('boom');
await vi.advanceTimersByTimeAsync(50);
expect(onError).toHaveBeenCalledWith(error);
});
});
