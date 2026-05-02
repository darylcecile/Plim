import {
  createEditor,
  type Command,
  type CommandResult,
  type EditorFacade,
  type PersistenceAdapter,
  type PersistenceWatchEvent,
  type PersistedSnapshot,
  type Renderer,
  type RendererContext,
  type TransactionResult
} from '@plim/editor';
import {
  TITLE_PROPERTY_ID,
  asDataSourceId,
  asDatabaseId,
  asPageId,
  asPropertyId,
  asViewId,
  createBlock,
  createEmptyDocument,
  createIdFactory,
  plainTextFromRichText,
  richTextFromPlainText,
  type BlockId,
  type BlockRecord,
  type BlockType,
  type DataSourceEntry,
  type DataSourceId,
  type DataSourceProperty,
  type DataSourceRecord,
  type DatabaseRecord,
  type DocumentState,
  type InsertPosition,
  type Operation,
  type PageId,
  type PagePropertyValue,
  type PageRecord,
  type ParentRef,
  type PropertyId,
  type RichText,
  type ViewRecord
} from '@plim/model';
import {
  createDefaultBlockData,
  getBlockDefinition,
  getSlashCommandsForBlocks,
  normalizeBlockByDefinition,
  validateBlockByDefinition,
  type SlashCommandDefinition
} from '@plim/blocks';
import {
  activeMenuItem,
  createMenuNavigationState,
  detectSlashTrigger,
  evaluateMarkdownInput,
  evaluateMarkdownInputAfterInsertion,
  moveMenuNavigation,
  type MenuNavigationState
} from '@plim/input';
import {
  adjacentEditableBlock,
  announceSelection,
  buildKeyboardReorderOperations,
  buildReorderOperations,
  createInternalBlockDragPayload,
  deriveSelectedBlockIds,
  makeRect,
  selectBlockRange,
  validateSelection,
  type BlockPositionDropTarget,
  type DragPayload
} from '@plim/selection';
import { queryDataSource, type ClientDatabaseState } from '@plim/databases';

const PERSISTENCE_KEY = 'plim.examples.basic-editor.snapshot';
const CARET_SENTINEL = '\u200B';
const supportedInsertTypes = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'divider'] as const satisfies readonly BlockType[];
type SupportedInsertType = (typeof supportedInsertTypes)[number];

interface InsertCatalogBlockArgs {
  readonly type: SupportedInsertType;
  readonly text?: string;
  readonly checked?: boolean;
  readonly parentId?: BlockId | PageId;
  readonly insertAfter?: BlockId;
}

const idFactory = createIdFactory({ prefix: 'example' });
const blockSlashCommands = getSlashCommandsForBlocks()
  .filter((command): command is SlashCommandDefinition<SupportedInsertType> => isSupportedInsertType(command.type));

const editorHost = mustElement<HTMLDivElement>('#editor');
const inputHint = mustElement<HTMLParagraphElement>('#input-hint');
const quickInput = mustElement<HTMLInputElement>('#quick-input');
const slashMenu = mustElement<HTMLDivElement>('#slash-menu');
const applyMarkdownButton = mustElement<HTMLButtonElement>('#apply-markdown');
const selectionAnnouncement = mustElement<HTMLParagraphElement>('#selection-announcement');
const blockDefinition = mustElement<HTMLPreElement>('#block-definition');
const databaseSummary = mustElement<HTMLParagraphElement>('#database-summary');
const databaseResults = mustElement<HTMLUListElement>('#database-results');
const persistenceStatus = mustElement<HTMLParagraphElement>('#persistence-status');

let editor: EditorFacade | undefined;
let persistence: PersistenceAdapter | undefined;
let pendingMarkdownOperations: readonly Operation[] = [];
let inlineSlashContext: { blockId: BlockId; element: HTMLElement; range: { start: number; end: number } } | undefined;
let dismissedSlashContext: { blockId: BlockId; range: { start: number; end: number }; text: string } | undefined;
let slashNavigation: MenuNavigationState = createMenuNavigationState(0);
let slashMenuItems: readonly SlashCommandDefinition<SupportedInsertType>[] = [];
let dragPayload: DragPayload | undefined;
let pointerDrag: PointerBlockDragState | undefined;
let suppressNextEditorHostClick = false;

interface PointerBlockDragState {
  readonly blockId: BlockId;
  readonly payload: DragPayload;
  readonly startX: number;
  readonly startY: number;
  activeTarget?: { element: HTMLElement; target: BlockPositionDropTarget };
}

const insertCatalogBlockCommand: Command<InsertCatalogBlockArgs> = {
  id: 'example.insertCatalogBlock',
  title: 'Insert catalog block',
  description: 'Creates a block from @plim/blocks defaults and validates it before dispatch.',
  category: 'basic',
  aliases: ['catalog block', 'validated block'],
  run(ctx, args) {
    const afterBlock = args.insertAfter ? ctx.state.document.blocks[args.insertAfter] : undefined;
    const parentId = args.parentId
      ?? (afterBlock ? parentContainerId(afterBlock.parent, ctx.editor.rootPageId) : ctx.editor.rootPageId);
    const at: InsertPosition = afterBlock ? { kind: 'after', siblingId: afterBlock.id } : { kind: 'append' };
    return {
      source: 'command',
      label: `insert ${args.type}`,
      undoable: true,
      operations: createInsertBlockOperations(ctx.state.document, parentId, args, at)
    };
  }
};

void bootstrap();

async function bootstrap(): Promise<void> {
  persistence = createLocalStoragePersistenceAdapter();
  const persisted = await persistence.load(PERSISTENCE_KEY);

  editor = createEditor({
    ...(persisted ? { snapshot: persisted } : { document: createStarterDocument() }),
    clientId: 'plim-basic-editor-example',
    persistence,
    persistenceKey: PERSISTENCE_KEY,
    commands: [insertCatalogBlockCommand],
    renderers: createExampleRenderers()
  });

  editor.on('change', () => updatePanels());
  editor.on('persistence', event => {
    persistenceStatus.textContent = `${event.status} with ${event.adapterId}${event.error ? `: ${event.error.message}` : ''}`;
  });
  persistence.watch?.(PERSISTENCE_KEY, event => {
    if (event.snapshot) {
      persistenceStatus.textContent = `Saved local snapshot at ${new Date(event.snapshot.generatedAt).toLocaleTimeString()}`;
    }
  });

  await editor.mount(editorHost);
  if (!persisted && topLevelBlocks().length === 0) await seedDocument();
  selectLastTopLevelBlock();
  bindControls();
  updatePanels();
  persistenceStatus.textContent = persisted ? 'Loaded a snapshot from localStorage.' : 'Started a new local document.';
}

function createStarterDocument(): DocumentState {
  return createEmptyDocument({
    title: 'Plim basic editor',
    workspaceName: 'Plim examples'
  });
}

async function seedDocument(): Promise<void> {
  await executeEditorCommand('example.insertCatalogBlock', {
    type: 'heading_1',
    text: 'Click here and type with Plim'
  });
  await executeEditorCommand('block.insertParagraph', {
    text: 'This is an editable document canvas. Change this text, then click away or press Enter to commit it.'
  });
  await executeEditorCommand('example.insertCatalogBlock', {
    type: 'to_do',
    text: 'Toggle me or edit this to-do text directly.',
    checked: false
  });
}

function bindControls(): void {
  mustElement<HTMLButtonElement>('#insert-paragraph').addEventListener('click', () => {
    void runAction('Inserted a paragraph with the built-in editor command.', async () => {
      await executeEditorCommand('block.insertParagraph', {
        text: `Paragraph inserted at ${new Date().toLocaleTimeString()}`
      });
      selectLastTopLevelBlock();
    });
  });

  mustElement<HTMLButtonElement>('#insert-todo').addEventListener('click', () => {
    void executeInsertType('to_do', 'Validated to-do from @plim/blocks defaults');
  });

  mustElement<HTMLButtonElement>('#insert-quote').addEventListener('click', () => {
    void executeInsertType('quote', 'A quote block created with model operations.');
  });

  mustElement<HTMLButtonElement>('#insert-paragraph-inline').addEventListener('click', () => {
    void executeInsertType('paragraph', '');
  });

  mustElement<HTMLButtonElement>('#insert-todo-inline').addEventListener('click', () => {
    void executeInsertType('to_do', 'New to-do');
  });

  mustElement<HTMLButtonElement>('#insert-quote-inline').addEventListener('click', () => {
    void executeInsertType('quote', 'New quote');
  });

  applyMarkdownButton.addEventListener('click', () => {
    const operations = [...pendingMarkdownOperations];
    void runAction('Applied markdown helper operations to the selected block.', async () => {
      if (operations.length === 0) throw new Error('No markdown operation is available for the current input.');
      const result = await requireEditor().dispatch({
        source: 'input',
        label: 'apply markdown input helper',
        undoable: true,
        operations
      });
      ensureTransactionResult(result);
      quickInput.value = '';
      pendingMarkdownOperations = [];
      applyMarkdownButton.disabled = true;
    });
  });

  mustElement<HTMLButtonElement>('#save-snapshot').addEventListener('click', () => {
    void runAction('Saved the current editor snapshot to localStorage.', async () => {
      const activeEditor = requireEditor();
      const activePersistence = requirePersistence();
      const snapshot = { ...activeEditor.exportSnapshot(), persistenceKey: PERSISTENCE_KEY } satisfies PersistedSnapshot;
      await activePersistence.save(PERSISTENCE_KEY, snapshot);
    });
  });

  mustElement<HTMLButtonElement>('#reset-snapshot').addEventListener('click', () => {
    void runAction('Reset the local document and replaced the saved snapshot.', async () => {
      const activeEditor = requireEditor();
      const activePersistence = requirePersistence();
      await activePersistence.remove?.(PERSISTENCE_KEY);
      ensureTransactionResult(activeEditor.setDocument(createStarterDocument(), { markDirty: false }));
      await seedDocument();
      selectLastTopLevelBlock();
    });
  });

  editorHost.addEventListener('click', event => {
    if (suppressNextEditorHostClick) {
      suppressNextEditorHostClick = false;
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && target.hasAttribute('data-plim-editor')) {
      void runAction('Added an empty paragraph from the blank editor canvas.', async () => {
        const blockId = await insertCatalogBlock({ type: 'paragraph', text: '' });
        applyBlockSelection(blockId);
        focusEditableBlock(blockId);
      });
    }
  });

  quickInput.addEventListener('input', updateInputHints);
  quickInput.addEventListener('keyup', updateInputHints);
  quickInput.addEventListener('click', updateInputHints);
}

