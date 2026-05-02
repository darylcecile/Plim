import * as React from 'react';
import {
  applyTransaction,
  createBlock,
  createEmptyDocument,
  createIdFactory,
  createTransaction,
  defaultBlockData,
  normalizeDocumentState,
  parentRefForContainer,
  plainTextFromRichText,
  richTextFromPlainText,
  systemClock,
  TITLE_PROPERTY_ID,
  validateDocumentState,
  type BlockDataByType,
  type BlockId,
  type BlockRecord,
  type BlockType,
  type Clock,
  type DeepPartial,
  type DocumentState,
  type IdFactory,
  type InsertPosition,
  type JsonObject,
  type Operation,
  type PageId,
  type RichText,
  type RichTextSpan,
  type TextRangeAnchor,
  type TransactionId,
  type TransactionMetadata,
  type TransactionRecord,
  type UserId,
  type ValidationIssue
} from '@plim/model';

export type PlimEditorMode = 'controlled' | 'uncontrolled';
export type PlimControlledPolicy = 'optimistic' | 'strict';
export type PlimTransactionSource = NonNullable<TransactionMetadata['source']>;
export type PlimPersistenceRole = 'source' | 'cache' | 'drafts' | 'disabled';
export type PlimTextDirection = 'ltr' | 'rtl' | 'auto';
export type PlimSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'block'; readonly blockId: BlockId }
  | { readonly kind: 'text'; readonly blockId: BlockId; readonly field: string; readonly anchorOffset: number; readonly focusOffset: number };
export type PlimEditorStatus =
  | { readonly state: 'loading' }
  | { readonly state: 'ready' }
  | { readonly state: 'degraded'; readonly reason: string; readonly recoverable: boolean }
  | { readonly state: 'failed'; readonly error: PlimEditorError }
  | { readonly state: 'destroyed' };

export interface PlimSnapshot {
  readonly document: DocumentState;
  readonly version: number;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly selection: PlimSelection;
  readonly status: PlimEditorStatus;
  readonly pendingCommandIds: readonly string[];
  readonly pendingTransactionIds: readonly string[];
}

export interface PlimEditorError extends Error {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly recoverable: boolean;
  readonly details?: JsonObject;
}

export class PlimReactError extends Error implements PlimEditorError {
  readonly code: string;
  readonly severity: PlimEditorError['severity'];
  readonly recoverable: boolean;
  readonly details?: JsonObject;

  constructor(code: string, message: string, options: { readonly severity?: PlimEditorError['severity']; readonly recoverable?: boolean; readonly cause?: unknown; readonly details?: JsonObject } = {}) {
    super(message);
    this.name = 'PlimReactError';
    this.code = code;
    this.severity = options.severity ?? 'error';
    this.recoverable = options.recoverable ?? true;
    if (options.details) this.details = options.details;
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
  }
}

export interface PlimPersistedSnapshot {
  readonly object: 'plim_persisted_snapshot';
  readonly document: DocumentState;
  readonly version: number;
  readonly savedAt: string;
  readonly dirty: boolean;
  readonly metadata?: JsonObject;
}

export interface PlimPersistenceWatchEvent {
  readonly key: string;
  readonly snapshot: PlimPersistedSnapshot | null;
  readonly source: 'local' | 'external';
}

export interface PlimPersistenceAdapter {
  readonly id: string;
  readonly capabilities: {
    readonly durable: boolean;
    readonly async: boolean;
    readonly quotaBytes?: number;
    readonly supportsTransactions?: boolean;
    readonly supportsBroadcast?: boolean;
  };
  load(key: string): Promise<PlimPersistedSnapshot | null>;
  save(key: string, snapshot: PlimPersistedSnapshot): Promise<void>;
  remove?(key: string): Promise<void>;
  watch?(key: string, callback: (event: PlimPersistenceWatchEvent) => void): () => void;
  flush?(): Promise<void>;
}

export interface PlimHostPersistenceCallbacks {
  readonly id?: string;
  load?(key: string): Promise<PlimPersistedSnapshot | DocumentState | null> | PlimPersistedSnapshot | DocumentState | null;
  save?(key: string, snapshot: PlimPersistedSnapshot): Promise<void> | void;
  remove?(key: string): Promise<void> | void;
  flush?(): Promise<void> | void;
}

export interface PlimLifecycleEvent { readonly status: PlimEditorStatus; readonly timestamp: string; }
export interface PlimTransactionEvent { readonly phase: 'proposed' | 'applied' | 'accepted' | 'rejected'; readonly transaction: TransactionRecord; readonly documentVersion: number; readonly source: PlimTransactionSource | 'api'; }
export interface PlimChangeEvent { readonly document: DocumentState; readonly transaction?: TransactionRecord; readonly snapshot: PlimSnapshot; readonly dirty: boolean; readonly source: 'transaction' | 'document' | 'persistence' | 'controlled'; }
export interface PlimSelectionChangeEvent { readonly selection: PlimSelection; readonly cause: 'api' | 'command' | 'focus' | 'blur' | 'document'; }
export interface PlimCommandEvent { readonly phase: 'started' | 'completed' | 'failed'; readonly commandId: string; readonly args: unknown; readonly result?: PlimCommandResult; readonly error?: PlimEditorError; }
export interface PlimPersistenceEvent { readonly adapterId: string; readonly status: 'loaded' | 'saved' | 'removed' | 'failed' | 'flushed'; readonly error?: PlimEditorError; }
export interface PlimErrorEvent { readonly error: PlimEditorError; readonly context: PlimErrorContext; }
export interface PlimTelemetryEvent { readonly name: string; readonly timestamp: string; readonly properties?: JsonObject; }

export interface PlimEventMap {
  readonly lifecycle: PlimLifecycleEvent;
  readonly transaction: PlimTransactionEvent;
  readonly change: PlimChangeEvent;
  readonly selectionChange: PlimSelectionChangeEvent;
  readonly command: PlimCommandEvent;
  readonly persistence: PlimPersistenceEvent;
  readonly error: PlimErrorEvent;
  readonly telemetry: PlimTelemetryEvent;
}

export interface PlimErrorContext {
  readonly phase: 'create' | 'mount' | 'unmount' | 'destroy' | 'load' | 'transaction' | 'command' | 'persistence' | 'plugin' | 'renderer' | 'callback' | 'document';
  readonly commandId?: string;
  readonly pluginId?: string;
  readonly eventName?: keyof PlimEventMap;
  readonly blockId?: BlockId;
}

export interface PlimCommandResult {
  readonly status: 'handled' | 'pending' | 'noop';
  readonly transaction?: TransactionRecord;
  readonly snapshot?: PlimSnapshot;
  readonly message?: string;
  readonly operations?: readonly Operation[];
  readonly selection?: PlimSelection;
}

export interface PlimDispatchOptions { readonly source?: PlimTransactionSource; readonly label?: string; readonly allowReadOnly?: boolean; readonly metadata?: JsonObject; }
export interface PlimSetDocumentOptions { readonly preserveSelection?: boolean; readonly selection?: PlimSelection; readonly source?: PlimChangeEvent['source']; readonly dirty?: boolean; readonly silent?: boolean; readonly validate?: boolean; }

export interface PlimCommandContext {
  readonly editor: PlimReactEditor;
  readonly document: DocumentState;
  readonly selection: PlimSelection;
  readonly readOnly: boolean;
  readonly idFactory: IdFactory;
  readonly clock: Clock;
  dispatchOperations(operations: readonly Operation[], options?: PlimDispatchOptions): Promise<PlimCommandResult>;
  setDocument(document: DocumentState, options?: PlimSetDocumentOptions): void;
  setSelection(selection: PlimSelection, cause?: PlimSelectionChangeEvent['cause']): void;
}

export interface PlimCommand<TArgs = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly category?: 'basic' | 'inline' | 'media' | 'database' | 'advanced' | 'style' | 'host';
  readonly contexts?: readonly ('editor' | 'block' | 'text' | 'selection' | 'menu' | 'api')[];
  readonly mutates?: boolean;
  readonly isEnabled?: (context: PlimCommandContext) => boolean;
  readonly run: (context: PlimCommandContext, args: TArgs) => Promise<PlimCommandResult> | PlimCommandResult;
}

export type PlimCommandProvider = readonly PlimCommand[] | ((context: PlimCommandContext) => readonly PlimCommand[] | Promise<readonly PlimCommand[]>);
export interface PlimRendererRegistration { readonly type: BlockType | string; readonly renderer: PlimBlockRenderer; }
export interface PlimPluginApi {
  readonly editor: PlimReactEditor;
  registerCommand<TArgs = unknown>(command: PlimCommand<TArgs>): () => void;
  registerRenderer(type: BlockType | string, renderer: PlimBlockRenderer): () => void;
  on<K extends keyof PlimEventMap>(eventName: K, listener: (event: PlimEventMap[K]) => void): () => void;
  getSnapshot(): PlimSnapshot;
  executeCommand<TArgs = unknown>(commandId: string, args: TArgs): Promise<PlimCommandResult>;
}
export interface PlimPlugin { readonly id: string; readonly version: string; readonly commands?: PlimCommandProvider; readonly renderers?: readonly PlimRendererRegistration[] | PlimBlockRendererMap; onInstall?(api: PlimPluginApi): void | Promise<void>; onUninstall?(api: PlimPluginApi): void | Promise<void>; }

