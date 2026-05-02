import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createIdFactory, plainTextFromRichText } from '@plim/model';
import {
  PlimEditor,
  createHostPersistenceAdapter,
  createMemoryPersistenceAdapter,
  createPlimReactEditor
} from '../src/index.js';

const fixedClock = { now: () => '2026-05-01T00:00:00.000Z' };

describe('@plim/react', () => {
  it('creates an uncontrolled editor and applies block commands', async () => {
    const idFactory = createIdFactory({ seed: 'react-uncontrolled' });
    const document = createEmptyDocument({ idFactory, clock: fixedClock, title: 'React' });
    const editor = createPlimReactEditor({ defaultDocument: document, idFactory, clock: fixedClock });
    const rootPageId = document.workspace.rootPageIds[0]!;

    const result = await editor.executeCommand('plim.insertBlock', { parentId: rootPageId, type: 'paragraph', text: 'Hello from React' });

    expect(result.status).toBe('handled');
    const children = editor.getSnapshot().document.blocks[rootPageId]?.children ?? [];
    expect(children).toHaveLength(1);
    const child = editor.getSnapshot().document.blocks[children[0]!]!;
    expect(child.type).toBe('paragraph');
    expect(plainTextFromRichText(child.type === 'paragraph' ? child.data.richText : [])).toBe('Hello from React');
  });

  it('supports strict controlled transactions and host acceptance', async () => {
    const idFactory = createIdFactory({ seed: 'react-controlled' });
    const document = createEmptyDocument({ idFactory, clock: fixedClock });
    const editor = createPlimReactEditor({ document, mode: 'controlled', controlledPolicy: 'strict', idFactory, clock: fixedClock });
    const rootPageId = document.workspace.rootPageIds[0]!;

    const result = await editor.executeCommand('plim.insertBlock', { parentId: rootPageId, type: 'paragraph', text: 'Pending' });

    expect(result.status).toBe('pending');
    expect(editor.getSnapshot().document.blocks[rootPageId]?.children).toEqual([]);
    expect(result.transaction).toBeDefined();
    editor.acceptTransaction(result.transaction!.id, editor.getSnapshot().document);
    expect(editor.getSnapshot().pendingTransactionIds).toEqual([]);
  });

  it('persists snapshots through memory and host adapters', async () => {
    const memory = createMemoryPersistenceAdapter();
    const document = createEmptyDocument({ idFactory: createIdFactory({ seed: 'persist' }), clock: fixedClock });
    await memory.save('doc', { object: 'plim_persisted_snapshot', document, version: 1, savedAt: fixedClock.now(), dirty: false });
    await expect(memory.load('doc')).resolves.toMatchObject({ object: 'plim_persisted_snapshot', version: 1 });

    let saved = false;
    const host = createHostPersistenceAdapter({ save: () => { saved = true; } });
    await host.save('doc', { object: 'plim_persisted_snapshot', document, version: 2, savedAt: fixedClock.now(), dirty: true });
    expect(saved).toBe(true);
  });

  it('creates React elements without requiring a DOM backend', () => {
    const element = React.createElement(PlimEditor, { readOnly: true, ariaLabel: 'Notes' });
    expect(element.type).toBe(PlimEditor);
    expect(element.props).toMatchObject({ readOnly: true, ariaLabel: 'Notes' });
  });
});
