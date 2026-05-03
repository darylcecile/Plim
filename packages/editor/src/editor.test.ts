// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PlimDriver, createBlock, createContent, defineAction, triggers } from '@plim/core';
import { attachContainer, deriveEditor } from './index.ts';

describe('@plim/editor', () => {
  it('renders a vanilla editor and dispatches transactions', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([createBlock('paragraph', 'Start')], 'My page')
    });
    const transactions: string[] = [];
    editor.onTransaction((transaction) => transactions.push(transaction.id));

    await editor.dispatch([{ op: 'insertBlock', block: createBlock('paragraph', 'Next') }]);

    expect(editor.isReady).toBe(true);
    expect(root.querySelector('[data-plim-title="true"]')?.textContent).toBe('My page');
    expect(root.textContent).toContain('Next');
    expect(transactions).toHaveLength(1);
  });

  it('routes matching triggers through actions and async events', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const driver = new PlimDriver({
      registeredActions: [
        defineAction('slashCommand', {
          trigger: triggers.keyboard.character('/'),
          perform: (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu', { query: '' })
        })
      ]
    });
    const editor = deriveEditor(driver, {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([createBlock('paragraph', '')])
    });
    const eventNames: string[] = [];
    editor.onAsyncEvent('showSlashCommandMenu', async (event) => eventNames.push(event.name));

    await editor.dispatchTrigger(triggers.keyboard.character('/'));

    expect(eventNames).toEqual(['showSlashCommandMenu']);
  });

  it('restores snapshots', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([createBlock('paragraph', 'Before')])
    });
    const snapshot = new (await import('@plim/core')).Snapshot(editor);
    await editor.dispatch([{ op: 'replaceContent', content: createContent([createBlock('paragraph', 'After')]) }]);
    editor.restoreSnapshot(snapshot);

    expect(editor.getState().content.blocks[0]?.text).toBe('Before');
  });

  it('splits blocks on Enter and restores the caret in the new block', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const block = createBlock('paragraph', 'Hello world');
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([block])
    });
    const content = root.querySelector<HTMLElement>('[data-plim-block-content="true"]')!;
    setDomSelection(content, 5);

    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();

    expect(editor.getState().content.blocks.map((candidate) => candidate.text)).toEqual(['Hello', ' world']);
    expect(document.activeElement).toBe(root.querySelectorAll('[data-plim-block-content="true"]')[1]);
    expect(editor.getState().selection).toMatchObject({ kind: 'caret', offset: 0 });
  });

  it('moves focus between adjacent single-line blocks with arrow keys without jumping offsets', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const first = createBlock('paragraph', 'First');
    const second = createBlock('paragraph', 'Second');
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([first, second])
    });
    const blocks = root.querySelectorAll<HTMLElement>('[data-plim-block-content="true"]');
    setDomSelection(blocks[0]!, 2);

    blocks[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await tick();

    expect(document.activeElement).toBe(root.querySelectorAll('[data-plim-block-content="true"]')[1]);
    expect(editor.getState().selection).toMatchObject({ kind: 'caret', blockId: second.id, offset: 2 });

    root.querySelectorAll<HTMLElement>('[data-plim-block-content="true"]')[1]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    );
    await tick();

    expect(document.activeElement).toBe(root.querySelectorAll('[data-plim-block-content="true"]')[0]);
    expect(editor.getState().selection).toMatchObject({ kind: 'caret', blockId: first.id, offset: 2 });
  });

  it('reorders blocks by dragging the block handle', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const first = createBlock('paragraph', 'First');
    const second = createBlock('paragraph', 'Second');
    const third = createBlock('paragraph', 'Third');
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([first, second, third])
    });
    const transfer = fakeDataTransfer();
    const handle = root.querySelector<HTMLElement>('.plim-block-handle')!;
    const target = root.querySelectorAll<HTMLElement>('.plim-block')[1]!;

    handle.dispatchEvent(withDragData(new Event('dragstart', { bubbles: true, cancelable: true }), transfer));
    target.dispatchEvent(withDragData(new Event('drop', { bubbles: true, cancelable: true }), transfer, 1));
    await tick();

    expect(editor.getState().content.blocks.map((block) => block.text)).toEqual(['Second', 'First', 'Third']);
  });

  it('normalizes formatted external paste into blocks and marks', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const block = createBlock('paragraph', 'Start');
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([block])
    });
    const content = root.querySelector<HTMLElement>('[data-plim-block-content="true"]')!;
    setDomSelection(content, block.text.length);
    const clipboard = fakeDataTransfer({
      'text/html': '<p>Intro <strong>bold</strong></p><blockquote>Quote</blockquote>',
      'text/plain': 'Intro bold\nQuote'
    });

    content.dispatchEvent(withClipboardData(new Event('paste', { bubbles: true, cancelable: true }), clipboard));
    await tick();

    const blocks = editor.getState().content.blocks;
    expect(blocks.map((candidate) => [candidate.type, candidate.text])).toEqual([
      ['paragraph', 'StartIntro bold'],
      ['quote', 'Quote']
    ]);
    expect(blocks[0]?.marks).toContainEqual({ mark: 'bold', from: 11, to: 15 });
  });

  it('copies focused blocks using the Plim clipboard payload and pastes them as blocks', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const first = createBlock('paragraph', 'Copied');
    const second = createBlock('paragraph', 'Target');
    const editor = deriveEditor(new PlimDriver(), {
      containerAdapter: attachContainer(() => root),
      initialContent: createContent([first, second])
    });
    const blocks = root.querySelectorAll<HTMLElement>('[data-plim-block-content="true"]');
    const clipboard = fakeDataTransfer();

    setDomSelection(blocks[0]!, 0);
    blocks[0]!.dispatchEvent(withClipboardData(new Event('copy', { bubbles: true, cancelable: true }), clipboard));
    setDomSelection(blocks[1]!, second.text.length);
    blocks[1]!.dispatchEvent(withClipboardData(new Event('paste', { bubbles: true, cancelable: true }), clipboard));
    await tick();

    expect(editor.getState().content.blocks.map((block) => block.text)).toEqual(['Copied', 'Target', 'Copied']);
  });
});

function setDomSelection(element: HTMLElement, offset: number): void {
  element.focus();
  const range = document.createRange();
  const textNode = element.firstChild ?? element.appendChild(document.createTextNode(''));
  range.setStart(textNode, Math.min(offset, textNode.textContent?.length ?? 0));
  range.collapse(true);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

function fakeDataTransfer(initial: Record<string, string> = {}): DataTransfer {
  const data = new Map(Object.entries(initial));
  const transfer = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [...data.keys()],
    clearData: (format?: string) => {
      if (format) {
        data.delete(format);
      } else {
        data.clear();
      }
    },
    getData: (format: string) => data.get(format) ?? '',
    setData: (format: string, value: string) => {
      data.set(format, value);
      transfer.types = [...data.keys()];
    },
    setDragImage: () => undefined
  };
  return transfer as DataTransfer;
}

function withClipboardData<T extends Event>(event: T, clipboardData: DataTransfer): T {
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  return event;
}

function withDragData<T extends Event>(event: T, dataTransfer: DataTransfer, clientY = 0): T {
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  return event;
}

async function tick(): Promise<void> {
  await Promise.resolve();
}