export interface PlimLocaleMessages { readonly editorLabel?: string; readonly readOnlyLabel?: string; readonly unsupportedBlock?: string; readonly emptyParagraph?: string; readonly pageTitlePlaceholder?: string; }
export type PlimThemeToken = 'text' | 'background' | 'mutedText' | 'border' | 'selection' | 'focusRing' | 'blockHover' | 'menuSurface' | 'danger' | 'success' | 'warning' | 'codeBackground' | 'mentionBackground';
export interface PlimTheme { readonly colorScheme?: 'light' | 'dark' | 'system'; readonly className?: string; readonly style?: React.CSSProperties; readonly variables?: Partial<Record<PlimThemeToken, string>>; readonly blockClassName?: string | ((context: PlimBlockThemeContext) => string | undefined); readonly blockStyle?: React.CSSProperties | ((context: PlimBlockThemeContext) => React.CSSProperties | undefined); }
export interface PlimBlockThemeContext { readonly block: BlockRecord; readonly level: number; readonly selected: boolean; readonly readOnly: boolean; }
export interface PlimBlockRenderAttributes { readonly role: string; readonly tabIndex: number; readonly 'data-plim-block-id': string; readonly 'data-plim-block-type': string; readonly 'aria-label': string; readonly 'aria-readonly'?: boolean; readonly 'aria-level'?: number; readonly 'aria-checked'?: boolean; readonly 'aria-expanded'?: boolean; }

export interface PlimBlockRendererContext<TBlock extends BlockRecord = BlockRecord> {
  readonly block: TBlock;
  readonly document: DocumentState;
  readonly editor: PlimReactEditor;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly level: number;
  readonly children: React.ReactNode;
  readonly attributes: PlimBlockRenderAttributes;
  readonly messages: Required<Pick<PlimLocaleMessages, 'editorLabel' | 'readOnlyLabel' | 'unsupportedBlock' | 'emptyParagraph' | 'pageTitlePlaceholder'>> & PlimLocaleMessages;
  dispatchCommand<TArgs = unknown>(commandId: string, args: TArgs): Promise<PlimCommandResult>;
  renderChildren(): React.ReactNode;
}
export type PlimBlockRenderer<TBlock extends BlockRecord = BlockRecord> = (context: PlimBlockRendererContext<TBlock>) => React.ReactNode;
export type PlimBlockRendererMap = Readonly<Record<string, PlimBlockRenderer | undefined>>;

export interface PlimReactEditorOptions {
  readonly document?: DocumentState;
  readonly defaultDocument?: DocumentState;
  readonly initialDocument?: DocumentState;
  readonly mode?: PlimEditorMode;
  readonly controlledPolicy?: PlimControlledPolicy;
  readonly readOnly?: boolean | ((snapshot: PlimSnapshot) => boolean);
  readonly persistence?: PlimPersistenceAdapter;
  readonly persistenceKey?: string;
  readonly persistenceRole?: PlimPersistenceRole;
  readonly loadFromPersistence?: boolean;
  readonly plugins?: readonly PlimPlugin[];
  readonly renderers?: PlimBlockRendererMap;
  readonly commandProviders?: readonly PlimCommandProvider[];
  readonly idFactory?: IdFactory;
  readonly clock?: Clock;
  readonly actorId?: UserId;
  readonly clientId?: string;
  readonly locale?: string;
  readonly messages?: PlimLocaleMessages;
  readonly direction?: PlimTextDirection;
  readonly theme?: PlimTheme;
  readonly onChange?: (event: PlimChangeEvent) => void;
  readonly onTransaction?: (event: PlimTransactionEvent) => void;
  readonly onSelectionChange?: (event: PlimSelectionChangeEvent) => void;
  readonly onCommand?: (event: PlimCommandEvent) => void;
  readonly onError?: (event: PlimErrorEvent) => void;
  readonly onStatusChange?: (event: PlimLifecycleEvent) => void;
  readonly telemetry?: (event: PlimTelemetryEvent) => void;
}

export interface PlimEditorProviderProps extends PlimReactEditorOptions { readonly editor?: PlimReactEditor | undefined; readonly children?: React.ReactNode | undefined; }
export interface PlimEditorProps extends PlimReactEditorOptions { readonly rootPageId?: PageId | undefined; readonly ariaLabel?: string | undefined; readonly className?: string | undefined; readonly style?: React.CSSProperties | undefined; readonly blockRenderers?: PlimBlockRendererMap | undefined; readonly blockClassName?: string | undefined; readonly blockStyle?: React.CSSProperties | undefined; }
export interface PlimBlockProps { readonly blockId: BlockId; readonly level?: number | undefined; readonly renderers?: PlimBlockRendererMap | undefined; readonly className?: string | undefined; readonly style?: React.CSSProperties | undefined; }
export interface PlimCommandHook<TArgs = unknown> { readonly execute: (args: TArgs) => Promise<PlimCommandResult>; readonly canExecute: boolean; readonly isPending: boolean; readonly command: PlimCommand<unknown> | undefined; }

const defaultMessages = { editorLabel: 'Plim editor', readOnlyLabel: 'Read only', unsupportedBlock: 'Unsupported block', emptyParagraph: 'Empty paragraph', pageTitlePlaceholder: 'Untitled' } satisfies Required<Pick<PlimLocaleMessages, 'editorLabel' | 'readOnlyLabel' | 'unsupportedBlock' | 'emptyParagraph' | 'pageTitlePlaceholder'>>;
const noneSelection: PlimSelection = { kind: 'none' };
type RuntimeOptions = Pick<PlimReactEditorOptions, 'readOnly' | 'onChange' | 'onTransaction' | 'onSelectionChange' | 'onCommand' | 'onError' | 'onStatusChange' | 'telemetry' | 'locale' | 'messages' | 'direction' | 'theme'>;
type RuntimeUpdateOptions = { readonly [K in keyof RuntimeOptions]?: RuntimeOptions[K] | undefined };
type AnyEvent = PlimEventMap[keyof PlimEventMap];
type PendingTransaction = { readonly transaction: TransactionRecord; readonly before: DocumentState; readonly applied: boolean };
let clientCounter = 0;

export class PlimReactEditor {
  private document: DocumentState;
  private status: PlimEditorStatus = { state: 'loading' };
  private dirty = false;
  private version = 0;
  private selection: PlimSelection = noneSelection;
  private readonly mode: PlimEditorMode;
  private readonly controlledPolicy: PlimControlledPolicy;
  private readonly idFactory: IdFactory;
  private readonly clock: Clock;
  private readonly actorId: UserId | undefined;
  private readonly clientId: string;
  private readonly persistence: PlimPersistenceAdapter | undefined;
  private readonly persistenceKey: string;
  private readonly persistenceRole: PlimPersistenceRole;
  private readonly storeListeners = new Set<() => void>();
  private readonly eventListeners = new Map<keyof PlimEventMap, Set<(event: AnyEvent) => void>>();
  private readonly commands = new Map<string, PlimCommand<unknown>>();
  private readonly renderers = new Map<string, PlimBlockRenderer>();
  private readonly pendingTransactions = new Map<string, PendingTransaction>();
  private readonly pendingCommandIds = new Set<string>();
  private readonly pluginCleanups = new Map<string, readonly (() => void)[]>();
  private options: RuntimeOptions;
  private snapshot: PlimSnapshot;
  private mountedElement: HTMLElement | undefined;
  private destroyed = false;

  constructor(options: PlimReactEditorOptions = {}) {
    this.mode = options.mode ?? (options.document ? 'controlled' : 'uncontrolled');
    this.controlledPolicy = options.controlledPolicy ?? 'optimistic';
    this.idFactory = options.idFactory ?? createIdFactory();
    this.clock = options.clock ?? systemClock;
    this.actorId = options.actorId;
    clientCounter += 1;
    this.clientId = options.clientId ?? `plim-react-${clientCounter.toString(36)}`;
    this.persistence = options.persistence;
    this.persistenceKey = options.persistenceKey ?? 'plim:document';
    this.persistenceRole = options.persistenceRole ?? (this.mode === 'controlled' ? 'disabled' : 'source');
    this.options = runtimeOptions(options);
    this.document = normalizeInitialDocument(options.document ?? options.defaultDocument ?? options.initialDocument, this.idFactory, this.clock);
    this.snapshot = this.createSnapshot();
    this.registerBuiltIns();
    this.registerRendererMap(options.renderers);
    for (const provider of options.commandProviders ?? []) this.registerCommandProvider(provider);
    for (const plugin of options.plugins ?? []) this.installPlugin(plugin);
    this.setStatus({ state: 'ready' });
    if (options.loadFromPersistence) void this.loadPersistedSnapshot();
  }

  getSnapshot(): PlimSnapshot { return this.snapshot; }
  getDocument(): DocumentState { return this.document; }
  getTheme(): PlimTheme | undefined { return this.options.theme; }
  getDirection(): PlimTextDirection | undefined { return this.options.direction; }
  getMessages(): Required<Pick<PlimLocaleMessages, 'editorLabel' | 'readOnlyLabel' | 'unsupportedBlock' | 'emptyParagraph' | 'pageTitlePlaceholder'>> & PlimLocaleMessages { return { ...defaultMessages, ...this.options.messages }; }
  getCommand(commandId: string): PlimCommand<unknown> | undefined { return this.commands.get(commandId); }
  listCommands(): readonly PlimCommand<unknown>[] { return [...this.commands.values()]; }
  getRenderer(type: BlockType | string): PlimBlockRenderer | undefined { return this.renderers.get(type); }

  subscribe(listener: () => void): () => void {
    this.storeListeners.add(listener);
    return () => { this.storeListeners.delete(listener); };
  }