async function executeInsertType(type: SupportedInsertType, text: string): Promise<void> {
  await runAction(`Inserted ${type} through the registered example command.`, async () => {
    const result = await executeEditorCommand('example.insertCatalogBlock', {
      type,
      text,
      checked: false,
      insertAfter: selectedEditorBlock()?.id
    });
    const insertedBlockId = createdBlockIdFromCommand(result);
    if (insertedBlockId) {
      applyBlockSelection(insertedBlockId);
      focusEditableBlock(insertedBlockId);
    } else {
      selectLastTopLevelBlock();
    }
  });
}

function createInsertBlockOperations(
  state: DocumentState,
  parentId: BlockId | PageId,
  args: InsertCatalogBlockArgs,
  at: InsertPosition = { kind: 'append' }
): Operation[] {
  const definition = getBlockDefinition(args.type);
  if (!definition?.modelBacked) throw new Error(`${args.type} is not backed by @plim/model.`);

  let data = createDefaultBlockData(args.type);
  if ('richText' in data && args.text !== undefined) {
    data = { ...data, richText: richTextFromPlainText(args.text) };
  }
  if (args.type === 'to_do') {
    data = { ...data, checked: args.checked ?? false };
  }

  const normalized = normalizeBlockByDefinition(args.type, data);
  const issues = validateBlockByDefinition(args.type, normalized, { childTypes: [] });
  const blockingIssue = issues.find(issue => issue.severity === 'error');
  if (blockingIssue) throw new Error(blockingIssue.message);

  const block = createBlock({
    workspaceId: state.workspace.id,
    parent: parentRefFor(state, parentId),
    type: args.type,
    data: normalized,
    idFactory
  });

  return [
    { op: 'create_block', block },
    { op: 'insert_child', parentId, childId: block.id, at }
  ];
}

function createExampleRenderers(): Renderer[] {
  return [
    createPageRenderer(),
    createTextRenderer('paragraph'),
    createTextRenderer('heading_1'),
    createTextRenderer('heading_2'),
    createTextRenderer('heading_3'),
    createTextRenderer('bulleted_list_item'),
    createTextRenderer('numbered_list_item'),
    createTextRenderer('quote'),
    createTextRenderer('to_do'),
    createDividerRenderer()
  ];
}

function createPageRenderer(): Renderer<BlockRecord<'page'>> {
  return {
    id: 'example.renderer.page',
    blockType: 'page',
    mode: 'both',
    render(ctx) {
      const page = ctx.domDocument.createElement('article');
      page.className = 'notion-page';
      page.setAttribute('data-plim-block-id', String(ctx.block.id));
      page.setAttribute('data-plim-block-type', ctx.block.type);
      page.setAttribute('role', 'article');

      const title = ctx.domDocument.createElement('h1');
      title.className = 'page-title';
      title.contentEditable = 'true';
      title.spellcheck = true;
      title.dataset.placeholder = 'Untitled';
      title.setAttribute('aria-label', 'Edit page title');
      title.textContent = textForBlock(ctx.block);
      title.addEventListener('paste', event => {
        const clipboardEvent = event as ClipboardEvent;
        const text = clipboardEvent.clipboardData?.getData('text/plain');
        if (text === undefined) return;
        clipboardEvent.preventDefault();
        insertPlainTextAtSelection(text);
      });
      title.addEventListener('blur', () => {
        void commitPageTitle(ctx.block, title);
      });
      title.addEventListener('keydown', event => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Enter') return;
        keyboardEvent.preventDefault();
        void runAction('Committed the page title and focused the first block.', async () => {
          await commitPageTitle(ctx.block, title);
          const first = topLevelBlocks()[0];
          if (first) focusEditableBlock(first.id);
          else focusEditableBlock(await insertCatalogBlock({ type: 'paragraph', text: '' }));
        });
      });

      page.append(title);
      return page;
    }
  };
}

function createTextRenderer(blockType: Exclude<SupportedInsertType, 'divider'>): Renderer {
  return {
    id: `example.renderer.${blockType}`,
    blockType,
    mode: 'both',
    render(ctx) {
      const element = ctx.domDocument.createElement('section');
      element.className = 'plim-example-block';
      element.tabIndex = 0;
      element.setAttribute('role', isHeadingBlockType(blockType) ? 'heading' : 'group');
      const headingLevel = headingLevelFor(blockType);
      if (headingLevel) element.setAttribute('aria-level', String(headingLevel));
      element.setAttribute('data-plim-block-id', String(ctx.block.id));
      element.setAttribute('data-plim-block-type', ctx.block.type);
      if (isEditorBlockSelected(ctx.block.id)) element.classList.add('is-selected');

      const affordance = createBlockAffordance(ctx);
      const content = ctx.domDocument.createElement('div');
      content.className = 'block-content';

      if (blockType === 'to_do') {
        const row = ctx.domDocument.createElement('div');
        row.className = 'todo-row';
        const checkbox = ctx.domDocument.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', 'Toggle to-do');
        checkbox.checked = Boolean((ctx.block.data as { checked?: boolean }).checked);
        const editable = createEditableTextElement(ctx, 'span', 'To-do text');
        checkbox.addEventListener('mousedown', event => {
          event.preventDefault();
          event.stopPropagation();
        });
        checkbox.addEventListener('click', event => {
          event.stopPropagation();
          void runAction('Updated the to-do block with an update_block operation.', async () => {
            const result = await ctx.editor.dispatch({
              source: 'input',
              label: 'toggle to-do',
              undoable: true,
              operations: [{
                op: 'update_block',
                blockId: ctx.block.id,
                patch: { data: { checked: checkbox.checked, richText: richTextFromPlainText(normalizedEditableText(editable)) } }
              }]
            });
            ensureTransactionResult(result);
          });
        });
        row.append(checkbox, editable);
        content.append(row);
      } else if (blockType === 'heading_1') {
        content.append(createEditableTextElement(ctx, 'h2', 'Heading 1'));
      } else if (blockType === 'heading_2') {
        content.append(createEditableTextElement(ctx, 'h3', 'Heading 2'));
      } else if (blockType === 'heading_3') {
        content.append(createEditableTextElement(ctx, 'h4', 'Heading 3'));
      } else if (blockType === 'quote') {
        content.append(createEditableTextElement(ctx, 'blockquote', 'Quote'));
      } else if (blockType === 'bulleted_list_item' || blockType === 'numbered_list_item') {
        const row = ctx.domDocument.createElement('div');
        row.className = 'list-row';
        const marker = ctx.domDocument.createElement('span');
        marker.className = 'list-marker';
        marker.textContent = blockType === 'bulleted_list_item' ? '•' : '1.';
        marker.setAttribute('aria-hidden', 'true');
        row.append(marker, createEditableTextElement(ctx, 'p', blockType === 'bulleted_list_item' ? 'List item' : 'Numbered item'));
        content.append(row);
      } else {
        content.append(createEditableTextElement(ctx, 'p', 'Type something...'));
      }
      element.append(affordance, content);

      element.addEventListener('click', () => applyBlockSelection(ctx.block.id));
      element.addEventListener('dragover', event => handleBlockDragOver(ctx, element, event as DragEvent));
      element.addEventListener('dragleave', () => clearDropIndicator(element));
      element.addEventListener('drop', event => {
        void handleBlockDrop(ctx, element, event as DragEvent);
      });
      element.addEventListener('keydown', event => {
        if (event.target !== element) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          applyBlockSelection(ctx.block.id);
        }
      });
      return element;
    }
  };
}

