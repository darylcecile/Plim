import type {
  BlockId,
  BlockRecord,
  BlockType,
  Clock,
  DocumentState,
  IdFactory,
  InsertPosition,
  Operation,
  PageId,
  TransactionId,
  TransactionMetadata,
  TransactionRecord,
  UserId,
  ValidationIssue
} from '@plim/model';
import type { EditorError } from './errors.js';

export type EditorMode = 'controlled' | 'uncontrolled';
export type ControlledPolicy = 'optimistic' | 'strict';
export type PersistenceRole = 'primary' | 'cache' | 'drafts' | 'disabled';

export type EditorStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'degraded'; reason: string; recoverable: boolean }
  | { state: 'failed'; error: EditorError }
  | { state: 'destroyed' };

export type TextPoint = { blockId: BlockId; offset: number; field?: string };

export type EditorSelection =
  | { mode: 'text'; anchor: TextPoint; focus: TextPoint }
  | { mode: 'blocks'; anchorBlockId: BlockId; focusBlockId: BlockId; selectedBlockIds: BlockId[] }
  | { mode: 'cells'; dataSourceId: string; anchor: { row: string; column: string }; focus: { row: string; column: string } }
  | { mode: 'none' };

export interface EditorState {
  readonly version: number;
  readonly document: Readonly<DocumentState>;
  readonly selection: EditorSelection | null;
  readonly status: EditorStatus;
  readonly dirty: boolean;
  readonly pendingTransactions: readonly TransactionRecord[];
}

export interface EditorSnapshot {
  readonly object: 'plim_editor_snapshot';
  readonly version: number;
  readonly document: DocumentState;
  readonly selection: EditorSelection | null;
  readonly pendingTransactions: TransactionRecord[];
  readonly dirty: boolean;
  readonly generatedAt: string;
}

export interface PersistedSnapshot extends EditorSnapshot {
  readonly persistenceKey: string;
}

export interface PersistenceCapabilities {
  readonly durable: boolean;
  readonly async: boolean;
  readonly quotaBytes?: number;
  readonly supportsTransactions?: boolean;
  readonly supportsBroadcast?: boolean;
}

export interface PersistenceWatchEvent {
  readonly key: string;
  readonly snapshot: PersistedSnapshot | null;
  readonly source?: string;
}

export interface PersistenceAdapter {
  readonly id: string;
  readonly capabilities: PersistenceCapabilities;
  load(key: string): Promise<PersistedSnapshot | null>;
  save(key: string, snapshot: PersistedSnapshot): Promise<void>;
  remove?(key: string): Promise<void>;
  watch?(key: string, cb: (event: PersistenceWatchEvent) => void): () => void;
  flush?(): Promise<void>;
}

export interface EditorTransactionDraft {
  readonly id?: TransactionId;
  readonly operations: readonly Operation[];
  readonly source?: NonNullable<TransactionMetadata['source']>;
  readonly label?: string;
  readonly undoable?: boolean;
  readonly historyGroup?: string;
  readonly metadata?: TransactionMetadata;
  readonly beforeSelection?: EditorSelection | null;
  readonly afterSelection?: EditorSelection | null;
}

export type TransactionInput = readonly Operation[] | EditorTransactionDraft | TransactionRecord;

export type TransactionResult =
  | {
      readonly ok: true;
      readonly committed: boolean;
      readonly state: EditorState;
      readonly snapshot: EditorSnapshot;
      readonly transaction: TransactionRecord;
      readonly issues: readonly ValidationIssue[];
      readonly persistenceError?: EditorError;
    }
  | {
      readonly ok: false;
      readonly committed: false;
      readonly state: EditorState;
      readonly transaction?: TransactionRecord;
      readonly issues: readonly ValidationIssue[];
      readonly error: EditorError;
    };

export interface CommandContext<TArgs = unknown> {
  readonly editor: EditorFacade;
  readonly state: EditorState;
  readonly selection: EditorSelection | null;
  readonly args: TArgs;
}

export type CommandOutput = void | readonly Operation[] | EditorTransactionDraft | TransactionResult;

export interface Command<TArgs = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly category?: 'basic' | 'inline' | 'media' | 'database' | 'advanced' | 'style' | 'host' | 'history';
  readonly shortcuts?: readonly string[];
  readonly contexts?: readonly string[];
  readonly priority?: number;
  isEnabled?(ctx: CommandContext<TArgs>): boolean;
  run(ctx: CommandContext<TArgs>, args: TArgs): CommandOutput | Promise<CommandOutput>;
}