  on<K extends keyof PlimEventMap>(eventName: K, listener: (event: PlimEventMap[K]) => void): () => void {
    const listeners = this.eventListeners.get(eventName) ?? new Set<(event: AnyEvent) => void>();
    const stored = listener as (event: AnyEvent) => void;
    listeners.add(stored);
    this.eventListeners.set(eventName, listeners);
    return () => {
      listeners.delete(stored);
      if (listeners.size === 0) this.eventListeners.delete(eventName);
    };
  }

  updateOptions(options: RuntimeUpdateOptions & { readonly renderers?: PlimBlockRendererMap | undefined; readonly commandProviders?: readonly PlimCommandProvider[] | undefined }): void {
    this.options = { ...this.options, ...runtimeOptions(options) };
    this.registerRendererMap(options.renderers);
    for (const provider of options.commandProviders ?? []) this.registerCommandProvider(provider);
    this.refreshSnapshot();
  }

  async mount(element: HTMLElement): Promise<void> {
    this.assertUsable('mount');
    if (this.mountedElement) throw editorError('already_mounted', 'The editor is already mounted.');
    this.mountedElement = element;
    this.emit('lifecycle', { status: this.status, timestamp: this.now() });
  }

  async unmount(): Promise<void> {
    if (!this.mountedElement) return;
    this.mountedElement = undefined;
    this.emit('lifecycle', { status: this.status, timestamp: this.now() });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.unmount();
    await this.flushPersistence();
    for (const cleanups of this.pluginCleanups.values()) for (const cleanup of cleanups) this.safeRun(cleanup, { phase: 'plugin' });
    this.pluginCleanups.clear();
    this.destroyed = true;
    this.setStatus({ state: 'destroyed' });
  }

  isReadOnly(): boolean { return this.computeReadOnly(true); }

  canExecuteCommand(commandId: string): boolean {
    const command = this.commands.get(commandId);
    if (!command) return false;
    if (this.isReadOnly() && command.mutates !== false) return false;
    if (!command.isEnabled) return true;
    try {
      return command.isEnabled(this.commandContext());
    } catch (cause) {
      this.reportError(toError(cause, 'command_disabled', `Command ${commandId} enablement failed.`), { phase: 'command', commandId });
      return false;
    }
  }

  async executeCommand<TArgs = unknown>(commandId: string, args: TArgs): Promise<PlimCommandResult> {
    this.assertUsable('command');
    const command = this.commands.get(commandId);
    if (!command) throw editorError('command_unknown', `Command ${commandId} is not registered.`, 'warning');
    if (this.isReadOnly() && command.mutates !== false) throw editorError('command_disabled', `Command ${commandId} is disabled in read-only mode.`, 'info');
    if (command.isEnabled && !command.isEnabled(this.commandContext())) throw editorError('command_disabled', `Command ${commandId} is disabled.`, 'info');

    this.pendingCommandIds.add(commandId);
    this.refreshSnapshot();
    this.emit('command', { phase: 'started', commandId, args });
    const startedAt = Date.now();
    try {
      const result = await command.run(this.commandContext(), args);
      const applied = result.operations && result.operations.length > 0 ? await this.applyOperations(result.operations, { source: 'command', label: command.title }) : result;
      this.emit('command', { phase: 'completed', commandId, args, result: applied });
      this.emit('telemetry', { name: 'command.completed', timestamp: this.now(), properties: { commandId, durationMs: Date.now() - startedAt, status: applied.status } });
      return applied;
    } catch (cause) {
      const error = toError(cause, 'command_failed', `Command ${commandId} failed.`);
      this.emit('command', { phase: 'failed', commandId, args, error });
      this.reportError(error, { phase: 'command', commandId });
      throw error;
    } finally {
      this.pendingCommandIds.delete(commandId);
      this.refreshSnapshot();
    }
  }

  async applyOperations(operations: readonly Operation[], options: PlimDispatchOptions = {}): Promise<PlimCommandResult> {
    this.assertUsable('transaction');
    if (operations.length === 0) return { status: 'noop', snapshot: this.snapshot };
    if (this.isReadOnly() && !options.allowReadOnly) throw editorError('command_disabled', 'The editor is read-only.', 'info');
    const source = options.source ?? 'api';
    const transaction = createTransaction({
      workspaceId: this.document.workspace.id,
      clientId: this.clientId,
      operations: [...operations],
      idFactory: this.idFactory,
      clock: this.clock,
      baseVersions: baseVersions(this.document),
      ...(this.actorId ? { actorId: this.actorId } : {}),
      metadata: { source, ...(options.label ? { label: options.label } : {}), ...(options.metadata ? { extensions: options.metadata } : {}) }
    });

    if (this.mode === 'controlled' && this.controlledPolicy === 'strict') {
      this.pendingTransactions.set(String(transaction.id), { transaction, before: this.document, applied: false });
      this.emitTransaction('proposed', transaction);
      this.refreshSnapshot();
      return { status: 'pending', transaction, snapshot: this.snapshot };
    }

    const before = this.document;
    const result = applyTransaction(this.document, transaction, { clock: this.clock, ...(this.actorId ? { actorId: this.actorId } : {}) });
    if (!result.ok) {
      const error = editorError('schema_violation', result.error.message, 'error', true, result.error, issuesDetails(result.issues));
      this.emitTransaction('rejected', result.transaction);
      this.reportError(error, { phase: 'transaction' });
      throw error;
    }

    if (this.mode === 'controlled') {
      this.pendingTransactions.set(String(result.transaction.id), { transaction: result.transaction, before, applied: true });
      this.emitTransaction('proposed', result.transaction);
    }
    this.document = result.state;
    this.dirty = true;
    this.emitTransaction('applied', result.transaction);
    this.refreshSnapshot();
    this.emitChange('transaction', result.transaction);
    void this.persistSnapshot();
    return { status: this.mode === 'controlled' ? 'pending' : 'handled', transaction: result.transaction, snapshot: this.snapshot };
  }

  acceptTransaction(transactionId: TransactionId | string, document?: DocumentState): void {
    const key = String(transactionId);
    const pending = this.pendingTransactions.get(key);
    if (!pending) return;
    this.pendingTransactions.delete(key);
    if (document) this.setDocument(document, { preserveSelection: true, source: 'controlled', dirty: false });
    if (this.mode === 'controlled') this.dirty = false;
    this.emitTransaction('accepted', { ...pending.transaction, status: 'committed' });
    this.refreshSnapshot();
  }

  rejectTransaction(transactionId: TransactionId | string, document?: DocumentState): void {
    const key = String(transactionId);
    const pending = this.pendingTransactions.get(key);
    if (!pending) return;
    this.pendingTransactions.delete(key);
    this.document = document ? normalizeDocument(document) : pending.before;
    this.dirty = false;
    this.emitTransaction('rejected', { ...pending.transaction, status: 'rejected' });
    this.refreshSnapshot();
    this.emitChange('controlled', pending.transaction);
  }

  setDocument(document: DocumentState, options: PlimSetDocumentOptions = {}): void {
    this.assertUsable('document');
    this.document = options.validate === false ? document : normalizeDocument(document);
    this.selection = options.selection ?? (options.preserveSelection ? keepSelection(this.selection, this.document) : noneSelection);
    this.dirty = options.dirty ?? false;
    this.setStatus({ state: 'ready' });
    this.refreshSnapshot();
    if (!options.silent) this.emitChange(options.source ?? 'document');
  }

  setSelection(selection: PlimSelection, cause: PlimSelectionChangeEvent['cause'] = 'api'): void {
    this.selection = keepSelection(selection, this.document);
    this.refreshSnapshot();
    this.emit('selectionChange', { selection: this.selection, cause });
  }

  focus(selection?: PlimSelection): void {
    if (selection) this.setSelection(selection, 'focus');
    this.mountedElement?.focus();
  }

  registerCommand<TArgs = unknown>(command: PlimCommand<TArgs>): () => void {
    const previous = this.commands.get(command.id);
    this.commands.set(command.id, command as unknown as PlimCommand<unknown>);
    this.refreshSnapshot();
    return () => {
      if (previous) this.commands.set(command.id, previous);
      else this.commands.delete(command.id);
      this.refreshSnapshot();
    };
  }

  registerRenderer(type: BlockType | string, renderer: PlimBlockRenderer): () => void {
    const previous = this.renderers.get(type);
    this.renderers.set(type, renderer);
    this.refreshSnapshot();
    return () => {
      if (previous) this.renderers.set(type, previous);
      else this.renderers.delete(type);
      this.refreshSnapshot();
    };
  }

  installPlugin(plugin: PlimPlugin): void {
    if (this.pluginCleanups.has(plugin.id)) return;
    const cleanups: Array<() => void> = [];
    const api = this.pluginApi(cleanups);
    try {
      if (plugin.commands) cleanups.push(...this.registerCommandProvider(plugin.commands));
      if (plugin.renderers) cleanups.push(...this.registerPluginRenderers(plugin.renderers));
      const installed = plugin.onInstall?.(api);
      if (installed instanceof Promise) void installed.catch(cause => this.reportError(toError(cause, 'plugin_error', `Plugin ${plugin.id} failed to install.`), { phase: 'plugin', pluginId: plugin.id }));
      this.pluginCleanups.set(plugin.id, cleanups);
    } catch (cause) {
      for (const cleanup of cleanups) this.safeRun(cleanup, { phase: 'plugin', pluginId: plugin.id });
      this.reportError(toError(cause, 'plugin_error', `Plugin ${plugin.id} failed to install.`), { phase: 'plugin', pluginId: plugin.id });
    }
  }

