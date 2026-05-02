import * as React from 'react';
import {
  PlimEditor,
  PlimEditorProvider,
  createLocalStoragePersistenceAdapter,
  usePlimCommand,
  usePlimEditor,
  usePlimEditorState,
  type PlimBlockRendererContext,
  type PlimBlockRendererMap,
  type PlimBlockThemeContext,
  type PlimTheme
} from '@plim/react';
import {
  createBlock,
  createEmptyDocument,
  createIdFactory,
  plainTextFromRichText,
  richTextFromPlainText,
  type BlockId,
  type BlockRecord,
  type BlockType,
  type DocumentState,
  type InsertPosition,
  type PageId,
  type RichText
} from '@plim/model';

const persistenceKey = 'react-tailwind-editor';

const theme = {
  colorScheme: 'light',
  className: 'react-tailwind-editor',
  blockClassName: ({ selected }: PlimBlockThemeContext) =>
    selected ? 'is-selected' : undefined,
  variables: {
    text: '#1f2937',
    background: '#ffffff',
    mutedText: '#64748b',
    border: '#e2e8f0',
    selection: '#bae6fd',
    focusRing: '#38bdf8',
    blockHover: 'rgb(55 53 47 / 0.08)',
    menuSurface: '#ffffff',
    danger: '#dc2626',
    success: '#16a34a',
    warning: '#ca8a04',
    codeBackground: '#f1f5f9',
    mentionBackground: '#e0f2fe'
  }
} satisfies PlimTheme;

const exampleBlockRenderers = {
  page: renderPage,
  paragraph: context => renderTextBlock(context, 'p', 'Type something...'),
  heading_1: context => renderTextBlock(context, 'h2', 'Heading 1'),
  heading_2: context => renderTextBlock(context, 'h3', 'Heading 2'),
  heading_3: context => renderTextBlock(context, 'h4', 'Heading 3'),
  quote: context => renderTextBlock(context, 'blockquote', 'Quote'),
  bulleted_list_item: context => renderListBlock(context, 'bulleted_list_item'),
  numbered_list_item: context => renderListBlock(context, 'numbered_list_item'),
  to_do: renderTodoBlock
} satisfies PlimBlockRendererMap;

export function App(): React.ReactElement {
  const defaultDocument = React.useMemo(() => createDemoDocument(), []);
  const persistence = React.useMemo(
    () => createLocalStoragePersistenceAdapter({ storageKeyPrefix: 'plim:examples:' }),
    []
  );
  const [lastEvent, setLastEvent] = React.useState('Waiting for edits...');

  return (
    <PlimEditorProvider
      defaultDocument={defaultDocument}
      persistence={persistence}
      persistenceKey={persistenceKey}
      loadFromPersistence
      theme={theme}
      onChange={event => setLastEvent(`Changed from ${event.source}`)}
      onCommand={event => setLastEvent(`${event.phase}: ${event.commandId}`)}
      onError={event => setLastEvent(`Error: ${event.error.message}`)}
    >
      <div className="notion-shell">
        <InitialSelection />
        <Topbar lastEvent={lastEvent} />
        <main className="document-shell">
          <p className="document-hint">
            Click anywhere and type. Press <kbd>Enter</kbd> for a new block, or type <kbd>/</kbd> inside a block for commands.
          </p>
          <PlimEditor ariaLabel="React Tailwind Plim editor" blockRenderers={exampleBlockRenderers} />
          <InsertStrip />
        </main>
      </div>
    </PlimEditorProvider>
  );
}

function Topbar({ lastEvent }: { readonly lastEvent: string }): React.ReactElement {
  const editor = usePlimEditor();

  return (
    <header className="topbar">
      <div className="brand" aria-label="Current example">
        <strong>Plim</strong>
        <span>Notion-style editor example</span>
      </div>
      <div className="topbar-actions">
        <button type="button" className="ghost-button" onClick={() => void editor.flushPersistence()}>
          Save
        </button>
        <button type="button" className="ghost-button" onClick={() => editor.setDocument(createDemoDocument(), { source: 'document', dirty: false })}>
          Reset
        </button>
        <details className="developer-details">
          <summary>Developer details</summary>
          <Inspector lastEvent={lastEvent} />
        </details>
      </div>
    </header>
  );
}