export type CommandResult =
  | { readonly ok: true; readonly commandId: string; readonly transaction?: TransactionResult }
  | { readonly ok: false; readonly commandId: string; readonly error: EditorError };

export interface BlockSchema<TBlock extends BlockRecord = BlockRecord> {
  readonly type: TBlock['type'];
  readonly supportsChildren?: boolean | ((block: TBlock) => boolean);
  readonly allowedChildTypes?: readonly BlockType[] | 'any';
  validate?(block: TBlock, state: DocumentState): readonly ValidationIssue[];
  normalize?(state: DocumentState): readonly Operation[];
}

export interface RendererContext<TBlock extends BlockRecord = BlockRecord> {
  readonly block: TBlock;
  readonly state: EditorState;
  readonly editor: EditorFacade;
  readonly domDocument: Document;
  readonly renderChildren: (parentId: BlockId | PageId, host: HTMLElement) => void;
}

export interface Renderer<TBlock extends BlockRecord = BlockRecord> {
  readonly id: string;
  readonly blockType?: TBlock['type'];
  readonly mode?: 'read' | 'edit' | 'both';
  render(ctx: RendererContext<TBlock>): HTMLElement;
  unmount?(element: HTMLElement, block: TBlock): void;
}

export type DocumentNormalizer = (state: DocumentState) => readonly Operation[];
export type DocumentValidator = (state: DocumentState) => readonly ValidationIssue[];

export interface PluginAPI {
  readonly editor: EditorFacade;
  registerCommand<TArgs = unknown>(command: Command<TArgs>): () => void;
  registerRenderer<TBlock extends BlockRecord = BlockRecord>(renderer: Renderer<TBlock>): () => void;
  registerSchema<TBlock extends BlockRecord = BlockRecord>(schema: BlockSchema<TBlock>): () => void;
  registerNormalizer(normalizer: DocumentNormalizer): () => void;
  registerValidator(validator: DocumentValidator): () => void;
  on<TType extends EditorEvent['type']>(type: TType, handler: (event: Extract<EditorEvent, { type: TType }>) => void): () => void;
}

export interface Plugin {
  readonly id: string;
  readonly version: string;
  readonly commands?: readonly Command[];
  readonly renderers?: readonly Renderer[];
  readonly schemas?: readonly BlockSchema[];
  readonly normalizers?: readonly DocumentNormalizer[];
  readonly validators?: readonly DocumentValidator[];
  onInstall?(api: PluginAPI): void | Promise<void>;
  onStart?(api: PluginAPI): void | Promise<void>;
  onStop?(api: PluginAPI): void | Promise<void>;
  onUninstall?(api: PluginAPI): void | Promise<void>;
}

export type EditorEvent =
  | { readonly type: 'lifecycle'; readonly timestamp: string; readonly status: EditorStatus }
  | { readonly type: 'transaction'; readonly timestamp: string; readonly phase: 'before' | 'after' | 'proposed' | 'rejected'; readonly transaction: TransactionRecord; readonly version: number; readonly source?: TransactionMetadata['source'] }
  | { readonly type: 'change'; readonly timestamp: string; readonly transaction: TransactionRecord | null; readonly snapshot: EditorSnapshot; readonly dirty: boolean }
  | { readonly type: 'selectionChange'; readonly timestamp: string; readonly selection: EditorSelection | null; readonly cause: string }
  | { readonly type: 'command'; readonly timestamp: string; readonly commandId: string; readonly phase: 'started' | 'completed' | 'failed'; readonly result?: CommandResult; readonly error?: EditorError }
  | { readonly type: 'persistence'; readonly timestamp: string; readonly adapterId: string; readonly status: 'loading' | 'loaded' | 'saving' | 'saved' | 'failed' | 'removed'; readonly error?: EditorError }
  | { readonly type: 'error'; readonly timestamp: string; readonly error: EditorError; readonly recoverable: boolean }
  | { readonly type: 'telemetry'; readonly timestamp: string; readonly name: string; readonly data?: Record<string, unknown> }
  | { readonly type: 'transaction:beforeApply'; readonly timestamp: string; readonly transaction: TransactionRecord }
  | { readonly type: 'transaction:committed'; readonly timestamp: string; readonly transaction: TransactionRecord; readonly snapshot: EditorSnapshot }
  | { readonly type: 'transaction:rejected'; readonly timestamp: string; readonly transaction: TransactionRecord; readonly error: EditorError }
  | { readonly type: 'selection:changed'; readonly timestamp: string; readonly selection: EditorSelection | null; readonly cause: string }
  | { readonly type: 'history:changed'; readonly timestamp: string; readonly canUndo: boolean; readonly canRedo: boolean }
  | { readonly type: 'plugin:error'; readonly timestamp: string; readonly pluginId: string; readonly error: EditorError }
  | { readonly type: 'renderer:error'; readonly timestamp: string; readonly rendererId: string; readonly blockId?: BlockId; readonly error: EditorError }
  | { readonly type: 'effect:scheduled'; readonly timestamp: string; readonly effect: 'persistence'; readonly transactionId?: TransactionId }
  | { readonly type: 'effect:failed'; readonly timestamp: string; readonly effect: 'persistence'; readonly error: EditorError; readonly transactionId?: TransactionId };