  uninstallPlugin(plugin: PlimPlugin): void {
    const cleanups = this.pluginCleanups.get(plugin.id);
    if (!cleanups) return;
    const api = this.pluginApi([]);
    for (const cleanup of cleanups) this.safeRun(cleanup, { phase: 'plugin', pluginId: plugin.id });
    this.pluginCleanups.delete(plugin.id);
    const uninstalled = plugin.onUninstall?.(api);
    if (uninstalled instanceof Promise) void uninstalled.catch(cause => this.reportError(toError(cause, 'plugin_error', `Plugin ${plugin.id} failed to uninstall.`), { phase: 'plugin', pluginId: plugin.id }));
  }

  async loadPersistedSnapshot(): Promise<PlimPersistedSnapshot | null> {
    if (!this.persistence) return null;
    try {
      const snapshot = await this.persistence.load(this.persistenceKey);
      if (snapshot) {
        this.setDocument(snapshot.document, { preserveSelection: true, source: 'persistence', dirty: snapshot.dirty });
        this.emit('persistence', { adapterId: this.persistence.id, status: 'loaded' });
      }
      return snapshot;
    } catch (cause) {
      const error = toError(cause, 'storage_unavailable', 'Unable to load persisted Plim document.');
      this.setStatus({ state: 'degraded', reason: error.code, recoverable: true });
      this.emit('persistence', { adapterId: this.persistence.id, status: 'failed', error });
      this.reportError(error, { phase: 'persistence' });
      return null;
    }
  }

  async flushPersistence(): Promise<void> {
    if (!this.persistence) return;
    try {
      if (this.dirty && this.shouldPersist()) await this.persistence.save(this.persistenceKey, this.toPersistedSnapshot());
      await this.persistence.flush?.();
      this.dirty = false;
      this.refreshSnapshot();
      this.emit('persistence', { adapterId: this.persistence.id, status: 'flushed' });
    } catch (cause) {
      const error = toError(cause, 'storage_unavailable', 'Unable to flush Plim persistence.');
      this.emit('persistence', { adapterId: this.persistence.id, status: 'failed', error });
      this.reportError(error, { phase: 'persistence' });
    }
  }

  toPersistedSnapshot(): PlimPersistedSnapshot {
    return { object: 'plim_persisted_snapshot', document: this.document, version: this.version, savedAt: this.now(), dirty: this.dirty };
  }

  reportError(error: PlimEditorError, context: PlimErrorContext): void {
    const event: PlimErrorEvent = { error, context };
    try { this.options.onError?.(event); } catch { return; }
    const listeners = this.eventListeners.get('error');
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event); } catch { continue; }
    }
  }

  private registerBuiltIns(): void { for (const command of builtInCommands()) this.registerCommand(command); }
  private registerRendererMap(renderers: PlimBlockRendererMap | undefined): void { if (renderers) for (const [type, renderer] of Object.entries(renderers)) if (renderer) this.registerRenderer(type, renderer); }
  private registerPluginRenderers(renderers: readonly PlimRendererRegistration[] | PlimBlockRendererMap): readonly (() => void)[] { return Array.isArray(renderers) ? renderers.map(item => this.registerRenderer(item.type, item.renderer)) : Object.entries(renderers).flatMap(([type, renderer]) => renderer ? [this.registerRenderer(type, renderer)] : []); }

  private registerCommandProvider(provider: PlimCommandProvider): readonly (() => void)[] {
    if (typeof provider !== 'function') return provider.map(command => this.registerCommand(command));
    const result = provider(this.commandContext());
    if (result instanceof Promise) {
      void result.then(commands => { for (const command of commands) this.registerCommand(command); }).catch(cause => this.reportError(toError(cause, 'plugin_error', 'Async command provider failed.'), { phase: 'plugin' }));
      return [];
    }
    return result.map((command: PlimCommand) => this.registerCommand(command));
  }

  private commandContext(): PlimCommandContext {
    return {
      editor: this,
      document: this.document,
      selection: this.selection,
      readOnly: this.isReadOnly(),
      idFactory: this.idFactory,
      clock: this.clock,
      dispatchOperations: (operations, options) => this.applyOperations(operations, options),
      setDocument: (document, options) => this.setDocument(document, options),
      setSelection: (selection, cause) => this.setSelection(selection, cause)
    };
  }

  private pluginApi(cleanups: Array<() => void>): PlimPluginApi {
    return {
      editor: this,
      registerCommand: command => { const cleanup = this.registerCommand(command); cleanups.push(cleanup); return cleanup; },
      registerRenderer: (type, renderer) => { const cleanup = this.registerRenderer(type, renderer); cleanups.push(cleanup); return cleanup; },
      on: (eventName, listener) => { const cleanup = this.on(eventName, listener); cleanups.push(cleanup); return cleanup; },
      getSnapshot: () => this.getSnapshot(),
      executeCommand: (commandId, args) => this.executeCommand(commandId, args)
    };
  }

  private shouldPersist(): boolean { return Boolean(this.persistence && this.persistenceRole !== 'disabled' && (this.mode === 'uncontrolled' || this.persistenceRole === 'cache' || this.persistenceRole === 'drafts')); }

  private async persistSnapshot(): Promise<void> {
    if (!this.persistence || !this.shouldPersist()) return;
    try {
      await this.persistence.save(this.persistenceKey, this.toPersistedSnapshot());
      this.dirty = false;
      this.refreshSnapshot();
      this.emit('persistence', { adapterId: this.persistence.id, status: 'saved' });
    } catch (cause) {
      const error = toError(cause, 'storage_unavailable', 'Unable to save Plim snapshot.');
      this.dirty = true;
      this.refreshSnapshot();
      this.emit('persistence', { adapterId: this.persistence.id, status: 'failed', error });
      this.reportError(error, { phase: 'persistence' });
    }
  }

  private setStatus(status: PlimEditorStatus): void { this.status = status; this.refreshSnapshot(); this.emit('lifecycle', { status, timestamp: this.now() }); }
  private emitTransaction(phase: PlimTransactionEvent['phase'], transaction: TransactionRecord): void { this.emit('transaction', { phase, transaction, documentVersion: this.version, source: transaction.metadata?.source ?? 'api' }); }
  private emitChange(source: PlimChangeEvent['source'], transaction?: TransactionRecord): void { this.emit('change', { document: this.document, snapshot: this.snapshot, dirty: this.dirty, source, ...(transaction ? { transaction } : {}) }); }

  private emit<K extends keyof PlimEventMap>(eventName: K, event: PlimEventMap[K]): void {
    this.emitCallback(eventName, event);
    const listeners = this.eventListeners.get(eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event as AnyEvent); } catch (cause) { this.reportError(toError(cause, 'callback_failed', `Event listener for ${String(eventName)} failed.`), { phase: 'callback', eventName }); }
    }
  }

  private emitCallback<K extends keyof PlimEventMap>(eventName: K, event: PlimEventMap[K]): void {
    try {
      if (eventName === 'change') this.options.onChange?.(event as PlimChangeEvent);
      else if (eventName === 'transaction') this.options.onTransaction?.(event as PlimTransactionEvent);
      else if (eventName === 'selectionChange') this.options.onSelectionChange?.(event as PlimSelectionChangeEvent);
      else if (eventName === 'command') this.options.onCommand?.(event as PlimCommandEvent);
      else if (eventName === 'lifecycle') this.options.onStatusChange?.(event as PlimLifecycleEvent);
      else if (eventName === 'telemetry') this.options.telemetry?.(event as PlimTelemetryEvent);
      else if (eventName === 'error') this.options.onError?.(event as PlimErrorEvent);
    } catch (cause) {
      if (eventName !== 'error') this.reportError(toError(cause, 'callback_failed', `Callback for ${String(eventName)} failed.`), { phase: 'callback', eventName });
    }
  }

  private safeRun(callback: () => void, context: PlimErrorContext): void { try { callback(); } catch (cause) { this.reportError(toError(cause, 'callback_failed', 'Cleanup callback failed.'), context); } }
  private refreshSnapshot(): void { this.version += 1; this.snapshot = this.createSnapshot(); for (const listener of [...this.storeListeners]) listener(); }
  private createSnapshot(): PlimSnapshot { return { document: this.document, version: this.version, dirty: this.dirty, readOnly: this.computeReadOnly(false), selection: this.selection, status: this.status, pendingCommandIds: [...this.pendingCommandIds], pendingTransactionIds: [...this.pendingTransactions.keys()] }; }

  private computeReadOnly(report: boolean): boolean {
    const readOnly = this.options.readOnly;
    if (typeof readOnly === 'boolean') return readOnly;
    if (!readOnly) return false;
    try { return readOnly({ document: this.document, version: this.version, dirty: this.dirty, readOnly: false, selection: this.selection, status: this.status, pendingCommandIds: [...this.pendingCommandIds], pendingTransactionIds: [...this.pendingTransactions.keys()] }); }
    catch (cause) { if (report) this.reportError(toError(cause, 'callback_failed', 'Read-only callback failed.'), { phase: 'callback' }); return true; }
  }

  private now(): string { return this.clock.now(); }
  private assertUsable(phase: PlimErrorContext['phase']): void { if (this.destroyed) throw editorError('editor_destroyed', `Cannot use a destroyed Plim editor during ${phase}.`, 'fatal', false); }
}

export function createPlimReactEditor(options: PlimReactEditorOptions = {}): PlimReactEditor { return new PlimReactEditor(options); }