function createDividerRenderer(): Renderer<BlockRecord<'divider'>> {
  return {
    id: 'example.renderer.divider',
    blockType: 'divider',
    mode: 'both',
    render(ctx) {
      const element = ctx.domDocument.createElement('section');
      element.className = 'plim-example-block';
      element.tabIndex = 0;
      element.setAttribute('role', 'separator');
      element.setAttribute('data-plim-block-id', String(ctx.block.id));
      element.setAttribute('data-plim-block-type', ctx.block.type);
      if (isEditorBlockSelected(ctx.block.id)) element.classList.add('is-selected');
      const content = ctx.domDocument.createElement('div');
      content.className = 'block-content';
      content.append(ctx.domDocument.createElement('hr'));
      element.append(createBlockAffordance(ctx), content);
      element.addEventListener('click', () => applyBlockSelection(ctx.block.id));
      element.addEventListener('dragover', event => handleBlockDragOver(ctx, element, event as DragEvent));
      element.addEventListener('dragleave', () => clearDropIndicator(element));
      element.addEventListener('drop', event => {
        void handleBlockDrop(ctx, element, event as DragEvent);
      });
      return element;
    }
  };
}

function createBlockAffordance(ctx: RendererContext): HTMLElement {
  const affordance = ctx.domDocument.createElement('div');
  affordance.className = 'block-affordance';

  const add = ctx.domDocument.createElement('button');
  add.type = 'button';
  add.title = 'Add block below';
  add.setAttribute('aria-label', 'Add block below');
  add.textContent = '+';
  add.addEventListener('click', event => {
    event.stopPropagation();
    void runAction('Inserted a new paragraph below the current block.', async () => {
      const blockId = await insertCatalogBlock({ type: 'paragraph', text: '', insertAfter: ctx.block.id });
      applyBlockSelection(blockId);
      focusEditableBlock(blockId);
    });
  });

  const handle = ctx.domDocument.createElement('button');
  handle.type = 'button';
  handle.title = 'Block handle';
  handle.setAttribute('aria-label', 'Drag block to reorder');
  handle.draggable = true;
  handle.textContent = '⋮⋮';
  handle.addEventListener('click', event => {
    event.stopPropagation();
    applyBlockSelection(ctx.block.id);
  });
  handle.addEventListener('dragstart', event => {
    startBlockDrag(ctx.block.id, event as DragEvent);
  });
  handle.addEventListener('pointerdown', event => {
    startPointerBlockDrag(ctx.block.id, event as PointerEvent);
  });
  handle.addEventListener('mousedown', event => {
    startMouseBlockDrag(ctx.block.id, event as MouseEvent);
  });
  handle.addEventListener('dragend', () => {
    dragPayload = undefined;
    document.querySelectorAll<HTMLElement>('.plim-example-block.is-drop-before, .plim-example-block.is-drop-after')
      .forEach(clearDropIndicator);
  });

  const moveUp = createMoveButton(ctx, 'previous');
  const moveDown = createMoveButton(ctx, 'next');

  affordance.append(add, handle, moveUp, moveDown);
  return affordance;
}

function createMoveButton(ctx: RendererContext, direction: 'previous' | 'next'): HTMLButtonElement {
  const button = ctx.domDocument.createElement('button');
  button.type = 'button';
  button.title = direction === 'previous' ? 'Move block up' : 'Move block down';
  button.setAttribute('aria-label', direction === 'previous' ? 'Move block up' : 'Move block down');
  button.textContent = direction === 'previous' ? '↑' : '↓';
  button.addEventListener('click', event => {
    event.stopPropagation();
    void runAction(button.title, async () => {
      const operations = buildKeyboardReorderOperations(requireEditor().state.document, ctx.block.id, direction);
      if (operations.length === 0) return;
      const result = await requireEditor().dispatch({
        source: 'input',
        label: button.title,
        undoable: true,
        operations
      });
      ensureTransactionResult(result);
      applyBlockSelection(ctx.block.id);
      focusEditableBlock(ctx.block.id, 'start');
    });
  });
  return button;
}

function createEditableTextElement(
  ctx: RendererContext,
  tagName: 'blockquote' | 'h2' | 'h3' | 'h4' | 'p' | 'span',
  placeholder: string
): HTMLElement {
  const editable = ctx.domDocument.createElement(tagName);
  editable.className = 'editable-block-text';
  editable.contentEditable = 'true';
  editable.spellcheck = true;
  editable.dataset.plimEditable = 'true';
  editable.dataset.placeholder = placeholder;
  editable.setAttribute('role', 'textbox');
  editable.setAttribute('aria-multiline', 'true');
  editable.setAttribute('aria-label', `Edit ${getBlockDefinition(ctx.block.type)?.label ?? ctx.block.type}`);
  const roleDescription = editableRoleDescription(ctx.block.type);
  if (roleDescription) editable.setAttribute('aria-roledescription', roleDescription);
  editable.textContent = textForBlock(ctx.block);

  editable.addEventListener('click', event => event.stopPropagation());
  editable.addEventListener('focus', () => {
    applyBlockSelection(ctx.block.id);
    updateInlineSlashMenu(ctx.block, editable);
  });
  editable.addEventListener('beforeinput', event => {
    const inputEvent = event as InputEvent;
    if (inputEvent.inputType === 'insertLineBreak') {
      inputEvent.preventDefault();
      insertTextIntoEditable(editable, '\n');
      updateInlineSlashMenu(ctx.block, editable);
      return;
    }
    if (inputEvent.inputType !== 'insertText' || !inputEvent.data) return;
    const selectionOffsets = editableSelectionOffsets(editable);
    if (!selectionOffsets) return;
    const markdown = evaluateMarkdownInputAfterInsertion({
      text: editable.textContent ?? '',
      caretOffset: selectionOffsets.start,
      selectionStart: selectionOffsets.start,
      selectionEnd: selectionOffsets.end,
      insertedText: inputEvent.data,
      blockId: ctx.block.id,
      blockType: ctx.block.type
    });
    if (!markdown || markdown.kind !== 'block-transform') return;
    inputEvent.preventDefault();
    hideSlashMenu();
    editable.textContent = applyMarkdownRangeRemoval(
      editable.textContent ?? '',
      inputEvent.data,
      selectionOffsets.start,
      selectionOffsets.end,
      markdown.range
    );
    void runAction(`Applied ${markdown.ruleId} while typing.`, async () => {
      const result = await ctx.editor.dispatch({
        source: 'input',
        label: markdown.ruleId,
        undoable: true,
        operations: markdown.operations
      });
      ensureTransactionResult(result);
      focusEditableBlock(ctx.block.id, 'start');
    });
  });
  editable.addEventListener('input', () => {
    removeCaretSentinels(editable);
    updateInlineSlashMenu(ctx.block, editable);
  });
  editable.addEventListener('keyup', () => updateInlineSlashMenu(ctx.block, editable));
  editable.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!slashMenu.matches(':hover')) hideSlashMenu();
    }, 100);
    void commitEditableText(ctx.block, editable, 'blur');
  });
  editable.addEventListener('paste', event => {
    const clipboardEvent = event as ClipboardEvent;
    const text = clipboardEvent.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    clipboardEvent.preventDefault();
    insertTextIntoEditable(editable, text);
  });
  editable.addEventListener('keydown', event => {
    const keyboardEvent = event as KeyboardEvent;
    if (inlineSlashContext?.blockId === ctx.block.id && slashMenu.classList.contains('is-open')) {
      if (handleSlashMenuKeydown(keyboardEvent, ctx.block, editable)) return;
    }
    if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key.toLowerCase() === 's') {
      keyboardEvent.preventDefault();
      mustElement<HTMLButtonElement>('#save-snapshot').click();
      return;
    }
    if (keyboardEvent.key === 'Escape') {
      hideSlashMenu({ dismissCurrent: true });
      return;
    }
    if (handleBackspaceAtBlockStart(keyboardEvent, ctx.block, editable)) return;
    if (handleBlockBoundaryNavigation(keyboardEvent, ctx.block, editable)) return;
    if (keyboardEvent.key === 'Enter' && keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      insertTextIntoEditable(editable, '\n');
      updateInlineSlashMenu(ctx.block, editable);
      return;
    }
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      if (handleEnterBlockSplit(keyboardEvent, ctx.block, editable)) return;
    }
  });

  return editable;
}

async function commitEditableText(block: BlockRecord, editable: HTMLElement, reason: 'blur' | 'enter'): Promise<void> {
  removeCaretSentinels(editable);
  const nextText = normalizedEditableText(editable);
  if (nextText === textForBlock(block)) return;
  const result = await requireEditor().dispatch({
    source: 'input',
    label: `edit ${block.type} text on ${reason}`,
    undoable: true,
    operations: [{
      op: 'update_block',
      blockId: block.id,
      patch: { data: { richText: richTextFromPlainText(nextText) } }
    }]
  });
  ensureTransactionResult(result);
}

