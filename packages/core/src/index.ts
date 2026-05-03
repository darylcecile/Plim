export type PlimId = string;

export interface TextRange {
  from: number;
  to: number;
}

export interface PlimMarkRange extends TextRange {
  mark: string;
  attrs?: Record<string, unknown>;
}

export interface PlimBlock {
  id: PlimId;
  type: string;
  text: string;
  attrs?: Record<string, unknown>;
  children?: PlimBlock[];
  marks?: PlimMarkRange[];
}

export interface PlimContent {
  title: string;
  blocks: PlimBlock[];
}

export type PlimSelection =
  | { kind: 'caret'; blockId: PlimId; offset: number }
  | { kind: 'range'; blockId: PlimId; from: number; to: number }
  | { kind: 'block'; blockIds: PlimId[] };

export interface PlimEditorState {
  content: PlimContent;
  selection: PlimSelection | null;
  readonly: boolean;
  version: number;
}

export interface ThemeObject {
  name: string;
  className?: string;
  tokens?: Record<string, string>;
}

export type PlimTheme = string | ThemeObject;

export interface KeyboardTrigger {
  kind: 'keyboard';
  mode: 'shortcut' | 'character' | 'key';
  value: string;
}

export interface ClipboardTrigger {
  kind: 'clipboard';
  action: 'copy' | 'cut' | 'paste';
}

export type Trigger = KeyboardTrigger | ClipboardTrigger;

export const triggers = {
  keyboard: {
    shortcut: (shortcut: string): KeyboardTrigger => ({ kind: 'keyboard', mode: 'shortcut', value: shortcut }),
    character: (character: string): KeyboardTrigger => ({ kind: 'keyboard', mode: 'character', value: character }),
    key: (key: string): KeyboardTrigger => ({ kind: 'keyboard', mode: 'key', value: key })
  },
  clipboard: {
    action: (action: ClipboardTrigger['action']): ClipboardTrigger => ({ kind: 'clipboard', action })
  }
} as const;

export type TriggerValidationRule =
  | 'selectionNotEmpty'
  | 'blockSupportsDecoration'
  | 'startOfBlock'
  | 'precededByWhitespace';

export type TriggerRuleExpression =
  | TriggerValidationRule
  | { kind: 'and'; rules: TriggerRuleExpression[] }
  | { kind: 'or'; rules: TriggerRuleExpression[] }
  | { kind: 'not'; rule: TriggerRuleExpression };

export interface TriggerRuleBuilders {
  and: (rules: TriggerRuleExpression[]) => TriggerRuleExpression;
  or: (rules: TriggerRuleExpression[]) => TriggerRuleExpression;
  not: (rule: TriggerRuleExpression) => TriggerRuleExpression;
}

export const triggerRuleBuilders: TriggerRuleBuilders = {
  and: (rules) => ({ kind: 'and', rules }),
  or: (rules) => ({ kind: 'or', rules }),
  not: (rule) => ({ kind: 'not', rule })
};

export interface TransactionOperationBase {
  op: string;
}

export interface InsertBlockOperation extends TransactionOperationBase {
  op: 'insertBlock';
  block: PlimBlock;
  afterBlockId?: PlimId;
}

export interface UpdateBlockOperation extends TransactionOperationBase {
  op: 'updateBlock';
  blockId: PlimId;
  patch: Partial<Omit<PlimBlock, 'id' | 'children'>> & { children?: PlimBlock[] };
}

export interface DeleteBlockOperation extends TransactionOperationBase {
  op: 'deleteBlock';
  blockId: PlimId;
}

export interface MoveBlockOperation extends TransactionOperationBase {
  op: 'moveBlock';
  blockId: PlimId;
  afterBlockId?: PlimId;
}

export interface ToggleMarkOperation extends TransactionOperationBase {
  op: 'toggleMark';
  mark: string;
  range: TextRange & { blockId?: PlimId };
  attrs?: Record<string, unknown>;
}

export interface ReplaceContentOperation extends TransactionOperationBase {
  op: 'replaceContent';
  content: PlimContent;
}

export interface SetSelectionOperation extends TransactionOperationBase {
  op: 'setSelection';
  selection: PlimSelection | null;
}

export type TransactionOperation =
  | InsertBlockOperation
  | UpdateBlockOperation
  | DeleteBlockOperation
  | MoveBlockOperation
  | ToggleMarkOperation
  | ReplaceContentOperation
  | SetSelectionOperation;