export function createMemoryPersistenceAdapter(initial?: Record<string, PlimPersistedSnapshot>): PlimPersistenceAdapter {
  const snapshots = new Map<string, PlimPersistedSnapshot>(Object.entries(initial ?? {}));
  const watchers = new Map<string, Set<(event: PlimPersistenceWatchEvent) => void>>();
  const notify = (key: string, snapshot: PlimPersistedSnapshot | null): void => { for (const watcher of watchers.get(key) ?? []) watcher({ key, snapshot, source: 'local' }); };
  return {
    id: 'memory',
    capabilities: { durable: false, async: false, supportsTransactions: false, supportsBroadcast: false },
    async load(key) { return snapshots.get(key) ?? null; },
    async save(key, snapshot) { snapshots.set(key, snapshot); notify(key, snapshot); },
    async remove(key) { snapshots.delete(key); notify(key, null); },
    watch(key, callback) { const set = watchers.get(key) ?? new Set<(event: PlimPersistenceWatchEvent) => void>(); set.add(callback); watchers.set(key, set); return () => { set.delete(callback); if (set.size === 0) watchers.delete(key); }; },
    async flush() { return undefined; }
  };
}

export function createHostPersistenceAdapter(callbacks: PlimHostPersistenceCallbacks): PlimPersistenceAdapter {
  return {
    id: callbacks.id ?? 'host',
    capabilities: { durable: true, async: true, supportsTransactions: false, supportsBroadcast: false },
    async load(key) { const loaded = callbacks.load ? await callbacks.load(key) : null; if (!loaded) return null; return isPersistedSnapshot(loaded) ? loaded : persisted(loaded, 0, systemClock.now(), false); },
    async save(key, snapshot) { await callbacks.save?.(key, snapshot); },
    async remove(key) { await callbacks.remove?.(key); },
    async flush() { await callbacks.flush?.(); }
  };
}

export function createLocalStoragePersistenceAdapter(options: { readonly storageKeyPrefix?: string; readonly storage?: Storage } = {}): PlimPersistenceAdapter {
  const prefix = options.storageKeyPrefix ?? 'plim:';
  const storage = (): Storage => { const target = options.storage ?? globalThis.localStorage; if (!target) throw editorError('storage_unavailable', 'localStorage is not available.', 'warning'); return target; };
  return {
    id: 'localStorage',
    capabilities: { durable: true, async: false, supportsTransactions: false, supportsBroadcast: true },
    async load(key) { const raw = storage().getItem(`${prefix}${key}`); if (!raw) return null; const parsed = JSON.parse(raw) as unknown; if (!isPersistedSnapshot(parsed)) throw editorError('invalid_document', 'Persisted localStorage value is not a Plim snapshot.'); return parsed; },
    async save(key, snapshot) { try { storage().setItem(`${prefix}${key}`, JSON.stringify(snapshot)); } catch (cause) { throw editorError('quota_exceeded', 'Unable to save Plim snapshot to localStorage.', 'warning', true, cause); } },
    async remove(key) { storage().removeItem(`${prefix}${key}`); },
    watch(key, callback) { const handler = (event: StorageEvent): void => { if (event.key !== `${prefix}${key}`) return; const parsed = event.newValue ? JSON.parse(event.newValue) as unknown : null; callback({ key, snapshot: isPersistedSnapshot(parsed) ? parsed : null, source: 'external' }); }; globalThis.addEventListener?.('storage', handler); return () => globalThis.removeEventListener?.('storage', handler); },
    async flush() { return undefined; }
  };
}

const PlimEditorContext = React.createContext<PlimReactEditor | null>(null);

export function PlimEditorProvider(props: PlimEditorProviderProps): React.ReactElement {
  const { children, editor: suppliedEditor, document: controlledDocument, renderers, commandProviders, readOnly, onChange, onTransaction, onSelectionChange, onCommand, onError, onStatusChange, telemetry, locale, messages, direction, theme } = props;
  const editorRef = React.useRef<PlimReactEditor | null>(null);
  if (suppliedEditor) editorRef.current = suppliedEditor;
  if (!editorRef.current) editorRef.current = new PlimReactEditor(props);
  const editor = editorRef.current;

  React.useEffect(() => {
    editor.updateOptions({ readOnly, onChange, onTransaction, onSelectionChange, onCommand, onError, onStatusChange, telemetry, locale, messages, direction, theme, renderers, commandProviders });
  }, [editor, readOnly, onChange, onTransaction, onSelectionChange, onCommand, onError, onStatusChange, telemetry, locale, messages, direction, theme, renderers, commandProviders]);

  React.useEffect(() => { if (controlledDocument) editor.setDocument(controlledDocument, { preserveSelection: true, source: 'controlled', dirty: false, silent: true }); }, [editor, controlledDocument]);
  React.useEffect(() => { if (props.loadFromPersistence) void editor.loadPersistedSnapshot(); }, [editor, props.loadFromPersistence]);
  return React.createElement(PlimEditorContext.Provider, { value: editor }, children);
}

export function usePlimEditor(): PlimReactEditor {
  const editor = React.useContext(PlimEditorContext);
  if (!editor) throw editorError('missing_provider', 'usePlimEditor must be used inside PlimEditorProvider.');
  return editor;
}

export function usePlimEditorState<TSelected = PlimSnapshot>(selector?: (snapshot: PlimSnapshot) => TSelected): TSelected {
  const editor = usePlimEditor();
  const snapshot = React.useSyncExternalStore(
    React.useCallback(listener => editor.subscribe(listener), [editor]),
    React.useCallback(() => editor.getSnapshot(), [editor]),
    React.useCallback(() => editor.getSnapshot(), [editor])
  );
  const select = selector ?? ((value: PlimSnapshot) => value as TSelected);
  return select(snapshot);
}

export function usePlimCommand<TArgs = unknown>(commandId: string): PlimCommandHook<TArgs> {
  const editor = usePlimEditor();
  const snapshot = usePlimEditorState(value => value);
  const execute = React.useCallback((args: TArgs) => editor.executeCommand(commandId, args), [editor, commandId]);
  return { execute, canExecute: editor.canExecuteCommand(commandId), isPending: snapshot.pendingCommandIds.includes(commandId), command: editor.getCommand(commandId) };
}

export function PlimEditor(props: PlimEditorProps): React.ReactElement {
  const editor = React.useContext(PlimEditorContext);
  if (editor) return React.createElement(PlimEditorSurface, props);
  return React.createElement(PlimEditorProvider, { ...props, children: React.createElement(PlimEditorSurface, props) });
}

export function PlimBlock(props: PlimBlockProps): React.ReactElement | null {
  const editor = usePlimEditor();
  const snapshot = usePlimEditorState(value => value);
  const block = snapshot.document.blocks[props.blockId];
  if (!block) return null;
  const level = props.level ?? 1;
  const selected = snapshot.selection.kind !== 'none' && snapshot.selection.blockId === block.id;
  const children = block.children.map(childId => React.createElement(PlimBlock, { key: String(childId), blockId: childId, level: level + 1, ...(props.renderers ? { renderers: props.renderers } : {}) }));
  const context: PlimBlockRendererContext = {
    block,
    document: snapshot.document,
    editor,
    readOnly: snapshot.readOnly,
    selected,
    level,
    children,
    attributes: blockAttributes(block, level, snapshot.readOnly, selected),
    messages: editor.getMessages(),
    dispatchCommand: (commandId, args) => editor.executeCommand(commandId, args),
    renderChildren: () => children
  };
  const renderer = props.renderers?.[block.type] ?? editor.getRenderer(block.type) ?? defaultBlockRenderer;
  const themeContext: PlimBlockThemeContext = { block, level, selected, readOnly: snapshot.readOnly };
  const theme = editor.getTheme();
  const className = classNames('plim-block', `plim-block--${block.type}`, selected ? 'plim-block--selected' : undefined, resolveClass(theme?.blockClassName, themeContext), props.className);
  const style = mergeStyles(resolveStyle(theme?.blockStyle, themeContext), props.style);
  try {
    return React.createElement('div', {
      ...context.attributes,
      className,
      style,
      onFocus: event => {
        if (nearestBlockElement(event.target) !== event.currentTarget) return;
        editor.setSelection({ kind: 'block', blockId: block.id }, 'focus');
      }
    }, renderer(context));
  } catch (cause) {
    const error = toError(cause, 'renderer_error', `Renderer for block ${String(block.id)} failed.`);
    editor.reportError(error, { phase: 'renderer', blockId: block.id });
    return React.createElement('div', { ...context.attributes, className: classNames(className, 'plim-block--renderer-error'), style }, context.messages.unsupportedBlock);
  }
}

function PlimEditorSurface(props: PlimEditorProps): React.ReactElement {
  const editor = usePlimEditor();
  const snapshot = usePlimEditorState(value => value);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    void editor.mount(element);
    return () => { void editor.unmount(); };
  }, [editor]);

  const rootPageId = props.rootPageId ?? snapshot.document.workspace.settings?.defaultPageId ?? snapshot.document.workspace.rootPageIds[0];
  const theme = props.theme ?? editor.getTheme();
  const messages = { ...editor.getMessages(), ...props.messages };
  const direction = props.direction ?? editor.getDirection();
  const content = rootPageId
    ? React.createElement(PlimBlock, { blockId: rootPageId, level: 1, ...(props.blockRenderers ? { renderers: props.blockRenderers } : {}), ...(props.blockClassName ? { className: props.blockClassName } : {}), ...(props.blockStyle ? { style: props.blockStyle } : {}) })
    : React.createElement('div', { role: 'alert', className: 'plim-editor__empty' }, 'No root page available.');

  return React.createElement('div', {
    ref,
    role: 'region',
    'aria-label': props.ariaLabel ?? messages.editorLabel,
    'aria-readonly': snapshot.readOnly || undefined,
    dir: direction === 'auto' ? undefined : direction,
    className: classNames('plim-editor', theme?.className, props.className),
    style: mergeStyles(themeVariables(theme), theme?.style, props.style),
    tabIndex: 0,
    'data-plim-editor': 'true',
    'data-plim-status': snapshot.status.state,
    'data-plim-color-scheme': theme?.colorScheme ?? 'system'
  }, content, React.createElement('div', { className: 'plim-editor__live-region', 'aria-live': 'polite', style: hiddenStyle }));
}

