import {
  type ActionContext,
  type ActionDefinition,
  type AsyncEvent,
  type BlockDefinition,
  type PlimBlock,
  type PlimContent,
  type PlimDriver,
  type PlimEditorState,
  type PlimMarkRange,
  type PlimSelection,
  type Snapshot,
  type Transaction,
  type TransactionBuilder,
  type TransactionCause,
  type TransactionOperation,
  type Trigger,
  type UpdateBlockOperation,
  cloneContent,
  cloneState,
  createBlock,
  createContent,
  createId,
  evaluateTriggerRule,
  operationApply,
  triggers,
  triggerMatches,
  triggerRuleBuilders
} from '@plim/core';

const PLIM_CLIPBOARD_MIME = 'application/x-plim-blocks+json';

export interface ContainerAdapter {
  getContainer(): HTMLElement | null;
}

export function attachContainer(getContainer: () => HTMLElement | null): ContainerAdapter {
  return { getContainer };
}

export interface DeriveEditorOptions {
  containerAdapter: ContainerAdapter;
  initialContent?: PlimContent;
  readonly?: boolean;
  autoFocus?: boolean;
}

export type TransactionListener = (transaction: Transaction) => void;
export type AsyncEventListener<Name extends string = string> = (
  event: AsyncEvent<Name>,
  state: PlimEditorState,
  ctx: ActionContext
) => Promise<unknown> | unknown;

export interface AgnosticEditor {
  readonly plim: PlimDriver;
  readonly isReady: boolean;
  readonly root: HTMLElement | null;
  getState(): PlimEditorState;
  onTransaction(listener: TransactionListener): () => void;
  onAsyncEvent<Name extends string>(name: Name, listener: AsyncEventListener<Name>): () => void;
  whenReady(listener: () => void): () => void;
  dispatch(operations: TransactionOperation[], cause?: TransactionCause): Promise<Transaction>;
  dispatchTrigger(trigger: Trigger): Promise<unknown[]>;
  restoreSnapshot(snapshot: Snapshot): void;
  destroy(): void;
}

export function deriveEditor(plim: PlimDriver, options: DeriveEditorOptions): AgnosticEditor {
  return new PlimAgnosticEditor(plim, options);
}

class PlimAgnosticEditor implements AgnosticEditor {
  readonly plim: PlimDriver;
  #containerAdapter: ContainerAdapter;
  #root: HTMLElement | null = null;
  #state: PlimEditorState;
  #transactionListeners = new Set<TransactionListener>();
  #asyncListeners = new Map<string, Set<AsyncEventListener>>();
  #readyListeners = new Set<() => void>();
  #isReady = false;
  #activeAbortController: AbortController | null = null;
  #activeDragBlockId: string | null = null;
  #verticalNavigationOffset: number | null = null;

  constructor(plim: PlimDriver, options: DeriveEditorOptions) {
    this.plim = plim;
    this.#containerAdapter = options.containerAdapter;
    this.#state = {
      content: cloneContent(options.initialContent ?? createContent([createBlock('paragraph', '')], 'Untitled')),
      selection: null,
      readonly: options.readonly ?? false,
      version: 0
    };

    this.plim.getHistory().attachRestore((state, transaction) => {
      this.#setState(state, transaction);
    });