function InitialSelection(): null {
  const editor = usePlimEditor();
  const didSelect = React.useRef(false);
  const lastTopLevelBlockId = usePlimEditorState(snapshot => {
    const rootPageId = snapshot.document.workspace.rootPageIds[0];
    const children = rootPageId ? snapshot.document.blocks[rootPageId]?.children : undefined;
    return children?.[children.length - 1];
  });

  React.useEffect(() => {
    if (didSelect.current || !lastTopLevelBlockId) return;
    didSelect.current = true;
    editor.setSelection({ kind: 'block', blockId: lastTopLevelBlockId }, 'api');
  }, [editor, lastTopLevelBlockId]);

  return null;
}

function InsertStrip(): React.ReactElement {
  const snapshot = usePlimEditorState(value => value);
  const rootPageId = snapshot.document.workspace.rootPageIds[0];
  const insertBlock = usePlimCommand<{
    parentId: BlockId | PageId;
    type: BlockType;
    text?: string;
    at?: InsertPosition;
    dataPatch?: Record<string, string | number | boolean | null>;
  }>('plim.insertBlock');

  const insert = React.useCallback(async (type: BlockType, text: string, dataPatch?: Record<string, string | number | boolean | null>) => {
    if (!rootPageId) return;
    await insertBlock.execute({
      parentId: rootPageId,
      type,
      text,
      at: { kind: 'append' },
      ...(dataPatch ? { dataPatch } : {})
    });
  }, [insertBlock, rootPageId]);

  return (
    <div className="insert-strip" aria-label="Insert blocks">
      <span>Insert</span>
      <div className="toolbar">
        <ToolbarButton onClick={() => void insert('paragraph', 'New React paragraph')}>
          Text
        </ToolbarButton>
        <ToolbarButton onClick={() => void insert('to_do', 'New Tailwind task', { checked: false })}>
          To-do
        </ToolbarButton>
        <ToolbarButton onClick={() => void insert('quote', 'A quote inserted from React state')}>
          Quote
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  const { className, ...rest } = props;
  return (
    <button
      type="button"
      className={className}
      {...rest}
    />
  );
}

function Inspector({ lastEvent }: { readonly lastEvent: string }): React.ReactElement {
  const snapshot = usePlimEditorState(value => value);
  const blocks = Object.values(snapshot.document.blocks);
  const activeBlocks = blocks.filter(block => block.lifecycle === 'active');
  const editor = usePlimEditor();

  return (
    <div className="developer-panel">
      <section>
        <h2>Runtime</h2>
        <dl className="react-runtime-stats">
          <Stat label="Status" value={snapshot.status.state} />
          <Stat label="Blocks" value={String(activeBlocks.length)} />
          <Stat label="Dirty" value={snapshot.dirty ? 'yes' : 'no'} />
          <Stat label="Selection" value={snapshot.selection.kind} />
        </dl>
      </section>
      <section>
        <h2>Last event</h2>
        <pre>{lastEvent}</pre>
      </section>
      <section>
        <h2>Persistence</h2>
        <p className="developer-copy">
          Edits are saved through the React localStorage adapter under <code>{persistenceKey}</code>.
        </p>
        <div className="toolbar">
          <ToolbarButton onClick={() => void editor.flushPersistence()}>Flush</ToolbarButton>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div className="react-runtime-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function renderPage(context: PlimBlockRendererContext): React.ReactNode {
  const block = context.block as BlockRecord<'page'>;
  const title = plainTextFromRichText(block.data.title);
  const onInput = (event: React.FormEvent<HTMLElement>): void => {
    if (context.readOnly) return;
    void context.dispatchCommand('plim.replacePageTitle', {
      pageId: block.id,
      text: event.currentTarget.textContent ?? ''
    });
  };

  return (
    <>
      <h1
        className="page-title"
        contentEditable={context.readOnly ? undefined : true}
        suppressContentEditableWarning
        onInput={onInput}
        aria-label="Page title"
        data-placeholder="Untitled"
        spellCheck
      >
        {title}
      </h1>
      {context.children}
    </>
  );
}

function renderTextBlock(
  context: PlimBlockRendererContext,
  tag: 'p' | 'h2' | 'h3' | 'h4' | 'blockquote',
  placeholder: string
): React.ReactNode {
  return (
    <>
      <BlockAffordance context={context} />
      <div className="block-content">
        {editableRichText(context, tag, placeholder)}
      </div>
    </>
  );
}

function renderListBlock(
  context: PlimBlockRendererContext,
  type: 'bulleted_list_item' | 'numbered_list_item'
): React.ReactNode {
  return (
    <>
      <BlockAffordance context={context} />
      <div className="block-content">
        <div className="list-row">
          <span className="list-marker" aria-hidden="true">{type === 'bulleted_list_item' ? '•' : '1.'}</span>
          {editableRichText(context, 'p', type === 'bulleted_list_item' ? 'List item' : 'Numbered item')}
        </div>
      </div>
    </>
  );
}

function renderTodoBlock(context: PlimBlockRendererContext): React.ReactNode {
  const block = context.block as BlockRecord<'to_do'>;
  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    void context.dispatchCommand('plim.toggleToDo', {
      blockId: block.id,
      checked: event.currentTarget.checked
    });
  };

  return (
    <>
      <BlockAffordance context={context} />
      <div className="block-content">
        <div className="todo-row">
          <input
            type="checkbox"
            checked={block.data.checked}
            disabled={context.readOnly}
            onChange={onChange}
            aria-label="Toggle to-do"
          />
          {editableRichText(context, 'span', 'To-do text')}
        </div>
      </div>
    </>
  );
}

function editableRichText(
  context: PlimBlockRendererContext,
  tag: 'p' | 'span' | 'h2' | 'h3' | 'h4' | 'blockquote',
  placeholder: string
): React.ReactElement {
  const text = plainTextFromRichText(richTextData(context.block));
  const onInput = (event: React.FormEvent<HTMLElement>): void => {
    if (context.readOnly) return;
    void context.dispatchCommand('plim.replaceBlockRichText', {
      blockId: context.block.id,
      field: 'richText',
      text: event.currentTarget.textContent ?? ''
    });
  };

  return React.createElement(tag, {
    className: 'editable-block-text',
    contentEditable: context.readOnly ? undefined : true,
    suppressContentEditableWarning: true,
    onInput,
    onKeyDown: event => {
      if (context.readOnly || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      if (!shouldMoveAcrossBlocks(event.currentTarget, event.key)) return;
      if (!focusAdjacentEditable(event.currentTarget, event.key === 'ArrowUp' ? 'previous' : 'next')) return;
      event.preventDefault();
      event.stopPropagation();
    },
    role: 'textbox',
    'aria-multiline': true,
    'aria-roledescription': placeholder,
    'data-plim-editable': 'true',
    'data-placeholder': placeholder,
    spellCheck: context.block.type !== 'code'
  }, text);
}

function BlockAffordance({ context }: { readonly context: PlimBlockRendererContext }): React.ReactElement {
  return (
    <div className="block-affordance" aria-hidden={context.readOnly ? true : undefined}>
      <button type="button" title="Add block below" aria-label="Add block below" onClick={event => {
        event.stopPropagation();
        void insertBlockBelow(context);
      }}>
        +
      </button>
      <button type="button" title="Block handle" aria-label="Drag block to reorder" onClick={event => {
        event.stopPropagation();
        context.editor.setSelection({ kind: 'block', blockId: context.block.id }, 'api');
      }}>
        ⋮⋮
      </button>
    </div>
  );
}

async function insertBlockBelow(context: PlimBlockRendererContext): Promise<void> {
  const parentId = parentContainerId(context.block);
  if (!parentId) return;
  const result = await context.dispatchCommand('plim.insertBlock', {
    parentId,
    type: 'paragraph',
    text: '',
    at: { kind: 'after', siblingId: context.block.id }
  });
  const siblings = result.snapshot ? childrenForContainer(result.snapshot.document, parentId) : [];
  const insertedBlockId = siblings[siblings.indexOf(context.block.id) + 1];
  if (insertedBlockId) context.editor.setSelection({ kind: 'block', blockId: insertedBlockId }, 'api');
}

function parentContainerId(block: BlockRecord): BlockId | PageId | undefined {
  if (block.parent.kind === 'page') return block.parent.pageId;
  if (block.parent.kind === 'block' || block.parent.kind === 'synced_instance') return block.parent.blockId;
  return undefined;
}

function childrenForContainer(document: DocumentState, parentId: BlockId | PageId): readonly BlockId[] {
  return document.blocks[parentId as BlockId]?.children ?? [];
}

function richTextData(block: BlockRecord): RichText {
  return 'richText' in block.data && Array.isArray(block.data.richText) ? block.data.richText : [];
}

function shouldMoveAcrossBlocks(element: HTMLElement, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const offsets = editableSelectionOffsets(element);
  if (!offsets || offsets.start !== offsets.end) return false;
  const textLength = element.textContent?.length ?? 0;
  return key === 'ArrowUp' ? offsets.start === 0 : offsets.end === textLength;
}

function editableSelectionOffsets(element: HTMLElement): { readonly start: number; readonly end: number } | undefined {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return undefined;
  const startRange = element.ownerDocument.createRange();
  startRange.selectNodeContents(element);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = element.ownerDocument.createRange();
  endRange.selectNodeContents(element);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}

function focusAdjacentEditable(element: HTMLElement, direction: 'previous' | 'next'): boolean {
  const editables = [...element.ownerDocument.querySelectorAll<HTMLElement>('[data-plim-editable="true"]')];
  const index = editables.indexOf(element);
  const target = editables[index + (direction === 'previous' ? -1 : 1)];
  if (!target) return false;
  focusEditable(target, direction === 'previous' ? 'end' : 'start');
  return true;
}

function focusEditable(element: HTMLElement, boundary: 'start' | 'end'): void {
  element.focus();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(boundary === 'start');
  const selection = element.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createDemoDocument(): DocumentState {
  const idFactory = createIdFactory({ prefix: 'react-tailwind' });
  const document = createEmptyDocument({
    title: 'Plim basic editor',
    workspaceName: 'Plim React Tailwind example',
    idFactory
  });
  const rootPageId = document.workspace.rootPageIds[0];
  if (!rootPageId) throw new Error('Demo document must have a root page.');
  const pageId: PageId = rootPageId;
  const workspaceId = document.workspace.id;

  const blocks = [
    createDemoBlock('heading_1', 'Click here and type with Plim'),
    createDemoBlock('paragraph', 'This is an editable document canvas. Change this text, then click away or press Enter to commit it.'),
    createDemoBlock('to_do', 'Toggle me or edit this to-do text directly.', { checked: false })
  ];

  return {
    ...document,
    blocks: {
      ...document.blocks,
      [rootPageId]: {
        ...document.blocks[rootPageId],
        children: blocks.map(block => block.id)
      } as BlockRecord,
      ...Object.fromEntries(blocks.map(block => [block.id, block]))
    }
  };

  function createDemoBlock<T extends BlockType>(
    type: T,
    text: string,
    extraData: Partial<BlockRecord<T>['data']> = {}
  ): BlockRecord<T> {
    return createBlock({
      workspaceId,
      parent: { kind: 'page', pageId },
      type,
      data: {
        richText: richTextFromPlainText(text),
        ...extraData
      } as BlockRecord<T>['data'],
      idFactory
    });
  }
}