function builtInCommands(): readonly PlimCommand<unknown>[] {
  return [
    { id: 'plim.applyOperations', title: 'Apply operations', aliases: ['apply'], category: 'advanced', contexts: ['api'], run: (ctx, args) => ctx.dispatchOperations(readOperations(args), commandOptions(args)) },
    { id: 'plim.setDocument', title: 'Replace document', aliases: ['document'], category: 'advanced', contexts: ['api'], run: (ctx, args) => { const doc = readObject(args).document; if (!isDocumentState(doc)) throw editorError('invalid_document', 'plim.setDocument requires a DocumentState.'); ctx.setDocument(doc, { preserveSelection: true, source: 'document' }); return { status: 'handled', snapshot: ctx.editor.getSnapshot() }; } },
    { id: 'plim.replaceBlockRichText', title: 'Replace block text', aliases: ['text'], category: 'inline', contexts: ['text', 'block'], run: (ctx, args) => { const input = readObject(args); const blockId = readBlockId(input, 'blockId'); const block = requireBlock(ctx.document, blockId); const field = readString(input, 'field') ?? 'richText'; const current = richTextField(block, field); const text = readString(input, 'text') ?? ''; return ctx.dispatchOperations([{ op: 'replace_rich_text', target: { blockId, field: { kind: 'block_data', key: field } }, range: fullRange(plainTextFromRichText(current)), replacement: richTextFromPlainText(text) }], { source: 'input', label: 'Replace text' }); } },
    { id: 'plim.replacePageTitle', title: 'Replace page title', aliases: ['title'], category: 'inline', contexts: ['text', 'block'], run: (ctx, args) => { const input = readObject(args); const pageId = readPageId(input, 'pageId'); const page = ctx.document.pages[pageId]; if (!page) throw editorError('missing_record', 'Page does not exist.'); const property = page.properties[TITLE_PROPERTY_ID]; const title = property?.type === 'title' ? property.title : []; const text = readString(input, 'text') ?? ''; return ctx.dispatchOperations([{ op: 'replace_rich_text', target: { pageId, propertyId: TITLE_PROPERTY_ID, field: { kind: 'page_property', pageId, propertyId: TITLE_PROPERTY_ID } }, range: fullRange(plainTextFromRichText(title)), replacement: richTextFromPlainText(text) }], { source: 'input', label: 'Replace page title' }); } },
    { id: 'plim.insertBlock', title: 'Insert block', aliases: ['insert', '+'], category: 'basic', contexts: ['api', 'block', 'text'], run: (ctx, args) => { const input = readObject(args); const parentId = readBlockOrPageId(input, 'parentId'); const type = readBlockType(input, 'type', 'paragraph'); const block = createBlock({ workspaceId: ctx.document.workspace.id, parent: parentRefForContainer(ctx.document, parentId), type, data: dataWithText(type, readString(input, 'text'), readJson(input.dataPatch)), idFactory: ctx.idFactory, clock: ctx.clock }); return ctx.dispatchOperations([{ op: 'create_block', block }, { op: 'insert_child', parentId, childId: block.id, at: readPosition(input.at) }], { source: 'command', label: 'Insert block' }); } },
    { id: 'plim.updateBlock', title: 'Update block', aliases: ['update'], category: 'advanced', contexts: ['api', 'block'], run: (ctx, args) => { const input = readObject(args); return ctx.dispatchOperations([{ op: 'update_block', blockId: readBlockId(input, 'blockId'), patch: readObject(input.patch) as DeepPartial<BlockRecord> }], { source: 'api', label: 'Update block' }); } },
    { id: 'plim.setBlockType', title: 'Turn into', aliases: ['turn into', 'type'], category: 'basic', contexts: ['block', 'text'], run: (ctx, args) => { const input = readObject(args); const dataPatch = readJson(input.dataPatch); return ctx.dispatchOperations([{ op: 'set_block_type', blockId: readBlockId(input, 'blockId'), type: readBlockType(input, 'type', 'paragraph'), ...(dataPatch ? { dataPatch } : {}), preservePreviousData: true }], { source: 'command', label: 'Set block type' }); } },
    { id: 'plim.deleteBlock', title: 'Delete block', aliases: ['delete', 'trash'], category: 'basic', contexts: ['block'], run: (ctx, args) => { const input = readObject(args); const blockId = readBlockId(input, 'blockId'); const block = requireBlock(ctx.document, blockId); return ctx.dispatchOperations([{ op: 'remove_child', parentId: readOptionalBlockOrPageId(input, 'parentId') ?? parentId(block), childId: blockId, mode: readRemoveMode(input.mode) }], { source: 'command', label: 'Delete block' }); } },
    { id: 'plim.moveBlock', title: 'Move block', aliases: ['move'], category: 'basic', contexts: ['block'], run: (ctx, args) => { const input = readObject(args); return ctx.dispatchOperations([{ op: 'move_block', blockId: readBlockId(input, 'blockId'), newParentId: readBlockOrPageId(input, 'newParentId'), at: readPosition(input.at) }], { source: 'command', label: 'Move block' }); } },
    { id: 'plim.toggleToDo', title: 'Toggle to-do', aliases: ['todo', 'check'], category: 'basic', contexts: ['block'], run: (ctx, args) => { const input = readObject(args); const blockId = readBlockId(input, 'blockId'); const block = ctx.document.blocks[blockId]; if (!block || block.type !== 'to_do') return { status: 'noop', snapshot: ctx.editor.getSnapshot() }; const todo = block as BlockRecord<'to_do'>; const checked = typeof input.checked === 'boolean' ? input.checked : !todo.data.checked; return ctx.dispatchOperations([{ op: 'update_block', blockId, patch: { data: { checked } } }], { source: 'command', label: 'Toggle to-do' }); } },
    { id: 'plim.setSelection', title: 'Set selection', aliases: ['selection'], category: 'advanced', contexts: ['api'], mutates: false, run: (ctx, args) => { const selection = readSelection(args); ctx.setSelection(selection, 'api'); return { status: 'handled', snapshot: ctx.editor.getSnapshot(), selection }; } }
  ];
}

function defaultBlockRenderer(ctx: PlimBlockRendererContext): React.ReactNode {
  switch (ctx.block.type) {
    case 'page': return renderPage(ctx);
    case 'paragraph': return editableRichText(ctx, 'div', 'richText');
    case 'heading_1': return editableRichText(ctx, 'h1', 'richText');
    case 'heading_2': return editableRichText(ctx, 'h2', 'richText');
    case 'heading_3': return editableRichText(ctx, 'h3', 'richText');
    case 'bulleted_list_item': return React.createElement('ul', { className: 'plim-list plim-list--bulleted' }, React.createElement('li', null, editableRichText(ctx, 'div', 'richText', false), ctx.children));
    case 'numbered_list_item': return React.createElement('ol', { className: 'plim-list plim-list--numbered' }, React.createElement('li', null, editableRichText(ctx, 'div', 'richText', false), ctx.children));
    case 'to_do': return renderTodo(ctx);
    case 'toggle':
    case 'toggle_heading_1':
    case 'toggle_heading_2':
    case 'toggle_heading_3': return renderToggle(ctx);
    case 'quote': return React.createElement('blockquote', null, editableRichText(ctx, 'div', 'richText', false), ctx.children);
    case 'callout': return React.createElement('aside', { className: 'plim-callout' }, editableRichText(ctx, 'div', 'richText', false), ctx.children);
    case 'code': return renderCode(ctx);
    case 'equation': { const block = ctx.block as BlockRecord<'equation'>; return React.createElement('figure', null, React.createElement('code', { className: 'plim-equation' }, block.data.expression), caption(block.data.caption)); }
    case 'divider': return React.createElement('hr', null);
    case 'table_of_contents': return renderToc(ctx);
    case 'breadcrumb': return React.createElement('nav', { 'aria-label': 'Breadcrumb', className: 'plim-breadcrumb' }, breadcrumb(ctx.document, ctx.block.id));
    case 'child_page': { const block = ctx.block as BlockRecord<'child_page'>; return React.createElement('a', { href: `#${String(block.data.pageId)}`, className: 'plim-child-page' }, block.data.titleSnapshot ?? String(block.data.pageId)); }
    case 'child_database': { const block = ctx.block as BlockRecord<'child_database'>; return React.createElement('div', { className: 'plim-child-database' }, block.data.titleSnapshot ?? String(block.data.databaseId)); }
    case 'database_view': { const block = ctx.block as BlockRecord<'database_view'>; return React.createElement('section', { className: 'plim-database-view', 'aria-label': 'Database view' }, String(block.data.viewId)); }
    case 'column_list': return React.createElement('div', { className: 'plim-column-list' }, ctx.children);
    case 'column': { const block = ctx.block as BlockRecord<'column'>; return React.createElement('div', { className: 'plim-column', style: block.data.widthRatio ? { flex: `${block.data.widthRatio} 1 0` } : undefined }, ctx.children); }
    case 'table': return React.createElement('table', { className: 'plim-table' }, React.createElement('tbody', null, ctx.children));
    case 'table_row': { const block = ctx.block as BlockRecord<'table_row'>; return React.createElement('tr', null, block.data.cells.map((cell: RichText, index: number) => React.createElement('td', { key: index }, richText(cell)))); }
    case 'template': { const block = ctx.block as BlockRecord<'template'>; return React.createElement('section', { className: 'plim-template' }, richText(block.data.richText), ctx.children); }
    case 'synced_block': return React.createElement('section', { className: 'plim-synced-block' }, ctx.children);
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf': return renderFile(ctx);
    case 'bookmark':
    case 'embed':
    case 'link_preview': return renderLink(ctx);
    case 'unsupported': return React.createElement('div', { role: 'note', className: 'plim-unsupported-block' }, ctx.messages.unsupportedBlock);
  }
}