export interface Transaction {
  id: PlimId;
  timestamp: number;
  operations: TransactionOperation[];
  before: PlimEditorState;
  after: PlimEditorState;
  cause?: TransactionCause;
}

export type TransactionCause =
  | { kind: 'keyboard'; key: string; shortcut?: string }
  | { kind: 'text-input'; inputType?: string; text: string }
  | { kind: 'paste'; plainText: boolean }
  | { kind: 'command'; commandId: string }
  | { kind: 'api' };

export interface TransactionBuilder {
  insertBlock(block: PlimBlock, afterBlockId?: PlimId): TransactionBuilder;
  updateBlock(blockId: PlimId, patch: UpdateBlockOperation['patch']): TransactionBuilder;
  deleteBlock(blockId: PlimId): TransactionBuilder;
  moveBlock(blockId: PlimId, afterBlockId?: PlimId): TransactionBuilder;
  toggleMark(mark: string, range: TextRange & { blockId?: PlimId }, attrs?: Record<string, unknown>): TransactionBuilder;
  replaceContent(content: PlimContent): TransactionBuilder;
  setSelection(selection: PlimSelection | null): TransactionBuilder;
  commit(cause?: TransactionCause): Promise<Transaction>;
}

export interface AsyncEvent<Name extends string = string, Detail = unknown> {
  name: Name;
  detail?: Detail;
  signal: AbortSignal;
}

export interface ActionContext {
  createTransaction(): TransactionBuilder;
  triggerAsyncEvent<Name extends string, Detail = unknown>(name: Name, detail?: Detail): Promise<unknown[]>;
  signal: AbortSignal;
  isCancelled(): boolean;
}

export interface ActionDefinition<Name extends string = string> {
  name: Name;
  trigger?: Trigger | Trigger[];
  triggerValidationRules?: (builders: TriggerRuleBuilders) => TriggerRuleExpression;
  cancellationTriggers?: Trigger[];
  perform: (state: PlimEditorState, ctx: ActionContext) => Promise<unknown> | unknown;
  priority: number;
}

export type ActionConfig<Name extends string = string> =
  Omit<ActionDefinition<Name>, 'name' | 'priority'> & { priority?: number };

export function defineAction<Name extends string>(name: Name, config: ActionConfig<Name>): ActionDefinition<Name> {
  return { ...config, name, priority: config.priority ?? 0 };
}

export interface BlockPayload<Block extends PlimBlock = PlimBlock> {
  block: Block;
  content: string;
  attributes: Record<string, string>;
  readonly: boolean;
  selected: boolean;
}

export interface BlockDefinition<Name extends string = string> {
  name: Name;
  type?: 'standalone' | 'inline';
  nestable?: boolean;
  atom?: boolean;
  supportsMarks?: boolean;
  toDOM?: (payload: BlockPayload) => HTMLElement;
  toComponent?: (payload: BlockPayload) => unknown;
}

export function defineBlock<Name extends string>(definition: BlockDefinition<Name>): BlockDefinition<Name> {
  return {
    type: 'standalone',
    nestable: false,
    supportsMarks: true,
    ...definition
  };
}

export interface MarkPayload {
  mark: PlimMarkRange;
  text: string;
  attributes: Record<string, string>;
}

export interface MarkDefinition<Name extends string = string> {
  name: Name;
  toDOM?: (payload: MarkPayload) => HTMLElement;
  toComponent?: (payload: MarkPayload) => unknown;
}

export function defineMark<Name extends string>(definition: MarkDefinition<Name>): MarkDefinition<Name> {
  return definition;
}

export interface ExtensionResult {
  name: string;
  registeredBlocks?: BlockDefinition[];
  registeredMarks?: MarkDefinition[];
  registeredActions?: ActionDefinition[];
  onTransaction?: (transaction: Transaction, ctx: ExtensionContext) => void | Promise<void>;
  onAsyncEvent?: (event: AsyncEvent, state: PlimEditorState, ctx: ActionContext) => void | Promise<void>;
}

export interface ExtensionContext {
  plim: PlimDriver;
}

export interface ExtensionFactory {
  readonly kind: 'plim.extension';
  setup(editor: ExtensionEditorHandle): ExtensionResult;
}

export interface ExtensionEditorHandle {
  readonly isReady: boolean;
  getState(): PlimEditorState;
}

export function defineExtension(setup: (editor: ExtensionEditorHandle) => ExtensionResult): ExtensionFactory {
  return { kind: 'plim.extension', setup };
}