    this.#mount(options.autoFocus ?? false);
  }

  get isReady(): boolean {
    return this.#isReady;
  }

  get root(): HTMLElement | null {
    return this.#root;
  }

  getState(): PlimEditorState {
    return cloneState(this.#state);
  }

  onTransaction(listener: TransactionListener): () => void {
    this.#transactionListeners.add(listener);
    return () => this.#transactionListeners.delete(listener);
  }

  onAsyncEvent<Name extends string>(name: Name, listener: AsyncEventListener<Name>): () => void {
    const listeners = this.#asyncListeners.get(name) ?? new Set<AsyncEventListener>();
    listeners.add(listener as AsyncEventListener);
    this.#asyncListeners.set(name, listeners);
    return () => {
      listeners.delete(listener as AsyncEventListener);
      if (listeners.size === 0) {
        this.#asyncListeners.delete(name);
      }
    };
  }

  whenReady(listener: () => void): () => void {
    if (this.#isReady) {
      listener();
      return () => undefined;
    }

    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  async dispatch(operations: TransactionOperation[], cause: TransactionCause = { kind: 'api' }): Promise<Transaction> {
    if (this.#state.readonly) {
      throw new Error('Cannot dispatch a transaction while the editor is read-only.');
    }

    const before = cloneState(this.#state);
    const applied = operationApply(this.#state.content, operations, this.#state.selection);
    const after: PlimEditorState = {
      content: applied.content,
      selection: applied.selection,
      readonly: this.#state.readonly,
      version: this.#state.version + 1
    };
    const transaction: Transaction = {
      id: createId('transaction'),
      timestamp: Date.now(),
      operations,
      before,
      after: cloneState(after),
      cause
    };

    this.#state = after;
    this.#render();
    this.plim._recordTransaction(transaction);

    for (const extension of this.plim.getExtensions(this)) {
      await extension.onTransaction?.(transaction, { plim: this.plim });
    }

    for (const listener of this.#transactionListeners) {
      listener(transaction);
    }

    return transaction;
  }

  async dispatchTrigger(trigger: Trigger): Promise<unknown[]> {
    if (this.#activeAbortController && this.#matchesAnyCancellation(trigger)) {
      this.#activeAbortController.abort();
      this.#activeAbortController = null;
      return [];
    }

    const actions = this.plim
      .getRegisteredActions(this)
      .filter((action) => action.trigger && normalizeTriggers(action.trigger).some((candidate) => triggerMatches(candidate, trigger)))
      .filter((action) => this.#actionIsAllowed(action, trigger));

    const results: unknown[] = [];
    for (const action of actions) {
      const abortController = new AbortController();
      this.#activeAbortController = abortController;
      const ctx = this.#createActionContext(abortController);
      try {
        results.push(await action.perform(this.getState(), ctx));
      } finally {
        if (this.#activeAbortController === abortController) {
          this.#activeAbortController = null;
        }
      }
    }

    return results;
  }

  restoreSnapshot(snapshot: Snapshot): void {
    const before = cloneState(this.#state);
    const after = cloneState(snapshot.state);
    const transaction: Transaction = {
      id: createId('snapshot'),
      timestamp: Date.now(),
      operations: [{ op: 'replaceContent', content: after.content }, { op: 'setSelection', selection: after.selection }],
      before,
      after,
      cause: { kind: 'api' }
    };
    this.#setState(after, transaction);
  }

  destroy(): void {
    this.#root?.replaceChildren();
    this.#transactionListeners.clear();
    this.#asyncListeners.clear();
    this.#readyListeners.clear();
    this.#isReady = false;
  }

  #mount(autoFocus: boolean): void {
    const container = this.#containerAdapter.getContainer();
    if (!container) {
      throw new Error('Plim editor container could not be found.');
    }
    this.#root = container;
    this.plim.getRegisteredBlocks(this);
    this.plim.getRegisteredMarks(this);
    this.plim.getRegisteredActions(this);
    this.#root.classList.add('plim-editor-root');
    this.#render();
    this.#isReady = true;
    for (const listener of this.#readyListeners) {
      listener();
    }
    this.#readyListeners.clear();

    if (autoFocus) {
      const firstBlock = this.#root.querySelector<HTMLElement>('[data-plim-block-content="true"]');
      firstBlock?.focus();
    }
  }

  #setState(state: PlimEditorState, transaction: Transaction): void {
    this.#state = cloneState(state);
    this.#render();
    for (const listener of this.#transactionListeners) {
      listener(transaction);
    }
  }

  #render(): void {
    if (!this.#root) {
      return;
    }

    const blocks = new Map(this.plim.getRegisteredBlocks(this).map((block) => [block.name, block]));
    this.#root.dataset.plimTheme = typeof this.plim.theme === 'string' ? this.plim.theme : this.plim.theme.name;
    this.#root.replaceChildren();
    const shell = document.createElement('article');
    shell.className = 'plim-editor';

    const title = document.createElement('h1');
    title.className = 'plim-title';
    title.contentEditable = String(!this.#state.readonly);
    title.dataset.plimTitle = 'true';
    title.textContent = this.#state.content.title;
    title.setAttribute('aria-label', 'Page title');
    title.addEventListener('input', () => {
      if (this.#state.readonly) {
        return;
      }
      const content = cloneContent(this.#state.content);
      content.title = title.textContent ?? '';
      void this.dispatch([{ op: 'replaceContent', content }], { kind: 'text-input', text: content.title });
    });
    shell.append(title);

    const blockList = document.createElement('div');
    blockList.className = 'plim-block-list';
    for (const block of this.#state.content.blocks) {
      blockList.append(this.#renderBlock(block, blocks.get(block.type)));
    }
    shell.append(blockList);
    this.#root.append(shell);
    this.#restoreDOMSelection();
  }

  #renderBlock(block: PlimBlock, definition: BlockDefinition | undefined): HTMLElement {
    const row = document.createElement('section');
    row.className = 'plim-block';
    row.dataset.blockId = block.id;
    row.dataset.blockType = block.type;

    const controls = document.createElement('div');
    controls.className = 'plim-block-controls';

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'plim-block-add';
    addButton.textContent = '+';
    addButton.setAttribute('aria-label', 'Add block');
    addButton.addEventListener('click', () => {
      const newBlock = createBlock('paragraph', '');
      void this.dispatch([{ op: 'insertBlock', block: newBlock, afterBlockId: block.id }], { kind: 'command', commandId: 'insert-paragraph' });
    });

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'plim-block-handle';
    handle.textContent = '⋮⋮';
    handle.setAttribute('aria-label', 'Block handle');
    handle.draggable = !this.#state.readonly;
    handle.addEventListener('dragstart', (event) => {
      if (this.#state.readonly || !event.dataTransfer) {
        return;
      }
      this.#activeDragBlockId = block.id;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', block.text);
      event.dataTransfer.setData(PLIM_CLIPBOARD_MIME, JSON.stringify([block]));
      event.dataTransfer.setData('application/x-plim-block-id', block.id);
    });
    handle.addEventListener('dragend', () => {
      this.#activeDragBlockId = null;
      row.classList.remove('is-dragging');
      this.#clearDropTargets();
    });
    controls.append(addButton, handle);
    row.append(controls);

    const payload = {
      block,
      content: block.text,
      attributes: {
        'data-plim-block-content': 'true'
      },
      readonly: this.#state.readonly,
      selected: this.#state.selection?.kind === 'block' && this.#state.selection.blockIds.includes(block.id)
    };

    const content = definition?.toDOM?.(payload) ?? this.#defaultBlockDOM(block);
    if (!definition?.toDOM) {
      this.#applyInlineMarks(content, block);
    }
    content.classList.add('plim-block-content');
    content.dataset.plimBlockContent = 'true';
    content.contentEditable = String(!this.#state.readonly && !(definition?.atom ?? false));
    content.tabIndex = this.#state.readonly ? -1 : 0;
    content.setAttribute('role', 'textbox');
    content.setAttribute('aria-label', `${block.type} block`);
    content.addEventListener('focus', () => {
      this.#state.selection = this.#selectionFromDOM(block.id, content);
    });
    content.addEventListener('keyup', () => {
      this.#state.selection = this.#selectionFromDOM(block.id, content);
    });
    content.addEventListener('mouseup', () => {
      this.#state.selection = this.#selectionFromDOM(block.id, content);
    });
    content.addEventListener('input', (event) => {
      if (this.#state.readonly) {
        return;
      }
      const text = normalizeEditableText(content.textContent ?? '');
      const selection = this.#selectionFromDOM(block.id, content);
      void this.dispatch(
        [
          {
            op: 'updateBlock',
            blockId: block.id,
            patch: { text }
          },
          {
            op: 'setSelection',
            selection
          }
        ],
        textInputCause(text, typeof InputEvent !== 'undefined' && event instanceof InputEvent ? event.inputType : undefined)
      );
    });
    content.addEventListener('keydown', (event) => {
      this.#state.selection = this.#selectionFromDOM(block.id, content);
      const trigger = keyboardEventToTrigger(event);
      if (trigger) {
        void this.dispatchTrigger(trigger);
      }
      this.#handleBlockKeydown(event, block, content);
    });
    content.addEventListener('copy', (event) => {
      this.#copyBlockToClipboard(event, block, content);
    });
    content.addEventListener('cut', (event) => {
      this.#cutBlockToClipboard(event, block, content);
    });
    content.addEventListener('paste', (event) => {
      this.#pasteFromClipboard(event, block, content);
    });

    row.addEventListener('dragover', (event) => {
      if (this.#state.readonly || !this.#draggedBlockId(event) || this.#draggedBlockId(event) === block.id) {
        return;
      }
      event.preventDefault();
      this.#markDropTarget(row, event);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('is-drop-before', 'is-drop-after');
    });
    row.addEventListener('drop', (event) => {
      if (this.#state.readonly) {
        return;
      }
      const sourceBlockId = this.#draggedBlockId(event);
      if (!sourceBlockId || sourceBlockId === block.id) {
        return;
      }
      event.preventDefault();
      const targetIndex = this.#state.content.blocks.findIndex((candidate) => candidate.id === block.id);
      const insertAfterTarget = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      const afterBlockId = insertAfterTarget ? block.id : this.#state.content.blocks[targetIndex - 1]?.id;
      void this.dispatch(
        [
          { op: 'moveBlock', blockId: sourceBlockId, ...(afterBlockId ? { afterBlockId } : {}) },
          { op: 'setSelection', selection: { kind: 'caret', blockId: sourceBlockId, offset: 0 } }
        ],
        { kind: 'command', commandId: 'move-block' }
      );
      this.#activeDragBlockId = null;
      this.#clearDropTargets();
    });

    row.append(content);
    return row;
  }

  #handleBlockKeydown(event: KeyboardEvent, block: PlimBlock, content: HTMLElement): void {
    if (this.#state.readonly) {
      return;
    }

    const selection = this.#selectionFromDOM(block.id, content);
    const anchorOffset = selection.kind === 'range' ? selection.from : selection.kind === 'caret' ? selection.offset : 0;
    const focusOffset = selection.kind === 'range' ? selection.to : selection.kind === 'caret' ? selection.offset : 0;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      this.#verticalNavigationOffset = null;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const from = Math.min(anchorOffset, focusOffset);
      const to = Math.max(anchorOffset, focusOffset);
      const newBlock = createBlock('paragraph', block.text.slice(to), { marks: shiftMarks(block.marks ?? [], to) });
      void this.dispatch(
        [
          { op: 'updateBlock', blockId: block.id, patch: { text: block.text.slice(0, from), marks: trimMarks(block.marks ?? [], 0, from) } },
          { op: 'insertBlock', block: newBlock, afterBlockId: block.id },
          { op: 'setSelection', selection: { kind: 'caret', blockId: newBlock.id, offset: 0 } }
        ],
        { kind: 'keyboard', key: 'Enter' }
      );
      return;
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && selection.kind === 'caret') {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const adjacent = this.#adjacentBlock(block.id, direction);
      if (adjacent && this.#shouldMoveVerticallyToAdjacentBlock(content, direction, selection.offset)) {
        event.preventDefault();
        const desiredOffset = this.#verticalNavigationOffset ?? selection.offset;
        const targetContent = this.#blockContentElement(adjacent.id);
        const targetOffset =
          targetContent && targetContent.textContent === adjacent.text
            ? offsetClosestToHorizontalPosition(targetContent, caretHorizontalPosition(content, selection.offset), direction, desiredOffset)
            : clampOffset(adjacent.text.length, desiredOffset);
        this.#verticalNavigationOffset = desiredOffset;
        void this.dispatch([{ op: 'setSelection', selection: { kind: 'caret', blockId: adjacent.id, offset: targetOffset } }], {
          kind: 'keyboard',
          key: event.key
        });
      }
      return;
    }

    if (event.key === 'Backspace' && anchorOffset === 0 && focusOffset === 0) {
      const previous = this.#adjacentBlock(block.id, -1);
      if (previous) {
        event.preventDefault();
        const offset = previous.text.length;
        void this.dispatch(
          [
            {
              op: 'updateBlock',
              blockId: previous.id,
              patch: { text: previous.text + block.text, marks: [...(previous.marks ?? []), ...shiftMarks(block.marks ?? [], 0, offset)] }
            },
            { op: 'deleteBlock', blockId: block.id },
            { op: 'setSelection', selection: { kind: 'caret', blockId: previous.id, offset } }
          ],
          { kind: 'keyboard', key: 'Backspace' }
        );
      }
      return;
    }

    if (event.key === 'Delete' && anchorOffset === block.text.length && focusOffset === block.text.length) {
      const next = this.#adjacentBlock(block.id, 1);
      if (next) {
        event.preventDefault();
        const offset = block.text.length;
        void this.dispatch(
          [
            {
              op: 'updateBlock',
              blockId: block.id,
              patch: { text: block.text + next.text, marks: [...(block.marks ?? []), ...shiftMarks(next.marks ?? [], 0, offset)] }
            },
            { op: 'deleteBlock', blockId: next.id },
            { op: 'setSelection', selection: { kind: 'caret', blockId: block.id, offset } }
          ],
          { kind: 'keyboard', key: 'Delete' }
        );
      }
    }
  }

  #copyBlockToClipboard(event: ClipboardEvent, block: PlimBlock, content: HTMLElement): void {
    if (!event.clipboardData) {
      return;
    }

    const selection = this.#selectionFromDOM(block.id, content);
    const blocks =
      selection.kind === 'range'
        ? [createBlock(block.type, block.text.slice(selection.from, selection.to), { marks: trimMarks(block.marks ?? [], selection.from, selection.to) })]
        : [block];
    event.preventDefault();
    event.clipboardData.setData(PLIM_CLIPBOARD_MIME, JSON.stringify({ mode: selection.kind === 'range' ? 'text' : 'block', blocks }));
    event.clipboardData.setData('text/plain', blocksToPlainText(blocks));
    void this.dispatchTrigger(triggers.clipboard.action('copy'));
  }

  #cutBlockToClipboard(event: ClipboardEvent, block: PlimBlock, content: HTMLElement): void {
    if (this.#state.readonly || !event.clipboardData) {
      return;
    }

    this.#copyBlockToClipboard(event, block, content);
    const selection = this.#selectionFromDOM(block.id, content);
    if (selection.kind === 'range') {
      const from = Math.min(selection.from, selection.to);
      const to = Math.max(selection.from, selection.to);
      void this.dispatch(
        [
          { op: 'updateBlock', blockId: block.id, patch: { text: block.text.slice(0, from) + block.text.slice(to), marks: removeMarkRange(block.marks ?? [], from, to) } },
          { op: 'setSelection', selection: { kind: 'caret', blockId: block.id, offset: from } }
        ],
        { kind: 'keyboard', key: 'Cut', shortcut: 'Mod+x' }
      );
      return;
    }

    const fallback = this.#adjacentBlock(block.id, 1) ?? this.#adjacentBlock(block.id, -1);
    const operations: TransactionOperation[] =
      this.#state.content.blocks.length > 1
        ? [
            { op: 'deleteBlock', blockId: block.id },
            ...(fallback ? ([{ op: 'setSelection', selection: { kind: 'caret', blockId: fallback.id, offset: 0 } }] as TransactionOperation[]) : [])
          ]
        : [
            { op: 'updateBlock', blockId: block.id, patch: { text: '', marks: [] } },
            { op: 'setSelection', selection: { kind: 'caret', blockId: block.id, offset: 0 } }
          ];
    void this.dispatch(operations, { kind: 'keyboard', key: 'Cut', shortcut: 'Mod+x' });
  }

  #pasteFromClipboard(event: ClipboardEvent, block: PlimBlock, content: HTMLElement): void {
    if (this.#state.readonly || !event.clipboardData) {
      return;
    }

    const clipboard = blocksFromClipboard(event.clipboardData);
    const { blocks } = clipboard;
    if (blocks.length === 0) {
      return;
    }

    event.preventDefault();
    const selection = this.#selectionFromDOM(block.id, content);
    if (clipboard.preferBlockInsert && selection.kind === 'caret') {
      const operations: TransactionOperation[] = [
        ...blocks.map((candidate, index) => ({
          op: 'insertBlock' as const,
          block: candidate,
          afterBlockId: index === 0 ? block.id : blocks[index - 1]!.id
        })),
        { op: 'setSelection', selection: { kind: 'caret', blockId: blocks.at(-1)!.id, offset: blocks.at(-1)!.text.length } }
      ];
      void this.dispatch(operations, { kind: 'paste', plainText: false });
      void this.dispatchTrigger(triggers.clipboard.action('paste'));
      return;
    }

    const from = selection.kind === 'range' ? Math.min(selection.from, selection.to) : selection.kind === 'caret' ? selection.offset : 0;
    const to = selection.kind === 'range' ? Math.max(selection.from, selection.to) : selection.kind === 'caret' ? selection.offset : 0;
    const before = block.text.slice(0, from);
    const after = block.text.slice(to);
    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    const inserted: PlimBlock[] =
      blocks.length === 1
        ? []
        : [
            ...blocks.slice(1, -1),
            {
              ...last,
              text: last.text + after,
              marks: shiftMarks(last.marks ?? [], 0).concat(shiftMarks(block.marks ?? [], to, last.text.length))
            }
          ];
    const selectionBlockId = inserted.at(-1)?.id ?? block.id;
    const selectionOffset = blocks.length === 1 ? before.length + first.text.length : last.text.length;
    const operations: TransactionOperation[] = [
      {
        op: 'updateBlock',
        blockId: block.id,
        patch: {
          text: before + first.text + (blocks.length === 1 ? after : ''),
          marks: [
            ...trimMarks(block.marks ?? [], 0, from),
            ...shiftMarks(first.marks ?? [], 0, before.length),
            ...(blocks.length === 1 ? shiftMarks(block.marks ?? [], to, before.length + first.text.length) : [])
          ]
        }
      },
      ...inserted.map((candidate, index) => ({
        op: 'insertBlock' as const,
        block: candidate,
        afterBlockId: index === 0 ? block.id : inserted[index - 1]!.id
      })),
      { op: 'setSelection', selection: { kind: 'caret', blockId: selectionBlockId, offset: selectionOffset } }
    ];

    void this.dispatch(operations, { kind: 'paste', plainText: !event.clipboardData.types.includes('text/html') });
    void this.dispatchTrigger(triggers.clipboard.action('paste'));
  }

  #selectionFromDOM(blockId: string, content: HTMLElement): PlimSelection {
    const selection = content.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0 || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
      return { kind: 'caret', blockId, offset: clampOffset(content.textContent?.length ?? 0, this.#state.selection?.kind === 'caret' ? this.#state.selection.offset : 0) };
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) {
      return { kind: 'caret', blockId, offset: 0 };
    }

    const anchor = offsetWithin(content, anchorNode, selection.anchorOffset);
    const focus = offsetWithin(content, focusNode, selection.focusOffset);
    if (anchor === focus) {
      return { kind: 'caret', blockId, offset: anchor };
    }

    return { kind: 'range', blockId, from: Math.min(anchor, focus), to: Math.max(anchor, focus) };
  }

  #restoreDOMSelection(): void {
    if (!this.#root || !this.#state.selection || this.#state.selection.kind === 'block') {
      return;
    }

    const content = this.#root.querySelector<HTMLElement>(`[data-block-id="${cssEscape(this.#state.selection.blockId)}"] [data-plim-block-content="true"]`);
    if (!content) {
      return;
    }

    const selection = content.ownerDocument.defaultView?.getSelection();
    if (!selection) {
      return;
    }

    const range = content.ownerDocument.createRange();
    const start = pointAtOffset(content, this.#state.selection.kind === 'range' ? this.#state.selection.from : this.#state.selection.offset);
    const end = pointAtOffset(content, this.#state.selection.kind === 'range' ? this.#state.selection.to : this.#state.selection.offset);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    content.focus();
  }

  #adjacentBlock(blockId: string, direction: -1 | 1): PlimBlock | null {
    const index = this.#state.content.blocks.findIndex((candidate) => candidate.id === blockId);
    return this.#state.content.blocks[index + direction] ?? null;
  }

  #blockContentElement(blockId: string): HTMLElement | null {
    return this.#root?.querySelector<HTMLElement>(`[data-block-id="${cssEscape(blockId)}"] [data-plim-block-content="true"]`) ?? null;
  }

  #shouldMoveVerticallyToAdjacentBlock(content: HTMLElement, direction: -1 | 1, offset: number): boolean {
    const caretRect = caretRectAtOffset(content, offset);
    const contentRect = content.getBoundingClientRect();
    if (caretRect && hasUsableRect(caretRect) && hasUsableRect(contentRect)) {
      const lineHeight = parsedLineHeight(content) || caretRect.height || 16;
      return direction < 0 ? caretRect.top <= contentRect.top + lineHeight * 0.65 : caretRect.bottom >= contentRect.bottom - lineHeight * 0.65;
    }

    const text = content.textContent ?? '';
    return !text.includes('\n') || (direction < 0 ? offset === 0 : offset === text.length);
  }

  #draggedBlockId(event: DragEvent): string | null {
    return event.dataTransfer?.getData('application/x-plim-block-id') || this.#activeDragBlockId;
  }

  #markDropTarget(row: HTMLElement, event: DragEvent): void {
    this.#clearDropTargets();
    const insertAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    row.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
  }

  #clearDropTargets(): void {
    this.#root?.querySelectorAll('.is-drop-before, .is-drop-after').forEach((node) => {
      node.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  #applyInlineMarks(content: HTMLElement, block: PlimBlock): void {
    if (!block.marks || block.marks.length === 0) {
      content.textContent = block.text;
      return;
    }

    const marks = block.marks.filter((mark) => mark.to > mark.from && mark.from < block.text.length);
    const boundaries = [...new Set([0, block.text.length, ...marks.flatMap((mark) => [clampOffset(block.text.length, mark.from), clampOffset(block.text.length, mark.to)])])].sort(
      (a, b) => a - b
    );
    content.replaceChildren();

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const from = boundaries[index]!;
      const to = boundaries[index + 1]!;
      if (from === to) {
        continue;
      }
      const text = block.text.slice(from, to);
      const activeMarks = marks.filter((mark) => mark.from <= from && mark.to >= to);
      content.append(this.#markNode(text, activeMarks));
    }
  }

  #markNode(text: string, marks: PlimMarkRange[]): Node {
    let node: Node = document.createTextNode(text);
    const markDefinitions = new Map(this.plim.getRegisteredMarks(this).map((mark) => [mark.name, mark]));
    for (const mark of [...marks].reverse()) {
      const wrapper =
        markDefinitions.get(mark.mark)?.toDOM?.({ mark, text, attributes: stringifyAttributes(mark.attrs) }) ?? defaultMarkElement(mark.mark, text);
      wrapper.replaceChildren(node);
      node = wrapper;
    }
    return node;
  }

  #defaultBlockDOM(block: PlimBlock): HTMLElement {
    if (block.type === 'heading1') {
      const heading = document.createElement('h2');
      heading.textContent = block.text;
      return heading;
    }
    if (block.type === 'heading2') {
      const heading = document.createElement('h3');
      heading.textContent = block.text;
      return heading;
    }
    if (block.type === 'heading3') {
      const heading = document.createElement('h4');
      heading.textContent = block.text;
      return heading;
    }
    if (block.type === 'quote') {
      const quote = document.createElement('blockquote');
      quote.textContent = block.text;
      return quote;
    }
    if (block.type === 'divider') {
      const divider = document.createElement('hr');
      divider.contentEditable = 'false';
      return divider;
    }
    if (block.type === 'bulletedList' || block.type === 'numberedList') {
      const item = document.createElement('li');
      item.textContent = block.text;
      return item;
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = block.text;
    return paragraph;
  }

  #actionIsAllowed(action: ActionDefinition, trigger: Trigger): boolean {
    if (!action.triggerValidationRules) {
      return true;
    }
    return evaluateTriggerRule(action.triggerValidationRules(triggerRuleBuilders), this.#state, trigger);
  }

  #matchesAnyCancellation(trigger: Trigger): boolean {
    const actions = this.plim.getRegisteredActions(this);
    return actions.some((action) => action.cancellationTriggers?.some((candidate) => triggerMatches(candidate, trigger)));
  }

  #createActionContext(abortController: AbortController): ActionContext {
    return {
      createTransaction: () => new EditorTransactionBuilder(this),
      triggerAsyncEvent: async (name, detail) => this.#triggerAsyncEvent(name, detail, abortController),
      signal: abortController.signal,
      isCancelled: () => abortController.signal.aborted
    };
  }

  async #triggerAsyncEvent<Name extends string, Detail = unknown>(
    name: Name,
    detail: Detail | undefined,
    abortController: AbortController
  ): Promise<unknown[]> {
    const event: AsyncEvent<Name, Detail> = { name, ...(detail === undefined ? {} : { detail }), signal: abortController.signal };
    const ctx = this.#createActionContext(abortController);
    const results: unknown[] = [];

    for (const extension of this.plim.getExtensions(this)) {
      results.push(await extension.onAsyncEvent?.(event, this.getState(), ctx));
    }

    for (const listener of this.#asyncListeners.get(name) ?? []) {
      results.push(await listener(event, this.getState(), ctx));
    }

    return results;
  }
}

