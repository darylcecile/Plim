import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlimDriver, createBlock, defineAction, defineBlock, triggers } from '@plim/core';
import { contentFromMarkdown } from '@plim/markdown';
import { PlimEditor, useAsyncEventListener, useEditorHandle } from '@plim/react';
import './styles.css';

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const handle = useEditorHandle();
  const plim = useMemo(
    () =>
      new PlimDriver({
        theme: 'notion-light',
        registeredBlocks: [
          defineBlock({ name: 'paragraph' }),
          defineBlock({ name: 'heading2' }),
          defineBlock({ name: 'bulletedList' }),
          defineBlock({ name: 'quote' })
        ],
        registeredActions: [
          defineAction('slashCommand', {
            trigger: triggers.keyboard.character('/'),
            triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
            cancellationTriggers: [triggers.keyboard.key('Escape')],
            perform: (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu')
          })
        ]
      }),
    []
  );
  const slashListener = useAsyncEventListener('showSlashCommandMenu', async () => {
    const activeBlock = document.querySelector<HTMLElement>('[data-plim-block-content="true"]:focus');
    const rect = activeBlock?.getBoundingClientRect();
    setMenuPosition({
      left: rect ? rect.left : window.innerWidth / 2 - 140,
      top: rect ? rect.bottom + 6 : 160
    });
    setMenuOpen(true);
  });
  const asyncEventListeners = useMemo(() => [slashListener], [slashListener]);

  const initialContent = useMemo(
    () =>
      contentFromMarkdown(
        '# React workspace',
        '',
        'Compose with the same PlimDriver API from React.',
        '## Launch checklist',
        '- Wire custom menus with hooks',
        '- Keep the editor handle for commands',
        '> The React component owns the container while Plim owns document state.'
      ),
    []
  );

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, []);

  const insertBlock = (type: string) => {
    const state = handle.current?.getState();
    const selection = state?.selection;
    const activeBlock =
      state && selection && selection.kind !== 'block'
        ? state.content.blocks.find((candidate) => candidate.id === selection.blockId)
        : state?.content.blocks.at(-1);
    void handle.current?.dispatch(
      [{ op: 'insertBlock', block: createBlock(type, ''), ...(activeBlock ? { afterBlockId: activeBlock.id } : {}) }],
      { kind: 'command', commandId: `insert-${type}` }
    );
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      <section className="page">
        <div className="page-cover" aria-hidden="true" />
        <div className="editor-card">
          <div className="react-toolbar" aria-label="Editor toolbar">
            <button type="button" onClick={() => insertBlock('paragraph')}>
              + Text
            </button>
            <button type="button" onClick={() => insertBlock('heading2')}>
              + Heading
            </button>
            <button type="button" onClick={() => insertBlock('quote')}>
              + Quote
            </button>
          </div>
          <PlimEditor
            plim={plim}
            handle={handle}
            initialContent={initialContent}
            asyncEventListeners={asyncEventListeners}
            autoFocus
          />
        </div>
      </section>
      <aside className="slash-menu" hidden={!menuOpen} style={{ left: menuPosition.left, top: menuPosition.top }}>
        <header>Basic blocks</header>
        <button type="button" onClick={() => insertBlock('paragraph')}>
          <span>¶</span>
          <span>Text</span>
        </button>
        <button type="button" onClick={() => insertBlock('heading2')}>
          <span>H2</span>
          <span>Heading</span>
        </button>
        <button type="button" onClick={() => insertBlock('quote')}>
          <span>❝</span>
          <span>Quote</span>
        </button>
      </aside>
    </div>
  );
}

createRoot(document.querySelector<HTMLDivElement>('#root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
