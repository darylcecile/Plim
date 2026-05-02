import { describe, expect, it } from 'vitest';
import {
  applyTransaction,
  createBlock,
  createEmptyDocument,
  createIdFactory,
  createParagraphBlock,
  createTransaction,
  getBlockIndex,
  normalizeRichText,
  plainTextFromRichText,
  richTextFromPlainText,
  serializeDocument,
  stringifyDocument,
  TITLE_PROPERTY_ID,
  validateDocumentState
} from '../src/index.js';

const fixedClock = { now: () => '2026-05-01T00:00:00.000Z' };

describe('@plim/model', () => {
  it('creates a valid deterministic empty document', () => {
    const idFactory = createIdFactory({ seed: 'spec' });
    const state = createEmptyDocument({ idFactory, clock: fixedClock, title: 'Home' });
    const validation = validateDocumentState(state, { normalize: true });

    expect(validation.ok).toBe(true);
    expect(state.workspace.rootPageIds).toHaveLength(1);
    const page = state.pages[state.workspace.rootPageIds[0]!]!;
    const title = page.properties[TITLE_PROPERTY_ID];
    expect(title?.type).toBe('title');
    expect(plainTextFromRichText(title?.type === 'title' ? title.title : [])).toBe('Home');
  });

  it('applies create and insert block operations atomically', () => {
    const idFactory = createIdFactory({ seed: 'ops' });
    const state = createEmptyDocument({ idFactory, clock: fixedClock });
    const rootPageId = state.workspace.rootPageIds[0]!;
    const paragraph = createParagraphBlock({
      workspaceId: state.workspace.id,
      parent: { kind: 'page', pageId: rootPageId },
      text: 'Hello',
      idFactory,
      clock: fixedClock
    });
    const tx = createTransaction({
      workspaceId: state.workspace.id,
      clientId: 'test',
      idFactory,
      clock: fixedClock,
      operations: [
        { op: 'create_block', block: paragraph },
        { op: 'insert_child', parentId: rootPageId, childId: paragraph.id, at: { kind: 'append' } }
      ]
    });

    const result = applyTransaction(state, tx, { clock: fixedClock });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.blocks[rootPageId]?.children).toEqual([paragraph.id]);
      expect(getBlockIndex(result.state, paragraph.id)).toBe(0);
      expect(validateDocumentState(result.state).ok).toBe(true);
    }
  });

  it('normalizes adjacent rich text spans and serializes deterministically', () => {
    const richText = normalizeRichText([
      ...richTextFromPlainText('Hel'),
      ...richTextFromPlainText('lo')
    ]);
    expect(richText).toHaveLength(1);
    expect(plainTextFromRichText(richText)).toBe('Hello');

    const state = createEmptyDocument({ idFactory: createIdFactory({ seed: 'json' }), clock: fixedClock });
    const first = stringifyDocument(serializeDocument(state), 0);
    const second = stringifyDocument(serializeDocument(state), 0);
    expect(first).toBe(second);
  });

  it('rejects invalid structural cycles without mutating input', () => {
    const idFactory = createIdFactory({ seed: 'cycle' });
    const state = createEmptyDocument({ idFactory, clock: fixedClock });
    const rootPageId = state.workspace.rootPageIds[0]!;
    const child = createBlock({
      workspaceId: state.workspace.id,
      parent: { kind: 'page', pageId: rootPageId },
      type: 'toggle',
      idFactory,
      clock: fixedClock
    });
    const created = applyTransaction(state, createTransaction({
      workspaceId: state.workspace.id,
      clientId: 'test',
      idFactory,
      clock: fixedClock,
      operations: [
        { op: 'create_block', block: child },
        { op: 'insert_child', parentId: rootPageId, childId: child.id, at: { kind: 'append' } }
      ]
    }), { clock: fixedClock });

    expect(created.ok).toBe(true);
    if (created.ok) {
      const invalid = applyTransaction(created.state, createTransaction({
        workspaceId: state.workspace.id,
        clientId: 'test',
        idFactory,
        clock: fixedClock,
        operations: [
          { op: 'move_block', blockId: rootPageId, newParentId: child.id, at: { kind: 'append' } }
        ]
      }), { clock: fixedClock });
      expect(invalid.ok).toBe(false);
      expect(created.state.blocks[rootPageId]?.children).toEqual([child.id]);
    }
  });
});