class EditorTransactionBuilder implements TransactionBuilder {
  #editor: PlimAgnosticEditor;
  #operations: TransactionOperation[] = [];

  constructor(editor: PlimAgnosticEditor) {
    this.#editor = editor;
  }

  insertBlock(block: PlimBlock, afterBlockId?: string): TransactionBuilder {
    this.#operations.push({ op: 'insertBlock', block, ...(afterBlockId ? { afterBlockId } : {}) });
    return this;
  }

  updateBlock(blockId: string, patch: UpdateBlockOperation['patch']): TransactionBuilder {
    this.#operations.push({ op: 'updateBlock', blockId, patch });
    return this;
  }

  deleteBlock(blockId: string): TransactionBuilder {
    this.#operations.push({ op: 'deleteBlock', blockId });
    return this;
  }

  moveBlock(blockId: string, afterBlockId?: string): TransactionBuilder {
    this.#operations.push({ op: 'moveBlock', blockId, ...(afterBlockId ? { afterBlockId } : {}) });
    return this;
  }

  toggleMark(mark: string, range: { from: number; to: number; blockId?: string }, attrs?: Record<string, unknown>): TransactionBuilder {
    this.#operations.push({ op: 'toggleMark', mark, range, ...(attrs ? { attrs } : {}) });
    return this;
  }

