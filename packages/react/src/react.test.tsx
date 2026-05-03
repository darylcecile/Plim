// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PlimDriver, createBlock, createContent, defineAction, triggers } from '@plim/core';
import { PlimEditor, useAsyncEventListener, useEditorHandle } from './index.ts';

describe('@plim/react', () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it('mounts the managed editor and exposes the handle', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const driver = new PlimDriver();

    function TestEditor() {
      const handle = useEditorHandle();
      return createElement(PlimEditor, {
        plim: driver,
        handle,
        initialContent: createContent([createBlock('paragraph', 'React block')], 'React page')
      });
    }

    await act(async () => {
      root.render(createElement(TestEditor));
    });

    expect(host.textContent).toContain('React page');
    expect(host.textContent).toContain('React block');
    await act(async () => {
      root.unmount();
    });
  });

  it('registers async event listeners from hooks', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const seen: string[] = [];
    const driver = new PlimDriver({
      registeredActions: [
        defineAction('slashCommand', {
          trigger: triggers.keyboard.character('/'),
          perform: (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu')
        })
      ]
    });

    function TestEditor() {
      const handle = useEditorHandle();
      const listener = useAsyncEventListener('showSlashCommandMenu', async (event) => {
        seen.push(event.name);
      });
      Object.assign(globalThis, { plimTestHandle: handle });
      return createElement(PlimEditor, {
        plim: driver,
        handle,
        initialContent: createContent([createBlock('paragraph', '')]),
        asyncEventListeners: [listener]
      });
    }

    await act(async () => {
      root.render(createElement(TestEditor));
    });
    const handle = (globalThis as typeof globalThis & { plimTestHandle: ReturnType<typeof useEditorHandle> }).plimTestHandle;
    await act(async () => {
      await handle.current?.dispatchTrigger(triggers.keyboard.character('/'));
    });

    expect(seen).toEqual(['showSlashCommandMenu']);
    await act(async () => {
      root.unmount();
    });
  });

  it('inherits block keyboard editing from the agnostic editor', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const driver = new PlimDriver();
    const block = createBlock('paragraph', 'React split');

    await act(async () => {
      root.render(
        createElement(PlimEditor, {
          plim: driver,
          initialContent: createContent([block])
        })
      );
    });

    const content = host.querySelector<HTMLElement>('[data-plim-block-content="true"]')!;
    setDomSelection(content, 5);
    await act(async () => {
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(host.querySelectorAll('[data-plim-block-content="true"]')).toHaveLength(2);
    expect(host.textContent).toContain('React');
    expect(host.textContent).toContain(' split');
    await act(async () => {
      root.unmount();
    });
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