async function commitPageTitle(block: BlockRecord<'page'>, titleElement: HTMLElement): Promise<void> {
  const nextTitle = titleElement.textContent?.trim() || 'Untitled';
  if (nextTitle === textForBlock(block)) return;
  const title = richTextFromPlainText(nextTitle);
  const titleValue: PagePropertyValue = { id: TITLE_PROPERTY_ID, type: 'title', title };
  const result = await requireEditor().dispatch({
    source: 'input',
    label: 'edit page title',
    undoable: true,
    operations: [
      { op: 'update_block', blockId: block.id, patch: { data: { title } } },
      {
        op: 'update_page',
        pageId: block.id as PageId,
        patch: {
          titlePlain: nextTitle,
          properties: { [TITLE_PROPERTY_ID]: titleValue }
        }
      }
    ]
  });
  ensureTransactionResult(result);
}

function updateInlineSlashMenu(block: BlockRecord, editable: HTMLElement): void {
  const text = normalizedEditableText(editable);
  const slash = detectSlashTrigger(text, text.length, { blockType: block.type });
  if (!slash || slash.escaped) {
    if (inlineSlashContext?.blockId === block.id) hideSlashMenu();
    return;
  }
  if (dismissedSlashContext
    && dismissedSlashContext.blockId === block.id
    && dismissedSlashContext.text === text
    && dismissedSlashContext.range.start === slash.range.start
    && dismissedSlashContext.range.end === slash.range.end) {
    return;
  }
  dismissedSlashContext = undefined;
  inlineSlashContext = { blockId: block.id, element: editable, range: slash.range };
  editable.setAttribute('aria-controls', slashMenu.id);
  editable.setAttribute('aria-expanded', 'true');
  renderSlashMenu(slash.query, 'inline');
  positionSlashMenu(editable);
}

function hideSlashMenu(options: { dismissCurrent?: boolean } = {}): void {
  if (options.dismissCurrent && inlineSlashContext) {
    dismissedSlashContext = {
      blockId: inlineSlashContext.blockId,
      range: inlineSlashContext.range,
      text: normalizedEditableText(inlineSlashContext.element)
    };
  }
  inlineSlashContext?.element.setAttribute('aria-expanded', 'false');
  inlineSlashContext?.element.removeAttribute('aria-activedescendant');
  inlineSlashContext = undefined;
  slashMenuItems = [];
  slashNavigation = createMenuNavigationState(0);
  slashMenu.classList.remove('is-open');
  slashMenu.removeAttribute('role');
  slashMenu.removeAttribute('aria-label');
  slashMenu.replaceChildren();
}

function positionSlashMenu(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 360);
  const top = Math.min(rect.bottom + 6, window.innerHeight - 320);
  slashMenu.style.left = `${left}px`;
  slashMenu.style.top = `${Math.max(12, top)}px`;
}

async function consumeInlineSlashText(): Promise<BlockId | undefined> {
  const context = inlineSlashContext;
  if (!context) return undefined;
  const text = context.element.textContent ?? '';
  const nextText = `${text.slice(0, context.range.start)}${text.slice(context.range.end)}`.trimStart();
  context.element.textContent = nextText;
  const block = requireEditor().state.document.blocks[context.blockId];
  if (block) await commitEditableText(block, context.element, 'blur');
  hideSlashMenu();
  return context.blockId;
}

async function insertCatalogBlock(args: InsertCatalogBlockArgs): Promise<BlockId> {
  const activeEditor = requireEditor();
  const state = activeEditor.state.document;
  const afterBlock = args.insertAfter ? state.blocks[args.insertAfter] : undefined;
  const parentId = args.parentId
    ?? (afterBlock ? parentContainerId(afterBlock.parent, activeEditor.rootPageId) : activeEditor.rootPageId);
  const at: InsertPosition = afterBlock ? { kind: 'after', siblingId: afterBlock.id } : { kind: 'append' };
  const operations = createInsertBlockOperations(state, parentId, args, at);
  const created = operations.find((operation): operation is Extract<Operation, { op: 'create_block' }> => operation.op === 'create_block');
  if (!created) throw new Error('Expected create_block operation.');
  const result = await activeEditor.dispatch({
    source: 'input',
    label: `insert editable ${args.type}`,
    undoable: true,
    operations
  });
  ensureTransactionResult(result);
  return created.block.id;
}

function createdBlockIdFromCommand(result: CommandResult): BlockId | undefined {
  if (!result.ok) return undefined;
  const transaction = result.transaction;
  if (!transaction?.ok) return undefined;
  return transaction.transaction.operations
    .find((operation): operation is Extract<Operation, { op: 'create_block' }> => operation.op === 'create_block')
    ?.block.id;
}

function parentContainerId(parent: ParentRef, fallbackPageId: PageId): BlockId | PageId {
  if (parent.kind === 'block') return parent.blockId;
  if (parent.kind === 'page') return parent.pageId;
  return fallbackPageId;
}

function focusEditableBlock(blockId: BlockId, placement: CaretPlacement = 'end'): void {
  requestAnimationFrame(() => {
    const blockElement = [...document.querySelectorAll<HTMLElement>('[data-plim-block-id]')]
      .find(element => element.dataset.plimBlockId === String(blockId));
    const editable = blockElement?.querySelector<HTMLElement>('[data-plim-editable="true"]');
    if (!editable) return;
    placeCaretInEditable(editable, normalizeCaretPlacement(placement));
  });
}

function focusEditableBlockAtOffset(blockId: BlockId, offset: number): void {
  requestAnimationFrame(() => {
    const blockElement = [...document.querySelectorAll<HTMLElement>('[data-plim-block-id]')]
      .find(element => element.dataset.plimBlockId === String(blockId));
    const editable = blockElement?.querySelector<HTMLElement>('[data-plim-editable="true"]');
    if (!editable) return;
    editable.focus();
    setCaretAtTextOffset(editable, offset);
  });
}

function handleEnterBlockSplit(event: KeyboardEvent, block: BlockRecord, editable: HTMLElement): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  const selectionOffsets = editableSelectionOffsets(editable);
  if (!selectionOffsets) return false;

  event.preventDefault();
  hideSlashMenu();
  removeCaretSentinels(editable);
  const text = normalizedEditableText(editable);
  const start = clampNumber(selectionOffsets.start, 0, text.length);
  const end = clampNumber(selectionOffsets.end, start, text.length);
  const before = text.slice(0, start);
  const after = text.slice(end);
  editable.textContent = before;
  const activeEditor = requireEditor();
  const continuation = continuationBlockForSplit(block);
  const parentId = parentContainerId(block.parent, activeEditor.rootPageId);
  const operations: Operation[] = [
    { op: 'update_block', blockId: block.id, patch: { data: { richText: richTextFromPlainText(before) } } },
    ...createInsertBlockOperations(
      activeEditor.state.document,
      parentId,
      continuation.type === 'to_do'
        ? { type: continuation.type, text: after, checked: false }
        : { type: continuation.type, text: after },
      { kind: 'after', siblingId: block.id }
    )
  ];
  const created = operations.find((operation): operation is Extract<Operation, { op: 'create_block' }> => operation.op === 'create_block');
  if (!created) return false;

  void runAction('Split the block at the caret.', async () => {
    const result = await activeEditor.dispatch({
      source: 'input',
      label: 'split block with enter',
      undoable: true,
      operations
    });
    ensureTransactionResult(result);
    applyBlockSelection(created.block.id);
    focusEditableBlock(created.block.id, 'start');
  });
  return true;
}

function continuationBlockForSplit(block: BlockRecord): { type: SupportedInsertType } {
  if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item' || block.type === 'to_do') return { type: block.type };
  return { type: 'paragraph' };
}

function handleBackspaceAtBlockStart(event: KeyboardEvent, block: BlockRecord, editable: HTMLElement): boolean {
  if (event.key !== 'Backspace' || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!isCaretAtTextBoundary(editable, 'start')) return false;
  const activeEditor = requireEditor();
  const target = adjacentEditableBlock(activeEditor.state.document, block.id, 'previous', activeEditor.rootPageId);
  if (!target) return false;
  const previousBlock = activeEditor.state.document.blocks[target.blockId];
  if (!previousBlock || !hasEditableRichText(previousBlock)) return false;

  event.preventDefault();
  hideSlashMenu();
  removeCaretSentinels(editable);
  const currentText = normalizedEditableText(editable);
  const previousText = renderedTextForBlock(previousBlock);
  const parentId = parentContainerId(block.parent, activeEditor.rootPageId);
  const operations: Operation[] = currentText.length === 0
    ? [{ op: 'remove_child', parentId, childId: block.id, mode: 'delete' }]
    : [
        { op: 'update_block', blockId: previousBlock.id, patch: { data: { richText: richTextFromPlainText(`${previousText}${currentText}`) } } },
        { op: 'remove_child', parentId, childId: block.id, mode: 'delete' }
      ];

  void runAction(currentText.length === 0 ? 'Deleted empty block with Backspace.' : 'Merged block with previous block.', async () => {
    const result = await activeEditor.dispatch({
      source: 'input',
      label: currentText.length === 0 ? 'delete empty block with backspace' : 'merge block with previous block',
      undoable: true,
      operations
    });
    ensureTransactionResult(result);
    applyBlockSelection(previousBlock.id);
    if (currentText.length === 0) focusEditableBlock(previousBlock.id, 'end');
    else focusEditableBlockAtOffset(previousBlock.id, previousText.length);
  });
  return true;
}