  replaceContent(content: PlimContent): TransactionBuilder {
    this.#operations.push({ op: 'replaceContent', content });
    return this;
  }

  setSelection(selection: PlimSelection | null): TransactionBuilder {
    this.#operations.push({ op: 'setSelection', selection });
    return this;
  }

  commit(cause: TransactionCause = { kind: 'api' }): Promise<Transaction> {
    return this.#editor.dispatch(this.#operations, cause);
  }
}

function normalizeTriggers(trigger: Trigger | Trigger[]): Trigger[] {
  return Array.isArray(trigger) ? trigger : [trigger];
}

function keyboardEventToTrigger(event: KeyboardEvent): Trigger | null {
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return { kind: 'keyboard', mode: 'character', value: event.key };
  }

  const modifiers = [
    event.metaKey || event.ctrlKey ? 'Mod' : '',
    event.shiftKey ? 'Shift' : '',
    event.altKey ? 'Alt' : '',
    event.key.length > 1 ? event.key : event.key.toLowerCase()
  ].filter(Boolean);

  if (modifiers.length > 1) {
    return { kind: 'keyboard', mode: 'shortcut', value: modifiers.join('+') };
  }

  return { kind: 'keyboard', mode: 'key', value: event.key };
}

function textInputCause(text: string, inputType?: string): TransactionCause {
  return inputType ? { kind: 'text-input', inputType, text } : { kind: 'text-input', text };
}