function renderPage(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'page'>;
  const title = plainTextFromRichText(block.data.title);
  const onInput = (event: React.FormEvent<HTMLElement>): void => {
    if (!ctx.readOnly) void ctx.dispatchCommand('plim.replacePageTitle', { pageId: block.id, text: event.currentTarget.textContent ?? '' });
  };
  return React.createElement(React.Fragment, null,
    React.createElement('h1', { className: 'plim-page-title', contentEditable: ctx.readOnly ? undefined : true, suppressContentEditableWarning: true, onInput, 'aria-label': 'Page title', spellCheck: true }, title ? richText(block.data.title) : ctx.messages.pageTitlePlaceholder),
    ctx.children
  );
}

function editableRichText(ctx: PlimBlockRendererContext, tag: 'div' | 'span' | 'h1' | 'h2' | 'h3', field: string, includeChildren = true): React.ReactNode {
  const value = richTextField(ctx.block, field);
  const onInput = (event: React.FormEvent<HTMLElement>): void => {
    if (!ctx.readOnly) void ctx.dispatchCommand('plim.replaceBlockRichText', { blockId: ctx.block.id, field, text: event.currentTarget.textContent ?? '' });
  };
  const content = value.length > 0 ? richText(value) : React.createElement('span', { className: 'plim-placeholder', 'aria-hidden': 'true' }, ctx.messages.emptyParagraph);
  return React.createElement(tag, { className: 'plim-rich-text', contentEditable: ctx.readOnly ? undefined : true, suppressContentEditableWarning: true, onInput, spellCheck: ctx.block.type !== 'code', 'data-plim-rich-text-field': field, 'aria-label': label(ctx.block.type) }, content, includeChildren ? ctx.children : undefined);
}

function renderTodo(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'to_do'>;
  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => { void ctx.dispatchCommand('plim.toggleToDo', { blockId: block.id, checked: event.currentTarget.checked }); };
  return React.createElement('div', { className: 'plim-to-do' }, React.createElement('input', { type: 'checkbox', checked: block.data.checked, disabled: ctx.readOnly, onChange, 'aria-label': 'To-do checked' }), editableRichText(ctx, 'span', 'richText', false), ctx.children);
}

function renderToggle(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'toggle'>;
  return React.createElement('details', { open: !block.data.collapsed, className: 'plim-toggle' }, React.createElement('summary', null, editableRichText(ctx, 'span', 'richText', false)), ctx.children);
}

function renderCode(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'code'>;
  return React.createElement('figure', { className: 'plim-code-block' }, React.createElement('pre', null, React.createElement('code', { 'data-language': block.data.language ?? 'plain text' }, plainTextFromRichText(block.data.richText))), caption(block.data.caption));
}