function handleBlockBoundaryNavigation(event: KeyboardEvent, block: BlockRecord, editable: HTMLElement): boolean {
  const navigation = navigationIntentFor(event.key, editable);
  if (!navigation) return false;
  const target = adjacentEditableBlock(requireEditor().state.document, block.id, navigation.direction, requireEditor().rootPageId);
  if (!target) return false;
  event.preventDefault();
  void runAction('Moved the caret across block boundaries.', async () => {
    await commitEditableText(block, editable, 'blur');
    applyBlockSelection(target.blockId);
    focusEditableBlock(target.blockId, navigation.preferredClientX === undefined
      ? target.boundary
      : { boundary: target.boundary, preferredClientX: navigation.preferredClientX });
  });
  return true;
}

type CaretBoundary = 'start' | 'end';
type CaretPlacement = CaretBoundary | { boundary: CaretBoundary; preferredClientX?: number };

interface BlockNavigationIntent {
  readonly direction: 'previous' | 'next';
  readonly preferredClientX?: number;
}

function navigationIntentFor(key: string, editable: HTMLElement): BlockNavigationIntent | undefined {
  if (key === 'ArrowLeft' && isCaretAtTextBoundary(editable, 'start')) return { direction: 'previous' };
  if (key === 'ArrowRight' && isCaretAtTextBoundary(editable, 'end')) return { direction: 'next' };
  if (key === 'ArrowUp') {
    const rect = caretRectInEditable(editable);
    if (rect && isCaretOnVisualBoundary(editable, rect, 'start')) return { direction: 'previous', preferredClientX: rect.left };
  }
  if (key === 'ArrowDown') {
    const rect = caretRectInEditable(editable);
    if (rect && isCaretOnVisualBoundary(editable, rect, 'end')) return { direction: 'next', preferredClientX: rect.left };
  }
  return undefined;
}

function isCaretAtTextBoundary(element: HTMLElement, boundary: CaretBoundary): boolean {
  const offsets = editableSelectionOffsets(element);
  if (!offsets || offsets.start !== offsets.end) return false;
  const textLength = element.textContent?.length ?? 0;
  return boundary === 'start' ? offsets.start === 0 : offsets.end === textLength;
}

function isCaretOnVisualBoundary(element: HTMLElement, caretRect: DOMRect, boundary: CaretBoundary): boolean {
  const offsets = editableSelectionOffsets(element);
  if (!offsets || offsets.start !== offsets.end) return false;
  if ((element.textContent ?? '').length === 0) return true;
  const rect = element.getBoundingClientRect();
  const threshold = Math.max(4, lineHeightFor(element) * 0.65);
  return boundary === 'start'
    ? caretRect.top <= rect.top + threshold
    : caretRect.bottom >= rect.bottom - threshold;
}

function caretRectInEditable(element: HTMLElement): DOMRect | undefined {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || (!element.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== element)) return undefined;
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  return element.getBoundingClientRect();
}

function editableSelectionOffsets(element: HTMLElement): { start: number; end: number } | undefined {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== element) return undefined;
  return {
    start: textLengthBeforeRangeBoundary(element, range.startContainer, range.startOffset),
    end: textLengthBeforeRangeBoundary(element, range.endContainer, range.endOffset)
  };
}

function applyMarkdownRangeRemoval(text: string, insertedText: string, selectionStart: number, selectionEnd: number, range: { start: number; end: number }): string {
  const nextText = `${text.slice(0, selectionStart)}${insertedText}${text.slice(selectionEnd)}`;
  return `${nextText.slice(0, range.start)}${nextText.slice(range.end)}`;
}

function insertTextIntoEditable(element: HTMLElement, text: string): void {
  const offsets = editableSelectionOffsets(element);
  if (!offsets) {
    element.textContent = `${element.textContent ?? ''}${text}`;
    setCaretAtTextOffset(element, element.textContent.length);
    return;
  }
  const current = element.textContent ?? '';
  const before = current.slice(0, offsets.start);
  const after = current.slice(offsets.end);
  if (text.includes('\n')) {
    const beforeNode = element.ownerDocument.createTextNode(`${before}${text}`);
    const afterNode = element.ownerDocument.createTextNode(`${CARET_SENTINEL}${after}`);
    element.replaceChildren(beforeNode, afterNode);
    const selection = element.ownerDocument.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    range.setStart(afterNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  element.textContent = `${before}${text}${after}`;
  setCaretAtTextOffset(element, before.length + text.length);
}

function removeCaretSentinels(element: HTMLElement): void {
  const current = element.textContent ?? '';
  if (!current.includes(CARET_SENTINEL)) return;
  const offsets = editableSelectionOffsets(element);
  const normalized = stripCaretSentinels(current);
  const nextOffset = offsets
    ? offsets.start - countSentinelsBefore(current, offsets.start)
    : normalized.length;
  element.textContent = normalized;
  setCaretAtTextOffset(element, nextOffset);
}

function normalizedEditableText(element: HTMLElement): string {
  return stripCaretSentinels(element.textContent ?? '');
}

function stripCaretSentinels(text: string): string {
  return text.replaceAll(CARET_SENTINEL, '');
}

function countSentinelsBefore(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === CARET_SENTINEL) count += 1;
  }
  return count;
}