export interface PlimDriverOptions {
  theme?: PlimTheme;
  extensions?: ExtensionFactory[];
  registeredMarks?: MarkDefinition[];
  registeredBlocks?: BlockDefinition[];
  registeredActions?: ActionDefinition[];
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  past: readonly Transaction[];
  future: readonly Transaction[];
}

type HistoryChangeListener = (state: HistoryState) => void;
type RestoreState = (state: PlimEditorState, transaction: Transaction) => void;

export class HistoryController {
  #past: Transaction[] = [];
  #future: Transaction[] = [];
  #listeners = new Set<HistoryChangeListener>();
  #restore: RestoreState | null = null;

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  get state(): HistoryState {
    return {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      past: [...this.#past],
      future: [...this.#future]
    };
  }

  attachRestore(restore: RestoreState): void {
    this.#restore = restore;
  }

  record(transaction: Transaction): void {
    this.#past.push(transaction);
    this.#future = [];
    this.#emit();
  }

  undo(): Transaction | null {
    if (!this.#restore) {
      throw new Error('Cannot undo before an editor is attached to history.');
    }

    const transaction = this.#past.pop();
    if (!transaction) {
      return null;
    }

    this.#future.push(transaction);
    this.#restore(cloneState(transaction.before), transaction);
    this.#emit();
    return transaction;
  }

  redo(): Transaction | null {
    if (!this.#restore) {
      throw new Error('Cannot redo before an editor is attached to history.');
    }

    const transaction = this.#future.pop();
    if (!transaction) {
      return null;
    }

    this.#past.push(transaction);
    this.#restore(cloneState(transaction.after), transaction);
    this.#emit();
    return transaction;
  }

  onChange(listener: HistoryChangeListener): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const state = this.state;
    this.#listeners.forEach((listener) => listener(state));
  }
}

export class PlimDriver {
  #options: {
    theme: PlimTheme;
    extensions: ExtensionFactory[];
    registeredMarks: MarkDefinition[];
    registeredBlocks: BlockDefinition[];
    registeredActions: ActionDefinition[];
  };
  #history = new HistoryController();
  #extensionCache = new WeakMap<ExtensionFactory, ExtensionResult>();

  constructor(options: PlimDriverOptions = {}) {
    this.#options = {
      theme: options.theme ?? 'light',
      extensions: [...(options.extensions ?? [])],
      registeredMarks: [...(options.registeredMarks ?? [])],
      registeredBlocks: [...(options.registeredBlocks ?? [])],
      registeredActions: [...(options.registeredActions ?? [])]
    };
  }

  get theme(): PlimTheme {
    return this.#options.theme;
  }

  setTheme(theme: PlimTheme): void {
    this.#options.theme = theme;
  }

  getHistory(): HistoryController {
    return this.#history;
  }

  getRegisteredBlocks(editor?: ExtensionEditorHandle): BlockDefinition[] {
    return [...this.#options.registeredBlocks, ...this.#resolveExtensions(editor).flatMap((extension) => extension.registeredBlocks ?? [])];
  }

  getRegisteredMarks(editor?: ExtensionEditorHandle): MarkDefinition[] {
    return [...this.#options.registeredMarks, ...this.#resolveExtensions(editor).flatMap((extension) => extension.registeredMarks ?? [])];
  }

  getRegisteredActions(editor?: ExtensionEditorHandle): ActionDefinition[] {
    return [...this.#options.registeredActions, ...this.#resolveExtensions(editor).flatMap((extension) => extension.registeredActions ?? [])].sort(
      (a, b) => b.priority - a.priority
    );
  }

  getExtensions(editor?: ExtensionEditorHandle): ExtensionResult[] {
    return this.#resolveExtensions(editor);
  }

  configure(options: Partial<PlimDriverOptions>): void {
    if ('theme' in options) {
      this.#options.theme = options.theme ?? 'light';
    }
    if (options.extensions) {
      this.#options.extensions = [...options.extensions];
    }
    if (options.registeredMarks) {
      this.#options.registeredMarks = [...options.registeredMarks];
    }
    if (options.registeredBlocks) {
      this.#options.registeredBlocks = [...options.registeredBlocks];
    }
    if (options.registeredActions) {
      this.#options.registeredActions = [...options.registeredActions];
    }
  }

  _recordTransaction(transaction: Transaction): void {
    this.#history.record(transaction);
  }

  #resolveExtensions(editor?: ExtensionEditorHandle): ExtensionResult[] {
    return this.#options.extensions.map((extension) => {
      const cached = this.#extensionCache.get(extension);
      if (cached) {
        return cached;
      }

      if (!editor) {
        return {
          name: 'pending-extension'
        };
      }

      const resolved = extension.setup(editor);
      this.#extensionCache.set(extension, resolved);
      return resolved;
    });
  }
}