function normalizeEditableText(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

function clampOffset(length: number, offset: number): number {
  return Math.max(0, Math.min(length, offset));
}

function caretHorizontalPosition(root: HTMLElement, offset: number): number | null {
  const caretRect = caretRectAtOffset(root, offset);
  if (!caretRect || !hasUsableRect(caretRect)) {
    return null;
  }
  return caretRect.left;
}

function caretRectAtOffset(root: HTMLElement, offset: number): DOMRect | null {
  const ownerDocument = root.ownerDocument ?? document;
  const range = ownerDocument.createRange();
  const point = pointAtOffset(root, offset);
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const measurableRange = range as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  return measurableRange.getClientRects?.()[0] ?? measurableRange.getBoundingClientRect?.() ?? null;
}

function offsetClosestToHorizontalPosition(root: HTMLElement, x: number | null, direction: -1 | 1, fallbackOffset: number): number {
  const fallback = clampOffset(root.textContent?.length ?? 0, fallbackOffset);
  if (x === null) {
    return fallback;
  }

  const contentRect = root.getBoundingClientRect();
  if (!hasUsableRect(contentRect)) {
    return fallback;
  }

  const lineHeight = parsedLineHeight(root) || 16;
  const y = direction > 0 ? contentRect.top + lineHeight / 2 : contentRect.bottom - lineHeight / 2;
  const pointOffset = offsetFromPoint(root, x, y);
  if (pointOffset !== null) {
    return pointOffset;
  }

  return offsetClosestByMeasurement(root, x, fallback);
}

function offsetFromPoint(root: HTMLElement, x: number, y: number): number | null {
  const ownerDocument = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = ownerDocument.caretPositionFromPoint?.(x, y);
  if (position && root.contains(position.offsetNode)) {
    return offsetWithin(root, position.offsetNode, position.offset);
  }

  const range = ownerDocument.caretRangeFromPoint?.(x, y);
  if (range && root.contains(range.startContainer)) {
    return offsetWithin(root, range.startContainer, range.startOffset);
  }

  return null;
}

function offsetClosestByMeasurement(root: HTMLElement, x: number, fallbackOffset: number): number {
  const textLength = root.textContent?.length ?? 0;
  let closestOffset = clampOffset(textLength, fallbackOffset);
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset <= textLength; offset += 1) {
    const rect = caretRectAtOffset(root, offset);
    if (!rect || !hasUsableRect(rect)) {
      continue;
    }

    const distance = Math.abs(rect.left - x);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestOffset = offset;
    }
  }

  return closestOffset;
}