function renderToc(ctx: PlimBlockRendererContext): React.ReactNode {
  const headings = Object.values(ctx.document.blocks).filter(block => block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3');
  return React.createElement('nav', { className: 'plim-table-of-contents', 'aria-label': 'Table of contents' }, headings.map(block => React.createElement('a', { key: String(block.id), href: `#${String(block.id)}` }, plainTextFromRichText(richTextField(block, 'richText')))));
}

function renderFile(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'image'> | BlockRecord<'video'> | BlockRecord<'audio'> | BlockRecord<'file'> | BlockRecord<'pdf'>;
  const url = fileUrl(block.data.file);
  if (block.type === 'image') return React.createElement('figure', null, React.createElement('img', { src: url, alt: plainTextFromRichText(block.data.caption ?? []) || 'Image block' }), caption(block.data.caption));
  if (block.type === 'video') return React.createElement('figure', null, React.createElement('video', { src: url, controls: true, title: 'Video block' }), caption(block.data.caption));
  if (block.type === 'audio') return React.createElement('figure', null, React.createElement('audio', { src: url, controls: true }), caption(block.data.caption));
  return React.createElement('a', { href: url, className: 'plim-file-block' }, block.type.toUpperCase());
}

function renderLink(ctx: PlimBlockRendererContext): React.ReactNode {
  const block = ctx.block as BlockRecord<'bookmark'> | BlockRecord<'embed'> | BlockRecord<'link_preview'>;
  return React.createElement('a', { href: block.data.url, className: `plim-${block.type}`, target: '_blank', rel: 'noreferrer' }, block.data.metadata?.title ?? block.data.url);
}

function caption(value: RichText | undefined): React.ReactNode { return value && value.length > 0 ? React.createElement('figcaption', null, richText(value)) : null; }
function richText(value: RichText): React.ReactNode { return value.map((span, index) => spanNode(span, index)); }

function spanNode(span: RichTextSpan, index: number): React.ReactNode {
  let node: React.ReactNode;
  if (span.type === 'text') node = span.text.link?.url ? React.createElement('a', { href: span.text.link.url }, span.text.content) : span.text.content;
  else if (span.type === 'mention') node = React.createElement('span', { className: 'plim-mention', 'data-plim-mention-kind': span.mention.kind }, span.plainText ?? '@mention');
  else node = React.createElement('code', { className: 'plim-inline-equation' }, span.equation.expression);
  if (span.annotations?.code) node = React.createElement('code', null, node);
  if (span.annotations?.bold) node = React.createElement('strong', null, node);
  if (span.annotations?.italic) node = React.createElement('em', null, node);
  if (span.annotations?.underline) node = React.createElement('u', null, node);
  if (span.annotations?.strikethrough) node = React.createElement('s', null, node);
  return React.createElement('span', { key: index, className: span.annotations?.color ? `plim-color--${span.annotations.color}` : undefined }, node);
}

function normalizeInitialDocument(document: DocumentState | undefined, idFactory: IdFactory, clock: Clock): DocumentState { return document ? normalizeDocument(document) : createEmptyDocument({ idFactory, clock }); }
function normalizeDocument(document: DocumentState): DocumentState { const validation = validateDocumentState(document, { normalize: true }); const normalized = validation.normalized ?? normalizeDocumentState(document); if (!validation.ok) throw editorError('invalid_document', 'Document failed Plim validation.', 'error', true, undefined, issuesDetails(validation.issues)); return normalized; }

function runtimeOptions(options: RuntimeUpdateOptions): RuntimeOptions {
  return {
    ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    ...(options.onChange ? { onChange: options.onChange } : {}),
    ...(options.onTransaction ? { onTransaction: options.onTransaction } : {}),
    ...(options.onSelectionChange ? { onSelectionChange: options.onSelectionChange } : {}),
    ...(options.onCommand ? { onCommand: options.onCommand } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onStatusChange ? { onStatusChange: options.onStatusChange } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.messages ? { messages: options.messages } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.theme ? { theme: options.theme } : {})
  };
}

function editorError(code: string, message: string, severity: PlimEditorError['severity'] = 'error', recoverable = true, cause?: unknown, details?: JsonObject): PlimReactError { return new PlimReactError(code, message, { severity, recoverable, ...(cause !== undefined ? { cause } : {}), ...(details ? { details } : {}) }); }
function toError(cause: unknown, code: string, message: string): PlimEditorError { return isPlimError(cause) ? cause : editorError(code, cause instanceof Error ? cause.message : message, 'error', true, cause); }
function isPlimError(value: unknown): value is PlimEditorError { return value instanceof Error && isRecord(value) && typeof value.code === 'string' && typeof value.recoverable === 'boolean'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isDocumentState(value: unknown): value is DocumentState { return isRecord(value) && isRecord(value.schema) && isRecord(value.workspace) && isRecord(value.blocks); }
function isPersistedSnapshot(value: unknown): value is PlimPersistedSnapshot { return isRecord(value) && value.object === 'plim_persisted_snapshot' && isDocumentState(value.document) && typeof value.version === 'number' && typeof value.savedAt === 'string'; }
function persisted(document: DocumentState, version: number, savedAt: string, dirty: boolean): PlimPersistedSnapshot { return { object: 'plim_persisted_snapshot', document, version, savedAt, dirty }; }
function issuesDetails(issues: readonly ValidationIssue[]): JsonObject { return { issues: issues.map(issue => ({ severity: issue.severity, code: issue.code, message: issue.message, path: issue.path })) }; }
function baseVersions(document: DocumentState): Record<string, number> { const out: Record<string, number> = {}; for (const block of Object.values(document.blocks)) out[String(block.id)] = block.version; for (const page of Object.values(document.pages)) out[String(page.id)] = page.version; return out; }
function keepSelection(selection: PlimSelection, document: DocumentState): PlimSelection { return selection.kind === 'none' || document.blocks[selection.blockId] ? selection : noneSelection; }
function blockAttributes(block: BlockRecord, level: number, readOnly: boolean, selected: boolean): PlimBlockRenderAttributes { const role = roleFor(block); const heading = headingLevel(block.type); return { role, tabIndex: 0, 'data-plim-block-id': String(block.id), 'data-plim-block-type': block.type, 'aria-label': `${label(block.type)} block${selected ? ', selected' : ''}`, ...(readOnly ? { 'aria-readonly': true } : {}), ...(heading !== undefined ? { 'aria-level': heading } : role === 'treeitem' ? { 'aria-level': level } : {}), ...(block.type === 'to_do' ? { 'aria-checked': (block as BlockRecord<'to_do'>).data.checked } : {}), ...(isToggle(block) ? { 'aria-expanded': !block.data.collapsed } : {}) }; }
function roleFor(block: BlockRecord): string { if (block.type === 'page') return 'document'; if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') return 'heading'; if (block.type === 'to_do') return 'checkbox'; if (block.type === 'table_row') return 'row'; return 'treeitem'; }
function headingLevel(type: BlockType): number | undefined { if (type === 'heading_1' || type === 'toggle_heading_1') return 1; if (type === 'heading_2' || type === 'toggle_heading_2') return 2; if (type === 'heading_3' || type === 'toggle_heading_3') return 3; return undefined; }
function label(type: string): string { return type.replaceAll('_', ' '); }
function isToggle(block: BlockRecord): block is BlockRecord<'toggle'> | BlockRecord<'toggle_heading_1'> | BlockRecord<'toggle_heading_2'> | BlockRecord<'toggle_heading_3'> { return block.type === 'toggle' || block.type === 'toggle_heading_1' || block.type === 'toggle_heading_2' || block.type === 'toggle_heading_3'; }
function richTextField(block: BlockRecord, field: string): RichText { const value = (block.data as Record<string, unknown>)[field]; return Array.isArray(value) ? value as RichText : []; }
function fullRange(text: string): TextRangeAnchor { return { startUtf16: 0, endUtf16: text.length, textQuote: { exact: text } }; }
function parentId(block: BlockRecord): BlockId | PageId { if (block.parent.kind === 'block') return block.parent.blockId; if (block.parent.kind === 'page') return block.parent.pageId; throw editorError('invalid_parent', 'Block does not have a block or page parent.'); }
function fileUrl(file: BlockDataByType['image']['file']): string { if (file.type === 'external') return file.url; if (file.type === 'data_url') return file.dataUrl; return `#${String(file.fileId)}`; }
function breadcrumb(document: DocumentState, blockId: BlockId): string { const labels: string[] = []; let current = document.blocks[blockId]; const seen = new Set<BlockId>(); while (current && !seen.has(current.id)) { seen.add(current.id); if (current.type === 'page') labels.unshift(plainTextFromRichText((current as BlockRecord<'page'>).data.title)); const next = current.parent.kind === 'block' ? current.parent.blockId : current.parent.kind === 'page' ? current.parent.pageId : undefined; current = next ? document.blocks[next] : undefined; } return labels.filter(Boolean).join(' / '); }
function requireBlock(document: DocumentState, blockId: BlockId): BlockRecord { const block = document.blocks[blockId]; if (!block) throw editorError('missing_record', 'Block does not exist.'); return block; }
function dataWithText(type: BlockType, text: string | undefined, patch: JsonObject | undefined): BlockDataByType[BlockType] { const next: Record<string, unknown> = { ...(defaultBlockData(type) as Record<string, unknown>) }; if (text !== undefined) { if ('richText' in next) next.richText = richTextFromPlainText(text); if (type === 'page') next.title = richTextFromPlainText(text); } if (patch) for (const [key, value] of Object.entries(patch)) next[key] = value; return next as BlockDataByType[BlockType]; }
function readObject(value: unknown): Record<string, unknown> { if (isRecord(value)) return value; throw editorError('invalid_command_args', 'Command arguments must be an object.'); }
function readString(value: Record<string, unknown>, key: string): string | undefined { const result = value[key]; return typeof result === 'string' ? result : undefined; }
function readBlockId(value: Record<string, unknown>, key: string): BlockId { const result = value[key]; if (typeof result !== 'string') throw editorError('invalid_command_args', `${key} must be a block ID.`); return result as BlockId; }
function readPageId(value: Record<string, unknown>, key: string): PageId { const result = value[key]; if (typeof result !== 'string') throw editorError('invalid_command_args', `${key} must be a page ID.`); return result as PageId; }
function readBlockOrPageId(value: Record<string, unknown>, key: string): BlockId | PageId { const result = value[key]; if (typeof result !== 'string') throw editorError('invalid_command_args', `${key} must be a block or page ID.`); return result as BlockId | PageId; }
function readOptionalBlockOrPageId(value: Record<string, unknown>, key: string): BlockId | PageId | undefined { const result = value[key]; return typeof result === 'string' ? result as BlockId | PageId : undefined; }
function readBlockType(value: Record<string, unknown>, key: string, fallback: BlockType): BlockType { const result = value[key]; return typeof result === 'string' && knownBlockTypes.has(result as BlockType) ? result as BlockType : fallback; }
function readPosition(value: unknown): InsertPosition { if (!isRecord(value)) return { kind: 'append' }; if (value.kind === 'index' && typeof value.index === 'number') return { kind: 'index', index: value.index }; if (value.kind === 'before' && typeof value.siblingId === 'string') return { kind: 'before', siblingId: value.siblingId as BlockId }; if (value.kind === 'after' && typeof value.siblingId === 'string') return { kind: 'after', siblingId: value.siblingId as BlockId }; return { kind: 'append' }; }
function readRemoveMode(value: unknown): 'detach' | 'trash' | 'delete' { return value === 'detach' || value === 'trash' || value === 'delete' ? value : 'trash'; }
function readOperations(value: unknown): readonly Operation[] { const operations = readObject(value).operations; if (!Array.isArray(operations)) throw editorError('invalid_command_args', 'operations must be an array.'); return operations as Operation[]; }
function commandOptions(value: unknown): PlimDispatchOptions { const input = isRecord(value) ? value : {}; const source = typeof input.source === 'string' && transactionSources.has(input.source as PlimTransactionSource) ? input.source as PlimTransactionSource : undefined; const labelValue = typeof input.label === 'string' ? input.label : undefined; return { ...(source ? { source } : {}), ...(labelValue ? { label: labelValue } : {}) }; }
function readJson(value: unknown): JsonObject | undefined { if (!isRecord(value)) return undefined; const out: JsonObject = {}; for (const [key, child] of Object.entries(value)) if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child === null) out[key] = child; return out; }
function readSelection(value: unknown): PlimSelection { const input = readObject(value); if (input.kind === 'block' && typeof input.blockId === 'string') return { kind: 'block', blockId: input.blockId as BlockId }; if (input.kind === 'text' && typeof input.blockId === 'string') return { kind: 'text', blockId: input.blockId as BlockId, field: typeof input.field === 'string' ? input.field : 'richText', anchorOffset: typeof input.anchorOffset === 'number' ? input.anchorOffset : 0, focusOffset: typeof input.focusOffset === 'number' ? input.focusOffset : 0 }; return noneSelection; }
function themeVariables(theme: PlimTheme | undefined): React.CSSProperties | undefined { if (!theme?.variables) return undefined; const style: Record<string, string> = {}; for (const [token, value] of Object.entries(theme.variables)) if (value) style[`--plim-${token.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = value; return style as React.CSSProperties; }
function resolveClass(value: PlimTheme['blockClassName'] | undefined, context: PlimBlockThemeContext): string | undefined { return typeof value === 'function' ? value(context) : value; }
function resolveStyle(value: PlimTheme['blockStyle'] | undefined, context: PlimBlockThemeContext): React.CSSProperties | undefined { return typeof value === 'function' ? value(context) : value; }
function mergeStyles(...styles: Array<React.CSSProperties | undefined>): React.CSSProperties | undefined { const result: React.CSSProperties = {}; for (const style of styles) if (style) Object.assign(result, style); return Object.keys(result).length > 0 ? result : undefined; }
function classNames(...values: Array<string | undefined>): string | undefined { const result = values.filter(Boolean).join(' '); return result || undefined; }
function nearestBlockElement(target: EventTarget): Element | null { return target instanceof Element ? target.closest('[data-plim-block-id]') : null; }

const hiddenStyle: React.CSSProperties = { border: 0, clip: 'rect(0 0 0 0)', height: 1, margin: -1, overflow: 'hidden', padding: 0, position: 'absolute', width: 1, whiteSpace: 'nowrap' };
const transactionSources = new Set<PlimTransactionSource>(['keyboard', 'input', 'paste', 'drop', 'command', 'api', 'import', 'persistence', 'history', 'plugin']);
const knownBlockTypes = new Set<BlockType>(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'toggle_heading_1', 'toggle_heading_2', 'toggle_heading_3', 'quote', 'callout', 'code', 'equation', 'divider', 'table_of_contents', 'breadcrumb', 'page', 'child_page', 'child_database', 'database_view', 'column_list', 'column', 'table', 'table_row', 'template', 'synced_block', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed', 'link_preview', 'unsupported']);

export const packageMetadata = { name: '@plim/react', status: 'implemented', implementsRuntime: true, dependsOn: ['@plim/model'], peerDependencies: ['react'] } as const;
