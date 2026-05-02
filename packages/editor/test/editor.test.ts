import { describe, expect, it } from 'vitest';
import {
  createEditor,
  createIdFactory,
  createParagraphBlock,
  plainTextFromRichText,
  type BlockId,
  type DocumentState,
  type EditorEvent,
  type Operation,
  type PersistenceAdapter,
  type RichTextBlockData,
  type ValidationIssue
} from '../src/index.js';

const fixedClock = { now: () => '2026-05-01T00:00:00.000Z' };

function paragraphText(state: DocumentState, blockId: BlockId): string {
  const block = state.blocks[blockId];
  if (!block || !('richText' in block.data)) return '';
  return plainTextFromRichText((block.data as RichTextBlockData).richText);
}

function insertParagraphOperation(editorDocument: DocumentState, text: string): Operation[] {
  const idFactory = createIdFactory({ seed: `paragraph-${text}` });
  const rootPageId = editorDocument.workspace.rootPageIds[0]!;
  const paragraph = createParagraphBlock({
    workspaceId: editorDocument.workspace.id,
    parent: { kind: 'page', pageId: rootPageId },
    text,
    idFactory,
    clock: fixedClock
  });
  return [
    { op: 'create_block', block: paragraph },
    { op: 'insert_child', parentId: rootPageId, childId: paragraph.id, at: { kind: 'append' } }
  ];
}

describe('@plim/editor runtime', () => {
  it('creates an immutable valid editor state with model exports available', () => {
    const editor = createEditor({ idFactory: createIdFactory({ seed: 'create' }), clock: fixedClock });

    expect(editor.state.status.state).toBe('ready');
    expect(editor.rootPageId).toBe(editor.state.document.workspace.rootPageIds[0]);
    expect(Object.isFrozen(editor.state)).toBe(true);
    expect(Object.isFrozen(editor.state.document)).toBe(true);

    const imported = createEditor({ idFactory: createIdFactory({ seed: 'import' }), clock: fixedClock });
    const importResult = imported.importSnapshot(editor.exportSnapshot());
    expect(importResult.ok).toBe(true);
    expect(imported.rootPageId).toBe(editor.rootPageId);
  });

  it('dispatches model operations atomically and emits change events', async () => {
    const editor = createEditor({ idFactory: createIdFactory({ seed: 'dispatch' }), clock: fixedClock });
    const changes: EditorEvent[] = [];
    const off = editor.on('change', event => changes.push(event));

    const result = await editor.dispatch(insertParagraphOperation(editor.state.document, 'Hello'));

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    const childId = editor.state.document.blocks[editor.rootPageId]?.children[0]!;
    expect(paragraphText(editor.state.document, childId)).toBe('Hello');
    expect(changes).toHaveLength(1);

    off();
    await editor.dispatch(insertParagraphOperation(editor.state.document, 'Ignored by listener'));
    expect(changes).toHaveLength(1);
  });

  it('executes registered commands through the transaction pipeline', async () => {
    const editor = createEditor({ idFactory: createIdFactory({ seed: 'command' }), clock: fixedClock });

    const result = await editor.executeCommand('block.insertParagraph', { text: 'From command' });

    expect(result.ok).toBe(true);
    const childId = editor.state.document.blocks[editor.rootPageId]?.children[0]!;
    expect(paragraphText(editor.state.document, childId)).toBe('From command');
  });

  it('supports undo and redo with deterministic snapshots', async () => {
    const editor = createEditor({ idFactory: createIdFactory({ seed: 'history' }), clock: fixedClock });
    await editor.executeCommand('block.insertParagraph', { text: 'Undo me' });
    const childId = editor.state.document.blocks[editor.rootPageId]?.children[0]!;

    expect(editor.canUndo()).toBe(true);
    const undo = await editor.undo();
    expect(undo.ok).toBe(true);
    expect(editor.state.document.blocks[editor.rootPageId]?.children).toEqual([]);

    const redo = await editor.redo();
    expect(redo.ok).toBe(true);
    expect(editor.state.document.blocks[editor.rootPageId]?.children).toEqual([childId]);
  });

  it('rejects validation failures without mutating committed state', async () => {
    const issue: ValidationIssue = {
      severity: 'error',
      code: 'schema_mismatch',
      message: 'forced failure',
      path: 'document',
      fix: 'manual'
    };
    const editor = createEditor({
      idFactory: createIdFactory({ seed: 'validation' }),
      clock: fixedClock,
      validators: [() => [issue]]
    });
    const beforeVersion = editor.state.version;
    const rejectedEvents: EditorEvent[] = [];
    editor.on('transaction:rejected', event => rejectedEvents.push(event));

    const result = await editor.dispatch(insertParagraphOperation(editor.state.document, 'No commit'));

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([issue]);
    expect(editor.state.version).toBe(beforeVersion);
    expect(editor.state.document.blocks[editor.rootPageId]?.children).toEqual([]);
    expect(rejectedEvents).toHaveLength(1);
  });

  it('surfaces persistence adapter failures while keeping edits dirty in memory', async () => {
    const adapter: PersistenceAdapter = {
      id: 'failing-test-adapter',
      capabilities: { durable: true, async: true },
      async load() {
        return null;
      },
      async save() {
        throw new Error('disk unavailable');
      }
    };
    const editor = createEditor({
      idFactory: createIdFactory({ seed: 'persistence' }),
      clock: fixedClock,
      persistence: adapter,
      persistenceKey: 'test-key'
    });
    const persistenceEvents: EditorEvent[] = [];
    editor.on('persistence', event => persistenceEvents.push(event));

    const result = await editor.executeCommand('block.insertParagraph', { text: 'Dirty' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.transaction?.ok && result.transaction.persistenceError?.code).toBe('persistence_failed');
    expect(editor.state.dirty).toBe(true);
    expect(persistenceEvents.some(event => event.type === 'persistence' && event.status === 'failed')).toBe(true);
  });
});
