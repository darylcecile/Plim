import { PlimDriver, createBlock, defineAction, defineBlock, defineMark, triggers } from '@plim/core';
import { attachContainer, deriveEditor } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';
import './styles.css';

const persisted = localStorage.getItem('plim.basic.snapshot');
const initialContent = persisted
  ? JSON.parse(persisted)
  : contentFromMarkdown(
      '# Plim notes',
      '',
      'A lightweight, block-first editor inspired by Notion.',
      '## Today',
      '- Draft the public API',
      '- Try the slash command menu',
      '> Hover a block to reveal add and handle controls.'
    );

const paragraphBlock = defineBlock({ name: 'paragraph' });
const headingBlock = defineBlock({ name: 'heading2' });
const bulletBlock = defineBlock({ name: 'bulletedList' });
const quoteBlock = defineBlock({ name: 'quote' });
const boldMark = defineMark({ name: 'bold' });
const italicMark = defineMark({ name: 'italic' });

const plim = new PlimDriver({
  theme: 'notion-light',
  registeredBlocks: [paragraphBlock, headingBlock, bulletBlock, quoteBlock],
  registeredMarks: [boldMark, italicMark],
  registeredActions: [
    defineAction('slashCommand', {
      trigger: triggers.keyboard.character('/'),
      triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [triggers.keyboard.key('Escape')],
      perform: async (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu')
    })
  ]
});

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <section class="page">
      <div class="page-cover" aria-hidden="true"></div>
      <div class="editor-card">
        <div id="editor"></div>
        <details class="developer-details">
          <summary>Developer details</summary>
          <pre id="debug"></pre>
        </details>
      </div>
    </section>
    <aside class="slash-menu" id="slash-menu" hidden>
      <header>Basic blocks</header>
      <button data-type="paragraph"><span>¶</span><span>Text</span></button>
      <button data-type="heading2"><span>H2</span><span>Heading</span></button>
      <button data-type="quote"><span>❝</span><span>Quote</span></button>
    </aside>
  </div>
`;

const debug = document.querySelector<HTMLPreElement>('#debug')!;
const menu = document.querySelector<HTMLElement>('#slash-menu')!;
const editor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.querySelector<HTMLElement>('#editor')),
  initialContent,
  autoFocus: true
});

editor.onTransaction((transaction) => {
  localStorage.setItem('plim.basic.snapshot', JSON.stringify(transaction.after.content));
  debug.textContent = JSON.stringify(
    {
      version: transaction.after.version,
      cause: transaction.cause,
      blocks: transaction.after.content.blocks.length
    },
    null,
    2
  );
});

editor.onAsyncEvent('showSlashCommandMenu', async () => {
  const activeBlock = document.querySelector<HTMLElement>('[data-plim-block-content="true"]:focus');
  const rect = activeBlock?.getBoundingClientRect();
  menu.style.left = `${rect ? rect.left : window.innerWidth / 2}px`;
  menu.style.top = `${rect ? rect.bottom + 6 : 220}px`;
  menu.hidden = false;
});

menu.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-type]');
  if (!button) {
    return;
  }

  const state = editor.getState();
  const selection = state.selection;
  const activeBlock =
    selection && selection.kind !== 'block'
      ? state.content.blocks.find((candidate) => candidate.id === selection.blockId)
      : state.content.blocks.at(-1);
  const block = createBlock(button.dataset.type ?? 'paragraph', '');
  void editor.dispatch([{ op: 'insertBlock', block, ...(activeBlock ? { afterBlockId: activeBlock.id } : {}) }], {
    kind: 'command',
    commandId: 'slash-insert'
  });
  menu.hidden = true;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    menu.hidden = true;
  }
});