function setCaretAtTextOffset(element: HTMLElement, offset: number): void {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  if (!element.firstChild) element.append(element.ownerDocument.createTextNode(''));
  const range = element.ownerDocument.createRange();
  const target = textNodeAtOffset(element, offset);
  range.setStart(target.node, target.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function textNodeAtOffset(element: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let current = walker.nextNode();
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (remaining <= length) return { node: current, offset: remaining };
    remaining -= length;
    current = walker.nextNode();
  }
  return { node: element, offset: element.childNodes.length };
}

function renderedTextForBlock(block: BlockRecord): string {
  const blockElement = [...document.querySelectorAll<HTMLElement>('[data-plim-block-id]')]
    .find(element => element.dataset.plimBlockId === String(block.id));
  const editable = blockElement?.querySelector<HTMLElement>('[data-plim-editable="true"]');
  return editable ? normalizedEditableText(editable) : textForBlock(block);
}

function hasEditableRichText(block: BlockRecord): boolean {
  return Array.isArray((block.data as { richText?: RichText }).richText);
}

function textLengthBeforeRangeBoundary(root: HTMLElement, container: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function normalizeCaretPlacement(placement: CaretPlacement): { boundary: CaretBoundary; preferredClientX?: number } {
  return typeof placement === 'string' ? { boundary: placement } : placement;
}

function placeCaretInEditable(element: HTMLElement, placement: { boundary: CaretBoundary; preferredClientX?: number }): void {
  element.focus();
  if (typeof placement.preferredClientX === 'number') {
    const range = rangeFromVisualPoint(element, placement);
    if (range) {
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
  }
  if (placement.boundary === 'start') moveCaretToStart(element);
  else moveCaretToEnd(element);
}

function rangeFromVisualPoint(element: HTMLElement, placement: { boundary: CaretBoundary; preferredClientX?: number }): Range | undefined {
  const rect = element.getBoundingClientRect();
  const x = clampNumber(placement.preferredClientX ?? rect.left, rect.left + 1, rect.right - 1);
  const y = placement.boundary === 'start'
    ? rect.top + Math.min(lineHeightFor(element) / 2, Math.max(1, rect.height / 2))
    : rect.bottom - Math.min(lineHeightFor(element) / 2, Math.max(1, rect.height / 2));
  const range = caretRangeFromPoint(element.ownerDocument, x, y);
  if (!range) return undefined;
  return element.contains(range.commonAncestorContainer) || range.commonAncestorContainer === element ? range : undefined;
}

function caretRangeFromPoint(domDocument: Document, x: number, y: number): Range | undefined {
  const pointDocument = domDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = pointDocument.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = domDocument.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return pointDocument.caretRangeFromPoint?.(x, y) ?? undefined;
}

function lineHeightFor(element: HTMLElement): number {
  const styles = getComputedStyle(element);
  const parsedLineHeight = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(parsedLineHeight)) return parsedLineHeight;
  const parsedFontSize = Number.parseFloat(styles.fontSize);
  return Number.isFinite(parsedFontSize) ? parsedFontSize * 1.2 : 20;
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(Math.max(value, min), max);
}

function moveCaretToStart(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function moveCaretToEnd(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function startBlockDrag(blockId: BlockId, event: DragEvent): void {
  const activeEditor = requireEditor();
  const selection = selectBlockRange(activeEditor.state.document, blockId, blockId, { traversalScopeRootId: activeEditor.rootPageId });
  dragPayload = createInternalBlockDragPayload(`example-drag-${String(blockId)}-${Date.now()}`, selection, [blockId], { createdAt: Date.now() });
  applyBlockSelection(blockId);
  if (event.dataTransfer) {
    const draggedBlock = activeEditor.state.document.blocks[blockId];
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedBlock ? textForBlock(draggedBlock) : String(blockId));
  }
}

function startPointerBlockDrag(blockId: BlockId, event: PointerEvent): void {
  if (pointerDrag) return;
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  beginBlockPointerDrag(blockId, event.clientX, event.clientY);
  document.addEventListener('pointermove', handlePointerBlockDragMove);
  document.addEventListener('pointerup', handlePointerBlockDragEnd, { once: true });
  document.addEventListener('pointercancel', cancelPointerBlockDrag, { once: true });
}

function startMouseBlockDrag(blockId: BlockId, event: MouseEvent): void {
  if (pointerDrag) return;
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  beginBlockPointerDrag(blockId, event.clientX, event.clientY);
  document.addEventListener('mousemove', handleMouseBlockDragMove);
  document.addEventListener('mouseup', handleMouseBlockDragEnd, { once: true });
}

function beginBlockPointerDrag(blockId: BlockId, startX: number, startY: number): void {
  const activeEditor = requireEditor();
  const selection = selectBlockRange(activeEditor.state.document, blockId, blockId, { traversalScopeRootId: activeEditor.rootPageId });
  pointerDrag = {
    blockId,
    payload: createInternalBlockDragPayload(`example-pointer-drag-${String(blockId)}-${Date.now()}`, selection, [blockId], { createdAt: Date.now() }),
    startX,
    startY
  };
  applyBlockSelection(blockId);
}

function handlePointerBlockDragMove(event: PointerEvent): void {
  updatePointerBlockDrag(event.clientX, event.clientY);
}

function handleMouseBlockDragMove(event: MouseEvent): void {
  updatePointerBlockDrag(event.clientX, event.clientY);
}

function updatePointerBlockDrag(clientX: number, clientY: number): void {
  const current = pointerDrag;
  if (!current) return;
  if (Math.hypot(clientX - current.startX, clientY - current.startY) < 4) return;
  const targetElement = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
    ?.closest<HTMLElement>('.plim-example-block[data-plim-block-id]');
  if (!targetElement || targetElement.dataset.plimBlockId === String(current.blockId)) {
    clearPointerDropTarget();
    return;
  }
  const targetBlockId = targetElement.dataset.plimBlockId as BlockId | undefined;
  const targetBlock = targetBlockId ? requireEditor().state.document.blocks[targetBlockId] : undefined;
  if (!targetBlock) {
    clearPointerDropTarget();
    return;
  }
  const target = dropTargetForBlockElement(targetBlock, targetElement, clientY);
  const operations = buildReorderOperations(current.payload, target, requireEditor().state.document);
  if (operations.length === 0) {
    clearPointerDropTarget();
    return;
  }
  if (current.activeTarget?.element !== targetElement) clearPointerDropTarget();
  targetElement.classList.toggle('is-drop-before', target.position === 'before');
  targetElement.classList.toggle('is-drop-after', target.position === 'after');
  current.activeTarget = { element: targetElement, target };
}

function handlePointerBlockDragEnd(): void {
  finishPointerBlockDrag();
}

function handleMouseBlockDragEnd(): void {
  finishPointerBlockDrag();
}

function finishPointerBlockDrag(): void {
  const current = pointerDrag;
  const activeTarget = current?.activeTarget;
  cleanupPointerDrag();
  if (!current || !activeTarget) return;
  const operations = buildReorderOperations(current.payload, activeTarget.target, requireEditor().state.document);
  if (operations.length === 0) return;
  void runAction('Reordered block by dragging.', async () => {
    const result = await requireEditor().dispatch({
      source: 'input',
      label: 'drag reorder block',
      undoable: true,
      operations
    });
    ensureTransactionResult(result);
    applyBlockSelection(current.blockId);
    focusEditableBlock(current.blockId);
  });
}

function cancelPointerBlockDrag(): void {
  cleanupPointerDrag();
}

function cleanupPointerDrag(): void {
  clearPointerDropTarget();
  pointerDrag = undefined;
  document.removeEventListener('pointermove', handlePointerBlockDragMove);
  document.removeEventListener('pointerup', handlePointerBlockDragEnd);
  document.removeEventListener('pointercancel', cancelPointerBlockDrag);
  document.removeEventListener('mousemove', handleMouseBlockDragMove);
  document.removeEventListener('mouseup', handleMouseBlockDragEnd);
  suppressNextEditorHostClick = true;
}

function clearPointerDropTarget(): void {
  if (!pointerDrag?.activeTarget) return;
  clearDropIndicator(pointerDrag.activeTarget.element);
  delete pointerDrag.activeTarget;
}

function handleBlockDragOver(ctx: RendererContext, element: HTMLElement, event: DragEvent): void {
  if (!dragPayload) return;
  const target = dropTargetForEvent(ctx, element, event);
  const operations = buildReorderOperations(dragPayload, target, requireEditor().state.document);
  if (operations.length === 0) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  element.classList.toggle('is-drop-before', target.position === 'before');
  element.classList.toggle('is-drop-after', target.position === 'after');
}

async function handleBlockDrop(ctx: RendererContext, element: HTMLElement, event: DragEvent): Promise<void> {
  if (!dragPayload) return;
  event.preventDefault();
  const target = dropTargetForEvent(ctx, element, event);
  const operations = buildReorderOperations(dragPayload, target, requireEditor().state.document);
  clearDropIndicator(element);
  if (operations.length === 0) return;
  const movedBlockId = dragPayload.rootBlockIds?.[0];
  const result = await requireEditor().dispatch({
    source: 'input',
    label: 'reorder block',
    undoable: true,
    operations
  });
  ensureTransactionResult(result);
  dragPayload = undefined;
  if (movedBlockId) {
    applyBlockSelection(movedBlockId);
    focusEditableBlock(movedBlockId);
  }
}

function dropTargetForEvent(ctx: RendererContext, element: HTMLElement, event: DragEvent): BlockPositionDropTarget {
  return dropTargetForBlockElement(ctx.block, element, event.clientY);
}

function dropTargetForBlockElement(block: BlockRecord, element: HTMLElement, clientY: number): BlockPositionDropTarget {
  const rect = element.getBoundingClientRect();
  const position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  const indicatorY = position === 'before' ? rect.top : rect.bottom;
  return {
    kind: 'block-position',
    parentId: parentContainerId(block.parent, requireEditor().rootPageId),
    referenceBlockId: block.id,
    position,
    depth: 0,
    indicatorRect: makeRect(rect.left, indicatorY, rect.width, 2),
    allowedEffects: ['move']
  };
}

function clearDropIndicator(element: Element): void {
  element.classList.remove('is-drop-before', 'is-drop-after');
}

function insertPlainTextAtSelection(text: string): void {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  selection.deleteFromDocument();
  const range = selection.getRangeAt(0);
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function updatePanels(): void {
  updateSelectionPanel();
  updateBlockDefinitionPanel();
  updateInputHints();
  updateDatabasePanel();
}

function updateSelectionPanel(): void {
  const activeEditor = editor;
  if (!activeEditor?.state.selection || activeEditor.state.selection.mode !== 'blocks') {
    selectionAnnouncement.textContent = 'Select a block in the editor.';
    return;
  }

  const state = activeEditor.state.document;
  const anchorBlockId = activeEditor.state.selection.anchorBlockId;
  const focusBlockId = activeEditor.state.selection.focusBlockId;
  const selection = selectBlockRange(state, anchorBlockId, focusBlockId, { traversalScopeRootId: activeEditor.rootPageId });
  const validation = validateSelection(state, selection);
  selectionAnnouncement.textContent = `${announceSelection(selection, state)}. ${validation.ok ? 'Selection helper validation passed.' : validation.issues.map(issue => issue.message).join('; ')}`;
}

function updateBlockDefinitionPanel(): void {
  const selected = selectedEditorBlock();
  if (!selected) {
    blockDefinition.textContent = 'No block selected yet.';
    return;
  }

  const activeEditor = requireEditor();
  const definition = getBlockDefinition(selected.type);
  const childTypes = selected.children
    .map(childId => activeEditor.state.document.blocks[childId]?.type)
    .filter((type): type is BlockType => type !== undefined);
  const normalized = normalizeBlockByDefinition(selected.type, selected.data);
  const issues = validateBlockByDefinition(selected.type, normalized, { childTypes });

  blockDefinition.textContent = JSON.stringify({
    type: selected.type,
    label: definition?.label,
    category: definition?.category,
    defaultData: createDefaultBlockData(selected.type),
    normalizedData: normalized,
    validation: issues.length === 0 ? 'valid' : issues
  }, null, 2);
}

function updateInputHints(): void {
  const value = quickInput.value;
  const caretOffset = quickInput.selectionStart ?? value.length;
  const selected = selectedEditorBlock();
  const slash = detectSlashTrigger(value, caretOffset, selected ? { blockType: selected.type } : {});
  const markdown = evaluateMarkdownInput({
    text: value,
    caretOffset,
    trigger: 'space',
    ...(selected ? { blockId: selected.id, blockType: selected.type } : {})
  });

  pendingMarkdownOperations = markdown?.operations ?? [];
  applyMarkdownButton.disabled = pendingMarkdownOperations.length === 0;
  renderSlashMenu(slash?.query ?? null, 'lab');

  const slashMessage = slash ? `Slash trigger detected for query "${slash.query || '(empty)'}".` : 'Type /to, /h, or /quote to preview block slash suggestions.';
  const markdownMessage = markdown
    ? `Markdown helper matched ${markdown.ruleId}; apply it to transform the selected block.`
    : 'Try "# " with a paragraph selected to transform it into a heading.';
  inputHint.textContent = `${slashMessage} ${markdownMessage}`;
}

function renderSlashMenu(query: string | null, source: 'inline' | 'lab' = 'lab'): void {
  slashMenu.replaceChildren();
  if (query === null) {
    slashMenu.classList.remove('is-open');
    slashMenuItems = [];
    slashNavigation = createMenuNavigationState(0);
    return;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matches = blockSlashCommands
    .filter(command => matchesSlashQuery(command, normalizedQuery))
    .slice(0, 6);

  if (matches.length === 0) {
    slashMenu.classList.remove('is-open');
    slashMenuItems = [];
    slashNavigation = createMenuNavigationState(0);
    return;
  }

  slashMenuItems = matches;
  slashNavigation = createMenuNavigationState(matches.length, slashNavigation.activeIndex < 0 ? 0 : slashNavigation.activeIndex);
  slashMenu.setAttribute('role', 'listbox');
  slashMenu.setAttribute('aria-label', source === 'inline' ? 'Block slash commands' : 'Slash command preview');

  for (const [index, command] of matches.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = slashMenuOptionId(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === slashNavigation.activeIndex));
    if (index === slashNavigation.activeIndex) button.classList.add('is-active');
    button.textContent = command.label;
    button.addEventListener('mouseenter', () => {
      slashNavigation = createMenuNavigationState(slashMenuItems.length, index);
      updateSlashActiveDescendant();
      slashMenu.querySelectorAll<HTMLButtonElement>('button').forEach((item, itemIndex) => {
        item.classList.toggle('is-active', itemIndex === index);
        item.setAttribute('aria-selected', String(itemIndex === index));
      });
    });
    button.addEventListener('mousedown', event => {
      event.preventDefault();
    });
    button.addEventListener('click', () => {
      void runSlashCommand(command, source);
    });
    slashMenu.append(button);
  }
  slashMenu.classList.add('is-open');
  updateSlashActiveDescendant();
  if (source === 'lab') {
    const rect = quickInput.getBoundingClientRect();
    slashMenu.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
    slashMenu.style.top = `${rect.bottom + 8}px`;
  }
}

function handleSlashMenuKeydown(event: KeyboardEvent, block: BlockRecord, editable: HTMLElement): boolean {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
    event.preventDefault();
    slashNavigation = moveMenuNavigation(slashNavigation, event.key, { loop: true });
    const text = editable.textContent ?? '';
    const slash = detectSlashTrigger(text, text.length, { blockType: block.type });
    renderSlashMenu(slash?.query ?? null, 'inline');
    positionSlashMenu(editable);
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    selectActiveSlashMenuItem();
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    hideSlashMenu({ dismissCurrent: true });
    return true;
  }
  return false;
}

function selectActiveSlashMenuItem(): void {
  const command = activeMenuItem(slashMenuItems, slashNavigation);
  if (!command) return;
  void runSlashCommand(command, inlineSlashContext ? 'inline' : 'lab');
}

async function runSlashCommand(command: SlashCommandDefinition<SupportedInsertType>, source: 'inline' | 'lab'): Promise<void> {
  await runAction(`Inserted ${command.label} from slash command.`, async () => {
    const insertAfter = source === 'inline' ? await consumeInlineSlashText() : selectedEditorBlock()?.id;
    quickInput.value = '';
    const blockId = await insertCatalogBlock({
      type: command.type,
      text: defaultTextForSlashCommand(command.type, command.label),
      checked: false,
      ...(insertAfter ? { insertAfter } : {})
    });
    applyBlockSelection(blockId);
    focusEditableBlock(blockId);
  });
}

function updateSlashActiveDescendant(): void {
  const activeId = slashNavigation.activeIndex >= 0 ? slashMenuOptionId(slashNavigation.activeIndex) : undefined;
  if (activeId) inlineSlashContext?.element.setAttribute('aria-activedescendant', activeId);
  else inlineSlashContext?.element.removeAttribute('aria-activedescendant');
}

function slashMenuOptionId(index: number): string {
  return `plim-slash-option-${index}`;
}

function updateDatabasePanel(): void {
  const activeEditor = editor;
  if (!activeEditor) return;

  const taskState = createTaskDatabaseState(activeEditor.state.document);
  const result = queryDataSource(taskState, {
    dataSourceId: taskDataSourceId,
    filter: { type: 'property', propertyId: taskDonePropertyId, operator: 'equals', value: false },
    sorts: [{ kind: 'property', propertyId: taskPriorityPropertyId, direction: 'descending' }],
    projection: { includeTitle: true, propertyIds: [taskDonePropertyId, taskPriorityPropertyId] },
    window: { limit: 5 }
  });

  databaseSummary.textContent = `@plim/databases returned ${result.rows.length} open task rows from ${result.totalKnown ?? 'unknown'} total.`;
  databaseResults.replaceChildren(...result.rows.map(row => {
    const item = document.createElement('li');
    const priority = row.properties[taskPriorityPropertyId];
    const priorityValue = priority?.type === 'number' ? priority.number ?? 0 : 0;
    item.textContent = `${plainTextFromRichText(row.title)} · priority ${priorityValue}`;
    return item;
  }));
}

function applyBlockSelection(blockId: BlockId): void {
  const activeEditor = requireEditor();
  const state = activeEditor.state.document;
  const selection = selectBlockRange(state, blockId, blockId, { traversalScopeRootId: activeEditor.rootPageId });
  const selectedBlockIds = deriveSelectedBlockIds(selection, state, { includeDescendants: false });
  activeEditor.setSelection({
    mode: 'blocks',
    anchorBlockId: selection.anchorBlockId,
    focusBlockId: selection.focusBlockId,
    selectedBlockIds
  }, 'example-selection-helper');
  syncSelectedBlockDom(selectedBlockIds);
  updatePanels();
}

function syncSelectedBlockDom(selectedBlockIds: readonly BlockId[]): void {
  const selected = new Set(selectedBlockIds.map(blockId => String(blockId)));
  document.querySelectorAll<HTMLElement>('.plim-example-block[data-plim-block-id]').forEach(element => {
    element.classList.toggle('is-selected', selected.has(element.dataset.plimBlockId ?? ''));
  });
}

function selectedEditorBlock(): BlockRecord | undefined {
  const activeEditor = editor;
  if (!activeEditor) return undefined;
  const state = activeEditor.state.document;
  const selection = activeEditor.state.selection;
  if (selection?.mode === 'blocks') {
    for (const blockId of selection.selectedBlockIds) {
      const block = state.blocks[blockId];
      if (block && block.type !== 'page') return block;
    }
  }
  const firstChildId = state.blocks[activeEditor.rootPageId]?.children[0];
  return firstChildId ? state.blocks[firstChildId] : undefined;
}

function isEditorBlockSelected(blockId: BlockId): boolean {
  const selection = editor?.state.selection;
  return selection?.mode === 'blocks' && selection.selectedBlockIds.includes(blockId);
}

function selectLastTopLevelBlock(): void {
  const lastBlock = topLevelBlocks().at(-1);
  if (lastBlock) applyBlockSelection(lastBlock.id);
}

function topLevelBlocks(): BlockRecord[] {
  const activeEditor = requireEditor();
  const state = activeEditor.state.document;
  const root = state.blocks[activeEditor.rootPageId];
  return (root?.children ?? []).map(blockId => state.blocks[blockId]).filter((block): block is BlockRecord => block !== undefined);
}

async function runAction(successMessage: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    persistenceStatus.textContent = successMessage;
    updatePanels();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    persistenceStatus.textContent = `Action failed: ${message}`;
  }
}

async function executeEditorCommand<TArgs>(commandId: string, args: TArgs): Promise<CommandResult> {
  const result = await requireEditor().executeCommand(commandId, args);
  ensureCommandResult(result);
  return result;
}

function ensureCommandResult(result: CommandResult): void {
  if (!result.ok) throw result.error;
  if (result.transaction) ensureTransactionResult(result.transaction);
}

function ensureTransactionResult(result: TransactionResult): void {
  if (!result.ok) throw result.error;
  if (result.persistenceError) {
    persistenceStatus.textContent = `Committed with persistence warning: ${result.persistenceError.message}`;
  }
}

function parentRefFor(state: DocumentState, parentId: BlockId | PageId): ParentRef {
  if (state.pages[parentId as PageId]) return { kind: 'page', pageId: parentId as PageId };
  if (state.blocks[parentId as BlockId]) return { kind: 'block', blockId: parentId as BlockId };
  return { kind: 'workspace', workspaceId: state.workspace.id };
}

function textForBlock(block: BlockRecord): string {
  const data = block.data as { richText?: RichText; title?: RichText; expression?: string; url?: string };
  if (Array.isArray(data.richText)) return plainTextFromRichText(data.richText);
  if (Array.isArray(data.title)) return plainTextFromRichText(data.title);
  return data.expression ?? data.url ?? '';
}

function isHeadingBlockType(type: BlockType): boolean {
  return type === 'heading_1' || type === 'heading_2' || type === 'heading_3';
}

function headingLevelFor(type: BlockType): number | undefined {
  if (type === 'heading_1') return 1;
  if (type === 'heading_2') return 2;
  if (type === 'heading_3') return 3;
  return undefined;
}

function editableRoleDescription(type: BlockType): string | undefined {
  const headingLevel = headingLevelFor(type);
  if (headingLevel) return `heading level ${headingLevel}`;
  if (type === 'to_do') return 'to-do';
  return undefined;
}

function matchesSlashQuery(command: SlashCommandDefinition<SupportedInsertType>, query: string): boolean {
  if (query.length === 0) return true;
  return [command.type, command.label, ...command.aliases].some(value => value.toLowerCase().includes(query));
}

function defaultTextForSlashCommand(type: SupportedInsertType, label: string): string {
  switch (type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return 'New heading';
    case 'to_do':
      return 'New to-do';
    case 'quote':
      return 'New quote';
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return 'New list item';
    case 'paragraph':
      return '';
    case 'divider':
      return label;
  }
}

function isSupportedInsertType(type: string): type is SupportedInsertType {
  return (supportedInsertTypes as readonly string[]).includes(type);
}

function mustElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

function requireEditor(): EditorFacade {
  if (!editor) throw new Error('Editor has not been initialized.');
  return editor;
}

function requirePersistence(): PersistenceAdapter {
  if (!persistence) throw new Error('Persistence has not been initialized.');
  return persistence;
}

function createLocalStoragePersistenceAdapter(): PersistenceAdapter {
  const watchers = new Map<string, Set<(event: PersistenceWatchEvent) => void>>();

  const notify = (event: PersistenceWatchEvent): void => {
    for (const watcher of watchers.get(event.key) ?? []) watcher(event);
  };

  return {
    id: 'browser-local-storage',
    capabilities: { durable: true, async: false, quotaBytes: 5_000_000, supportsBroadcast: false },
    async load(key) {
      const raw = readStorageValue(key);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isPersistedSnapshot(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async save(key, snapshot) {
      const persisted = { ...snapshot, persistenceKey: key } satisfies PersistedSnapshot;
      const storage = getLocalStorage();
      if (!storage) throw new Error('localStorage is unavailable in this browser context.');
      storage.setItem(key, JSON.stringify(persisted));
      notify({ key, snapshot: persisted, source: 'save' });
    },
    async remove(key) {
      getLocalStorage()?.removeItem(key);
      notify({ key, snapshot: null, source: 'remove' });
    },
    watch(key, cb) {
      const callbacks = watchers.get(key) ?? new Set<(event: PersistenceWatchEvent) => void>();
      callbacks.add(cb);
      watchers.set(key, callbacks);
      return () => {
        callbacks.delete(cb);
        if (callbacks.size === 0) watchers.delete(key);
      };
    }
  };
}

function readStorageValue(key: string): string | null {
  return getLocalStorage()?.getItem(key) ?? null;
}

function getLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return isObject(value)
    && value['object'] === 'plim_editor_snapshot'
    && typeof value['persistenceKey'] === 'string'
    && typeof value['version'] === 'number'
    && isObject(value['document'])
    && Array.isArray(value['pendingTransactions']);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const taskDatabaseId = asDatabaseId('example-tasks');
const taskDataSourceId = asDataSourceId('example-tasks-source');
const taskViewId = asViewId('example-tasks-open-view');
const taskDonePropertyId = asPropertyId('done');
const taskPriorityPropertyId = asPropertyId('priority');

function createTaskDatabaseState(documentState: DocumentState): ClientDatabaseState {
  const now = new Date().toISOString();
  const titleProperty: DataSourceProperty = {
    id: TITLE_PROPERTY_ID,
    name: 'Task',
    type: 'title',
    config: { type: 'title' },
    lifecycle: 'active'
  };
  const doneProperty: DataSourceProperty = {
    id: taskDonePropertyId,
    name: 'Done',
    type: 'checkbox',
    config: { type: 'checkbox' },
    lifecycle: 'active'
  };
  const priorityProperty: DataSourceProperty = {
    id: taskPriorityPropertyId,
    name: 'Priority',
    type: 'number',
    config: { type: 'number', format: 'number' },
    lifecycle: 'active'
  };

  const tasks = [
    { id: asPageId('task-query-plim-model'), title: 'Create model operations', done: false, priority: 3 },
    { id: asPageId('task-query-selection'), title: 'Announce selected blocks', done: false, priority: 2 },
    { id: asPageId('task-query-persistence'), title: 'Persist the editor snapshot', done: true, priority: 1 }
  ] as const;

  const pages: Record<PageId, PageRecord> = {} as Record<PageId, PageRecord>;
  const entries: Record<PageId, DataSourceEntry> = {} as Record<PageId, DataSourceEntry>;
  tasks.forEach((task, index) => {
    pages[task.id] = createTaskPage(task.id, task.title, task.done, task.priority, now);
    entries[task.id] = { pageId: task.id, order: String(index).padStart(4, '0'), lifecycle: 'active' };
  });

  const dataSource: DataSourceRecord = {
    createdAt: now,
    lastEditedAt: now,
    id: taskDataSourceId,
    workspaceId: documentState.workspace.id,
    databaseId: taskDatabaseId,
    title: richTextFromPlainText('Example tasks'),
    properties: {
      [TITLE_PROPERTY_ID]: titleProperty,
      [taskDonePropertyId]: doneProperty,
      [taskPriorityPropertyId]: priorityProperty
    } as Record<PropertyId, DataSourceProperty>,
    propertyOrder: [TITLE_PROPERTY_ID, taskDonePropertyId, taskPriorityPropertyId],
    entries,
    lifecycle: 'active',
    version: 1
  };

  const database: DatabaseRecord = {
    createdAt: now,
    lastEditedAt: now,
    id: taskDatabaseId,
    workspaceId: documentState.workspace.id,
    parent: { kind: 'workspace', workspaceId: documentState.workspace.id },
    title: richTextFromPlainText('Example tasks'),
    dataSourceIds: [taskDataSourceId],
    viewIds: [taskViewId],
    isInline: true,
    lifecycle: 'active',
    version: 1
  };

  const view: ViewRecord = {
    createdAt: now,
    lastEditedAt: now,
    id: taskViewId,
    workspaceId: documentState.workspace.id,
    databaseId: taskDatabaseId,
    dataSourceId: taskDataSourceId,
    name: 'Open tasks',
    type: 'table',
    sorts: [{ propertyId: taskPriorityPropertyId, direction: 'descending' }],
    visiblePropertyIds: [TITLE_PROPERTY_ID, taskDonePropertyId, taskPriorityPropertyId],
    configuration: { compact: true },
    version: 1
  };

  return {
    ...documentState,
    workspace: {
      ...documentState.workspace,
      rootDatabaseIds: [...documentState.workspace.rootDatabaseIds, taskDatabaseId]
    },
    databases: { ...documentState.databases, [taskDatabaseId]: database },
    dataSources: { ...documentState.dataSources, [taskDataSourceId]: dataSource },
    views: { ...documentState.views, [taskViewId]: view },
    pages: { ...documentState.pages, ...pages },
    revision: 1
  };
}

function createTaskPage(
  id: PageId,
  title: string,
  done: boolean,
  priority: number,
  now: string
): PageRecord {
  const titleValue: PagePropertyValue = { id: TITLE_PROPERTY_ID, type: 'title', title: richTextFromPlainText(title) };
  const doneValue: PagePropertyValue = { id: taskDonePropertyId, type: 'checkbox', checkbox: done };
  const priorityValue: PagePropertyValue = { id: taskPriorityPropertyId, type: 'number', number: priority };

  return {
    createdAt: now,
    lastEditedAt: now,
    id,
    workspaceId: requireEditor().state.document.workspace.id,
    parent: { kind: 'data_source', dataSourceId: taskDataSourceId },
    titlePlain: title,
    properties: {
      [TITLE_PROPERTY_ID]: titleValue,
      [taskDonePropertyId]: doneValue,
      [taskPriorityPropertyId]: priorityValue
    } as Record<PropertyId, PagePropertyValue>,
    dataSourceId: taskDataSourceId,
    lifecycle: 'active',
    version: 1
  };
}