export interface SnapshotSource {
  getState(): PlimEditorState;
}

export class Snapshot {
  readonly state: PlimEditorState;

  constructor(source: SnapshotSource | PlimEditorState) {
    this.state = 'getState' in source ? cloneState(source.getState()) : cloneState(source);
  }

  serialize(): string {
    return JSON.stringify({ state: this.state });
  }

  static deserialize(serialized: string): Snapshot {
    const parsed = JSON.parse(serialized) as { state?: PlimEditorState };
    if (!parsed.state) {
      throw new Error('Invalid Plim snapshot: missing state.');
    }
    return new Snapshot(parsed.state);
  }
}

export function createBlock(type: string, text = '', init: Partial<Omit<PlimBlock, 'id' | 'type' | 'text'>> & { id?: string } = {}): PlimBlock {
  return {
    id: init.id ?? createId(),
    type,
    text,
    ...(init.attrs ? { attrs: { ...init.attrs } } : {}),
    ...(init.children ? { children: cloneBlocks(init.children) } : {}),
    ...(init.marks ? { marks: init.marks.map((mark) => ({ ...mark, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) })) } : {})
  };
}

export function createContent(blocks: PlimBlock[] = [createBlock('paragraph')], title = 'Untitled'): PlimContent {
  return { title, blocks: cloneBlocks(blocks) };
}

export function cloneContent(content: PlimContent): PlimContent {
  return { title: content.title, blocks: cloneBlocks(content.blocks) };
}

export function cloneState(state: PlimEditorState): PlimEditorState {
  return {
    content: cloneContent(state.content),
    selection: state.selection ? cloneSelection(state.selection) : null,
    readonly: state.readonly,
    version: state.version
  };
}

export function cloneSelection(selection: PlimSelection): PlimSelection {
  if (selection.kind === 'block') {
    return { kind: 'block', blockIds: [...selection.blockIds] };
  }
  return { ...selection };
}

export function evaluateTriggerRule(rule: TriggerRuleExpression, state: PlimEditorState, trigger?: Trigger): boolean {
  if (typeof rule === 'string') {
    return evaluateNamedRule(rule, state, trigger);
  }

  if (rule.kind === 'and') {
    return rule.rules.every((child) => evaluateTriggerRule(child, state, trigger));
  }

  if (rule.kind === 'or') {
    return rule.rules.some((child) => evaluateTriggerRule(child, state, trigger));
  }

  return !evaluateTriggerRule(rule.rule, state, trigger);
}

export function triggerMatches(a: Trigger, b: Trigger): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'keyboard' && b.kind === 'keyboard') {
    return a.mode === b.mode && normalizeShortcut(a.value) === normalizeShortcut(b.value);
  }

  if (a.kind === 'clipboard' && b.kind === 'clipboard') {
    return a.action === b.action;
  }

  return false;
}