function parsedLineHeight(element: HTMLElement): number {
  const value = element.ownerDocument.defaultView?.getComputedStyle(element).lineHeight;
  if (!value || value === 'normal') {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasUsableRect(rect: DOMRect | { width: number; height: number }): boolean {
  return rect.width > 0 || rect.height > 0;
}

function offsetWithin(root: Node, target: Node, targetOffset: number): number {
  const ownerDocument = root.ownerDocument ?? document;
  const range = ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(target, targetOffset);
  return clampOffset(root.textContent?.length ?? 0, range.toString().length);
}

function pointAtOffset(root: Node, offset: number): { node: Node; offset: number } {
  const targetOffset = clampOffset(root.textContent?.length ?? 0, offset);
  const nodeFilter = (root.ownerDocument ?? document).defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, nodeFilter);
  let remaining = targetOffset;
  let node = walker.nextNode();

  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      return { node, offset: remaining };
    }
    remaining -= length;
    node = walker.nextNode();
  }

  if (!root.firstChild) {
    root.appendChild((root.ownerDocument ?? document).createTextNode(''));
  }
  return { node: root.firstChild ?? root, offset: 0 };
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape?.(value) ?? value.replace(/["\\]/g, '\\$&');
}

function stringifyAttributes(attrs: Record<string, unknown> | undefined): Record<string, string> {
  if (!attrs) {
    return {};
  }
  return Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
}

function defaultMarkElement(mark: string, text: string): HTMLElement {
  const tagName =
    mark === 'bold'
      ? 'strong'
      : mark === 'italic'
        ? 'em'
        : mark === 'code'
          ? 'code'
          : mark === 'strikethrough'
            ? 's'
            : mark === 'underline'
              ? 'u'
              : mark === 'highlight'
                ? 'mark'
                : 'span';
  const element = document.createElement(tagName);
  element.dataset.plimMark = mark;
  element.textContent = text;
  return element;
}

interface ClipboardBlocks {
  blocks: PlimBlock[];
  preferBlockInsert: boolean;
}

function blocksFromClipboard(dataTransfer: DataTransfer): ClipboardBlocks {
  const plimPayload = dataTransfer.getData(PLIM_CLIPBOARD_MIME);
  if (plimPayload) {
    const parsed = parsePlimClipboardPayload(plimPayload);
    if (parsed.blocks.length > 0) {
      return parsed;
    }
  }

  const html = dataTransfer.getData('text/html');
  if (html) {
    const parsed = blocksFromHtml(html);
    if (parsed.length > 0) {
      return { blocks: parsed, preferBlockInsert: false };
    }
  }

  const blocks = blocksFromPlainText(dataTransfer.getData('text/plain'));
  return { blocks, preferBlockInsert: false };
}

function parsePlimClipboardPayload(payload: string): ClipboardBlocks {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed)) {
      return { blocks: parsed.flatMap((block) => normalizeClipboardBlock(block)), preferBlockInsert: true };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { blocks: [], preferBlockInsert: false };
    }
    const candidate = parsed as { mode?: unknown; blocks?: unknown };
    return {
      blocks: Array.isArray(candidate.blocks) ? candidate.blocks.flatMap((block) => normalizeClipboardBlock(block)) : [],
      preferBlockInsert: candidate.mode === 'block'
    };
  } catch {
    return { blocks: [], preferBlockInsert: false };
  }
}