export interface SetDocumentOptions {
  readonly preserveSelection?: boolean;
  readonly selection?: EditorSelection | null;
  readonly markDirty?: boolean;
}

export interface EditorOptions {
  readonly document?: DocumentState | EditorSnapshot;
  readonly snapshot?: EditorSnapshot;
  readonly loadDocument?: () => Promise<DocumentState | EditorSnapshot>;
  readonly mode?: EditorMode;
  readonly controlledPolicy?: ControlledPolicy;
  readonly readOnly?: boolean | ((state: EditorState) => boolean);
  readonly persistence?: PersistenceAdapter;
  readonly persistenceKey?: string;
  readonly persistenceRole?: PersistenceRole;
  readonly plugins?: readonly Plugin[];
  readonly commands?: readonly Command[];
  readonly renderers?: readonly Renderer[];
  readonly schemas?: readonly BlockSchema[];
  readonly normalizers?: readonly DocumentNormalizer[];
  readonly validators?: readonly DocumentValidator[];
  readonly idFactory?: IdFactory;
  readonly clock?: Clock;
  readonly clientId?: string;
  readonly actorId?: UserId;
  readonly maxNormalizationPasses?: number;
  readonly locale?: string;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  readonly errorReporter?: (error: EditorError) => void;
}

export interface InsertParagraphArgs {
  readonly parentId?: BlockId | PageId;
  readonly text?: string;
  readonly at?: InsertPosition;
}

export interface EditorFacade {
  readonly state: EditorState;
  readonly rootPageId: PageId;
  getState(): EditorState;
  getSnapshot(): EditorSnapshot;
  exportSnapshot(): EditorSnapshot;
  importSnapshot(snapshot: EditorSnapshot, options?: SetDocumentOptions): TransactionResult;
  dispatch(input: TransactionInput): Promise<TransactionResult>;
  executeCommand<TArgs = unknown>(commandId: string, args: TArgs): Promise<CommandResult>;
  registerCommand<TArgs = unknown>(command: Command<TArgs>): () => void;
  registerRenderer<TBlock extends BlockRecord = BlockRecord>(renderer: Renderer<TBlock>): () => void;
  registerSchema<TBlock extends BlockRecord = BlockRecord>(schema: BlockSchema<TBlock>): () => void;
  registerNormalizer(normalizer: DocumentNormalizer): () => void;
  registerValidator(validator: DocumentValidator): () => void;
  on<TType extends EditorEvent['type']>(type: TType, handler: (event: Extract<EditorEvent, { type: TType }>) => void): () => void;
  setSelection(selection: EditorSelection | null, cause?: string): void;
  focus(selection?: EditorSelection | null): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): Promise<TransactionResult>;
  redo(): Promise<TransactionResult>;
  setDocument(document: DocumentState, options?: SetDocumentOptions): TransactionResult;
  acceptTransaction(id: TransactionId, document: DocumentState): TransactionResult;
  rejectTransaction(id: TransactionId, reason?: string): TransactionResult;
  mount(host: HTMLElement): Promise<void>;
  unmount(): Promise<void>;
  destroy(): Promise<void>;
}