export function operationApply(content: PlimContent, operations: readonly TransactionOperation[], selection: PlimSelection | null): {
  content: PlimContent;
  selection: PlimSelection | null;
} {
  let nextContent = cloneContent(content);
  let nextSelection = selection ? cloneSelection(selection) : null;

  for (const operation of operations) {
    if (operation.op === 'replaceContent') {
      nextContent = cloneContent(operation.content);
      continue;
    }

    if (operation.op === 'setSelection') {
      nextSelection = operation.selection ? cloneSelection(operation.selection) : null;
      continue;
    }

    if (operation.op === 'insertBlock') {
      const block = cloneBlock(operation.block);
      const at = operation.afterBlockId ? nextContent.blocks.findIndex((candidate) => candidate.id === operation.afterBlockId) + 1 : nextContent.blocks.length;
      nextContent = {
        ...nextContent,
        blocks: [...nextContent.blocks.slice(0, Math.max(0, at)), block, ...nextContent.blocks.slice(Math.max(0, at))]
      };
      continue;
    }

    if (operation.op === 'updateBlock') {
      nextContent = {
        ...nextContent,
        blocks: nextContent.blocks.map((block) => (block.id === operation.blockId ? patchBlock(block, operation.patch) : block))
      };
      continue;
    }

    if (operation.op === 'deleteBlock') {
      nextContent = {
        ...nextContent,
        blocks: nextContent.blocks.filter((block) => block.id !== operation.blockId)
      };
      if (nextSelection?.kind !== 'block' && nextSelection?.blockId === operation.blockId) {
        nextSelection = null;
      }
      continue;
    }

    if (operation.op === 'moveBlock') {
      const currentIndex = nextContent.blocks.findIndex((block) => block.id === operation.blockId);
      if (currentIndex === -1 || operation.afterBlockId === operation.blockId) {
        continue;
      }

      const movingBlock = nextContent.blocks[currentIndex]!;
      const withoutMoving = nextContent.blocks.filter((block) => block.id !== operation.blockId);
      const nextIndex = operation.afterBlockId
        ? withoutMoving.findIndex((block) => block.id === operation.afterBlockId) + 1
        : 0;
      const boundedIndex = nextIndex <= 0 ? 0 : Math.min(nextIndex, withoutMoving.length);
      nextContent = {
        ...nextContent,
        blocks: [...withoutMoving.slice(0, boundedIndex), movingBlock, ...withoutMoving.slice(boundedIndex)]
      };
      continue;
    }

    if (operation.op === 'toggleMark') {
      const blockId = operation.range.blockId ?? (selection?.kind !== 'block' ? selection?.blockId : undefined);
      if (!blockId) {
        continue;
      }
      nextContent = {
        ...nextContent,
        blocks: nextContent.blocks.map((block) => {
          if (block.id !== blockId) {
            return block;
          }
          const existing = block.marks ?? [];
          const matches = (mark: PlimMarkRange): boolean =>
            mark.mark === operation.mark && mark.from === operation.range.from && mark.to === operation.range.to;
          const hasMark = existing.some(matches);
          return {
            ...block,
            marks: hasMark
              ? existing.filter((mark) => !matches(mark))
              : [...existing, { mark: operation.mark, from: operation.range.from, to: operation.range.to, ...(operation.attrs ? { attrs: operation.attrs } : {}) }]
          };
        })
      };
    }
  }

  return { content: nextContent, selection: nextSelection };
}

export function createId(prefix = 'plim'): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function evaluateNamedRule(rule: TriggerValidationRule, state: PlimEditorState, trigger?: Trigger): boolean {
  if (rule === 'selectionNotEmpty') {
    return Boolean(
      state.selection &&
        ((state.selection.kind === 'range' && state.selection.to > state.selection.from) ||
          (state.selection.kind === 'block' && state.selection.blockIds.length > 0))
    );
  }

  if (rule === 'blockSupportsDecoration') {
    return state.selection?.kind !== 'block';
  }

  if (rule === 'startOfBlock') {
    if (!state.selection || state.selection.kind === 'block') {
      return false;
    }
    return (state.selection.kind === 'caret' ? state.selection.offset : state.selection.from) === 0;
  }

  if (rule === 'precededByWhitespace') {
    if (!state.selection || state.selection.kind === 'block') {
      return false;
    }
    const selection = state.selection;
    const block = state.content.blocks.find((candidate) => candidate.id === selection.blockId);
    const offset = selection.kind === 'caret' ? selection.offset : selection.from;
    const previous = offset > 0 ? block?.text[offset - 1] : undefined;
    return offset === 0 || previous === undefined || /\s/.test(previous) || (trigger?.kind === 'keyboard' && trigger.mode === 'character' && offset === block?.text.length);
  }

  return false;
}

function cloneBlocks(blocks: readonly PlimBlock[]): PlimBlock[] {
  return blocks.map(cloneBlock);
}

function cloneBlock(block: PlimBlock): PlimBlock {
  return {
    id: block.id,
    type: block.type,
    text: block.text,
    ...(block.attrs ? { attrs: { ...block.attrs } } : {}),
    ...(block.children ? { children: cloneBlocks(block.children) } : {}),
    ...(block.marks ? { marks: block.marks.map(cloneMark) } : {})
  };
}

function patchBlock(block: PlimBlock, patch: UpdateBlockOperation['patch']): PlimBlock {
  const next: PlimBlock = {
    id: block.id,
    type: patch.type ?? block.type,
    text: patch.text ?? block.text
  };

  const attrs = patch.attrs ?? block.attrs;
  if (attrs) {
    next.attrs = { ...attrs };
  }

  const children = patch.children ?? block.children;
  if (children) {
    next.children = cloneBlocks(children);
  }

  const marks = patch.marks ?? block.marks;
  if (marks) {
    next.marks = marks.map(cloneMark);
  }

  return next;
}

function cloneMark(mark: PlimMarkRange): PlimMarkRange {
  return { ...mark, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) };
}

function normalizeShortcut(value: string): string {
  return value
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .sort()
    .join('+');
}