function normalizeClipboardBlock(value: unknown): PlimBlock[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const candidate = value as Partial<PlimBlock>;
  if (typeof candidate.type !== 'string' || typeof candidate.text !== 'string') {
    return [];
  }
  const init: Partial<Omit<PlimBlock, 'id' | 'type' | 'text'>> = {};
  const attrs = objectRecord(candidate.attrs);
  if (attrs) {
    init.attrs = attrs;
  }
  if (Array.isArray(candidate.marks)) {
    init.marks = candidate.marks.flatMap(normalizeClipboardMark);
  }
  if (Array.isArray(candidate.children)) {
    init.children = candidate.children.flatMap(normalizeClipboardBlock);
  }
  return [createBlock(candidate.type, candidate.text, init)];
}

function normalizeClipboardMark(value: unknown): PlimMarkRange[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const mark = value as Partial<PlimMarkRange>;
  if (typeof mark.mark !== 'string' || typeof mark.from !== 'number' || typeof mark.to !== 'number') {
    return [];
  }
  const attrs = objectRecord(mark.attrs);
  return [{ mark: mark.mark, from: mark.from, to: mark.to, ...(attrs ? { attrs } : {}) }];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : undefined;
}

function blocksFromPlainText(text: string): PlimBlock[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}|\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => createBlock('paragraph', line));
}

function blocksFromHtml(html: string): PlimBlock[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  const blockElements = Array.from(template.content.querySelectorAll('h1,h2,h3,p,li,blockquote,pre,hr')).filter(
    (element) => !element.parentElement?.closest('h1,h2,h3,p,li,blockquote,pre,hr')
  );

  if (blockElements.length === 0) {
    return blocksFromPlainText(template.content.textContent ?? '');
  }

  return blockElements.flatMap((element) => blockFromElement(element));
}

function blockFromElement(element: Element): PlimBlock[] {
  if (element.tagName === 'HR') {
    return [createBlock('divider', '')];
  }

  const inline = inlineContentFromNode(element);
  const text = normalizeEditableText(inline.text).trimEnd();
  if (!text && element.tagName !== 'PRE') {
    return [];
  }

  return [
    createBlock(blockTypeFromElement(element), text, {
      marks: inline.marks
    })
  ];
}

function blockTypeFromElement(element: Element): string {
  const tagName = element.tagName;
  if (tagName === 'H1') {
    return 'heading1';
  }
  if (tagName === 'H2') {
    return 'heading2';
  }
  if (tagName === 'H3') {
    return 'heading3';
  }
  if (tagName === 'LI') {
    return element.closest('ol') ? 'numberedList' : 'bulletedList';
  }
  if (tagName === 'BLOCKQUOTE') {
    return 'quote';
  }
  if (tagName === 'PRE') {
    return 'code';
  }
  return 'paragraph';
}

function inlineContentFromNode(root: Node): { text: string; marks: PlimMarkRange[] } {
  const marks: PlimMarkRange[] = [];
  let text = '';

  const visit = (node: Node, activeMarks: Array<{ mark: string; attrs?: Record<string, unknown> }>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      const from = text.length;
      text += value;
      const to = text.length;
      if (to > from) {
        marks.push(...activeMarks.map((mark) => ({ mark: mark.mark, from, to, ...(mark.attrs ? { attrs: mark.attrs } : {}) })));
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as Element;
    const nextMarks = [...activeMarks, ...marksForElement(element)];
    for (const child of element.childNodes) {
      visit(child, nextMarks);
    }
  };

  visit(root, []);
  return { text, marks };
}

function marksForElement(element: Element): Array<{ mark: string; attrs?: Record<string, unknown> }> {
  const tagName = element.tagName;
  if (tagName === 'STRONG' || tagName === 'B') {
    return [{ mark: 'bold' }];
  }
  if (tagName === 'EM' || tagName === 'I') {
    return [{ mark: 'italic' }];
  }
  if (tagName === 'CODE') {
    return [{ mark: 'code' }];
  }
  if (tagName === 'S' || tagName === 'DEL') {
    return [{ mark: 'strikethrough' }];
  }
  if (tagName === 'U') {
    return [{ mark: 'underline' }];
  }
  if (tagName === 'MARK') {
    return [{ mark: 'highlight' }];
  }
  if (tagName === 'A') {
    const href = element.getAttribute('href');
    return [{ mark: 'link', ...(href ? { attrs: { href } } : {}) }];
  }
  return [];
}

function blocksToPlainText(blocks: PlimBlock[]): string {
  return blocks.map((block) => block.text).join('\n');
}

function trimMarks(marks: PlimMarkRange[], from: number, to: number): PlimMarkRange[] {
  return marks
    .map((mark) => ({ ...mark, from: Math.max(mark.from, from) - from, to: Math.min(mark.to, to) - from }))
    .filter((mark) => mark.to > mark.from);
}

function shiftMarks(marks: PlimMarkRange[], from: number, offset = 0): PlimMarkRange[] {
  return marks
    .filter((mark) => mark.to > from)
    .map((mark) => ({ ...mark, from: Math.max(0, mark.from - from) + offset, to: mark.to - from + offset }))
    .filter((mark) => mark.to > mark.from);
}

function removeMarkRange(marks: PlimMarkRange[], from: number, to: number): PlimMarkRange[] {
  return marks.flatMap((mark) => {
    if (mark.to <= from) {
      return [mark];
    }
    if (mark.from >= to) {
      return [{ ...mark, from: mark.from - (to - from), to: mark.to - (to - from) }];
    }
    const fragments: PlimMarkRange[] = [];
    if (mark.from < from) {
      fragments.push({ ...mark, to: from });
    }
    if (mark.to > to) {
      fragments.push({ ...mark, from, to: mark.to - (to - from) });
    }
    return fragments;
  });
}
