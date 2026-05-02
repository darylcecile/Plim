import {
  applyTransaction as applyModelTransaction,
  cloneDeep,
  createEmptyDocument,
  createIdFactory,
  createParagraphBlock,
  createTransaction,
  validateDocumentState
} from '@plim/model';
import type {
  BlockId,
  Clock,
  DocumentState,
  IdFactory,
  Operation,
  PageId,
  ParentRef,
  TransactionId,
  TransactionMetadata,
  TransactionRecord,
  UserId,
  ValidationIssue,
  WorkspaceId
} from '@plim/model';
import { EditorDestroyedError, EditorError, toEditorError } from './errors.js';
import { EditorEventEmitter } from './events.js';
import { CommandRegistry, RendererRegistry, SchemaRegistry, ValidationRegistry } from './registries.js';
import { VanillaEditorSurface } from './render.js';
import { createEditorState, createSnapshot, isEditorSnapshot, snapshotDocument, snapshotSelection } from './state.js';
import type {
  BlockSchema,
  Command,
  CommandContext,
  CommandOutput,
  CommandResult,
  ControlledPolicy,
  DocumentNormalizer,
  DocumentValidator,
  EditorEvent,
  EditorFacade,
  EditorMode,
  EditorOptions,
  EditorSelection,
  EditorSnapshot,
  EditorState,
  InsertParagraphArgs,
  PersistedSnapshot,
  PersistenceAdapter,
  PersistenceRole,
  Plugin,
  PluginAPI,
  Renderer,
  SetDocumentOptions,
  TransactionInput,
  TransactionResult
} from './types.js';

interface HistoryEntry {
  readonly transaction: TransactionRecord;
  readonly beforeDocument: DocumentState;
  readonly afterDocument: DocumentState;
  readonly beforeSelection: EditorSelection | null;
  readonly afterSelection: EditorSelection | null;
}

interface PendingControlledTransaction {
  readonly transaction: TransactionRecord;
  readonly beforeDocument: DocumentState;
  readonly beforeSelection: EditorSelection | null;
}

interface PipelineSuccess {
  readonly ok: true;
  readonly document: DocumentState;
  readonly transaction: TransactionRecord;
  readonly issues: ValidationIssue[];
}

interface PipelineFailure {
  readonly ok: false;
  readonly transaction: TransactionRecord;
  readonly issues: ValidationIssue[];
  readonly error: EditorError;
}

type PipelineResult = PipelineSuccess | PipelineFailure;

const defaultClock: Clock = { now: () => new Date().toISOString() };

export class Editor implements EditorFacade {
  readonly commands = new CommandRegistry();
  readonly schemas = new SchemaRegistry();
  readonly renderers = new RendererRegistry();
  readonly validators = new ValidationRegistry();

  private readonly emitter = new EditorEventEmitter();
  private readonly idFactory: IdFactory;
  private readonly clock: Clock;
  private readonly clientId: string;
  private readonly actorId: UserId | undefined;
  private readonly mode: EditorMode;
  private readonly controlledPolicy: ControlledPolicy;
  private readonly readOnlyOption: EditorOptions['readOnly'] | undefined;
  private readonly persistence: PersistenceAdapter | undefined;
  private readonly persistenceKey: string;
  private readonly persistenceRole: PersistenceRole;
  private readonly maxNormalizationPasses: number;
  private readonly pluginDisposers = new Map<string, Array<() => void>>();
  private readonly plugins: Plugin[] = [];
  private readonly historyUndo: HistoryEntry[] = [];
  private readonly historyRedo: HistoryEntry[] = [];
  private readonly pendingControlled = new Map<TransactionId, PendingControlledTransaction>();

  private current: EditorState;
  private surface: VanillaEditorSurface | null = null;
  private destroyed = false;
  private dispatchQueue: Promise<void> = Promise.resolve();

  constructor(options: EditorOptions = {}) {
    this.idFactory = options.idFactory ?? createIdFactory();
    this.clock = options.clock ?? defaultClock;
    this.clientId = options.clientId ?? 'plim-editor';
    this.actorId = options.actorId;
    this.mode = options.mode ?? 'uncontrolled';
    this.controlledPolicy = options.controlledPolicy ?? 'optimistic';
    this.readOnlyOption = options.readOnly;
    this.persistence = options.persistence;
    this.persistenceKey = options.persistenceKey ?? 'plim-editor';
    this.persistenceRole = options.persistenceRole ?? (this.mode === 'controlled' ? 'disabled' : 'primary');
    this.maxNormalizationPasses = options.maxNormalizationPasses ?? 10;
    this.emitter.setErrorReporter(options.errorReporter);

    const initialInput = options.snapshot ?? options.document ?? createEmptyDocument({ idFactory: this.idFactory, clock: this.clock });
    const initialDocument = this.prepareInitialDocument(snapshotDocument(initialInput));
    this.current = createEditorState({
      version: isEditorSnapshot(initialInput) ? initialInput.version : 0,
      document: initialDocument,
      selection: snapshotSelection(initialInput),
      status: { state: 'ready' },
      dirty: false,
      pendingTransactions: isEditorSnapshot(initialInput) ? initialInput.pendingTransactions : []
    });

    this.registerCoreSchemas();
    this.registerCoreCommands();
    for (const schema of options.schemas ?? []) this.schemas.register(schema);
    for (const renderer of options.renderers ?? []) this.renderers.register(renderer);
    for (const normalizer of options.normalizers ?? []) this.validators.registerNormalizer(normalizer);
    for (const validator of options.validators ?? []) this.validators.registerValidator(validator);
    for (const command of options.commands ?? []) this.commands.register(command);
    for (const plugin of options.plugins ?? []) this.installPlugin(plugin);

    if (options.loadDocument) {
      void this.refreshFromLoader(options.loadDocument);
    }
  }

  get state(): EditorState {
    return this.current;
  }

  get rootPageId(): PageId {
    const pageId = this.current.document.workspace.rootPageIds[0];
    if (!pageId) throw new EditorError('invalid_document', 'Document has no root page');
    return pageId;
  }

  getState(): EditorState {
    return this.current;
  }

  getSnapshot(): EditorSnapshot {
    return createSnapshot(this.current, this.now());
  }

  exportSnapshot(): EditorSnapshot {
    return this.getSnapshot();
  }

  importSnapshot(snapshot: EditorSnapshot, options: SetDocumentOptions = {}): TransactionResult {
    this.assertUsable();
    if (!isEditorSnapshot(snapshot)) {
      const error = new EditorError('invalid_snapshot', 'Snapshot must be a Plim editor snapshot');
      return { ok: false, committed: false, state: this.current, issues: [], error };
    }
    const baseOptions: SetDocumentOptions = {
      selection: options.selection !== undefined ? options.selection : snapshot.selection,
      markDirty: options.markDirty ?? snapshot.dirty
    };
    const setOptions = options.preserveSelection === undefined
      ? baseOptions
      : { ...baseOptions, preserveSelection: options.preserveSelection };
    return this.setDocument(snapshot.document, setOptions);
  }

  on<TType extends EditorEvent['type']>(type: TType, handler: (event: Extract<EditorEvent, { type: TType }>) => void): () => void {
    return this.emitter.on(type, handler);
  }

  registerCommand<TArgs = unknown>(command: Command<TArgs>): () => void {
    this.assertUsable();
    return this.commands.register(command);
  }

  registerRenderer<TBlock extends import('@plim/model').BlockRecord = import('@plim/model').BlockRecord>(renderer: Renderer<TBlock>): () => void {
    this.assertUsable();
    return this.renderers.register(renderer);
  }

  registerSchema<TBlock extends import('@plim/model').BlockRecord = import('@plim/model').BlockRecord>(schema: BlockSchema<TBlock>): () => void {
    this.assertUsable();
    return this.schemas.register(schema);
  }

  registerNormalizer(normalizer: DocumentNormalizer): () => void {
    this.assertUsable();
    return this.validators.registerNormalizer(normalizer);
  }

  registerValidator(validator: DocumentValidator): () => void {
    this.assertUsable();
    return this.validators.registerValidator(validator);
  }

  async dispatch(input: TransactionInput): Promise<TransactionResult> {
    const run = async (): Promise<TransactionResult> => this.dispatchNow(input);
    const resultPromise = this.dispatchQueue.then(run, run);
    this.dispatchQueue = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  async executeCommand<TArgs = unknown>(commandId: string, args: TArgs): Promise<CommandResult> {
    this.assertUsable();
    const command = this.commands.get<TArgs>(commandId);
    if (!command) {
      const error = new EditorError('command_not_found', `Command ${commandId} is not registered`);
      const result = { ok: false as const, commandId, error };
      this.emitError(error, true);
      return result;
    }

    const ctx: CommandContext<TArgs> = { editor: this, state: this.current, selection: this.current.selection, args };
    try {
      if (command.isEnabled && !command.isEnabled(ctx)) {
        const error = new EditorError('command_disabled', `Command ${commandId} is disabled`);
        this.emit({ type: 'command', timestamp: this.now(), commandId, phase: 'failed', error });
        this.emitError(error, true);
        return { ok: false, commandId, error };
      }
      this.emit({ type: 'command', timestamp: this.now(), commandId, phase: 'started' });
      const output = await command.run(ctx, args);
      const transaction = await this.resolveCommandOutput(output);
      const result: CommandResult = transaction ? { ok: true, commandId, transaction } : { ok: true, commandId };
      this.emit({ type: 'command', timestamp: this.now(), commandId, phase: 'completed', result });
      return result;
    } catch (cause) {
      const error = toEditorError('command_failed', `Command ${commandId} failed`, cause);
      this.emit({ type: 'command', timestamp: this.now(), commandId, phase: 'failed', error });
      this.emitError(error, true);
      return { ok: false, commandId, error };
    }
  }

  setSelection(selection: EditorSelection | null, cause = 'api'): void {
    this.assertUsable();
    const nextSelection = selection ? cloneDeep(selection) as EditorSelection : null;
    this.current = createEditorState({
      version: this.current.version + 1,
      document: this.current.document as DocumentState,
      selection: nextSelection,
      status: this.current.status,
      dirty: this.current.dirty,
      pendingTransactions: this.current.pendingTransactions
    });
    this.emit({ type: 'selectionChange', timestamp: this.now(), selection: nextSelection, cause });
    this.emit({ type: 'selection:changed', timestamp: this.now(), selection: nextSelection, cause });
  }

  focus(selection?: EditorSelection | null): void {
    this.assertUsable();
    if (selection !== undefined) this.setSelection(selection, 'focus');
    this.surface?.focus();
  }

  canUndo(): boolean {
    return this.historyUndo.length > 0;
  }

  canRedo(): boolean {
    return this.historyRedo.length > 0;
  }

  async undo(): Promise<TransactionResult> {
    this.assertUsable();
    const entry = this.historyUndo.pop();
    if (!entry) return this.noopHistoryResult('undo');
    this.historyRedo.push(entry);
    const transaction = this.createHistoryTransaction('undo', entry.transaction);
    const result = await this.restoreHistorySnapshot(entry.beforeDocument, entry.beforeSelection, transaction);
    this.emitHistoryChanged();
    return result;
  }

  async redo(): Promise<TransactionResult> {
    this.assertUsable();
    const entry = this.historyRedo.pop();
    if (!entry) return this.noopHistoryResult('redo');
    this.historyUndo.push(entry);
    const transaction = this.createHistoryTransaction('redo', entry.transaction);
    const result = await this.restoreHistorySnapshot(entry.afterDocument, entry.afterSelection, transaction);
    this.emitHistoryChanged();
    return result;
  }

  setDocument(document: DocumentState, options: SetDocumentOptions = {}): TransactionResult {
    this.assertUsable();
    const validation = validateDocumentState(document, { normalize: true });
    if (!validation.ok) {
      const error = new EditorError('invalid_document', 'Document failed validation', { issues: validation.issues });
      this.emitError(error, true);
      return { ok: false, committed: false, state: this.current, issues: validation.issues, error };
    }
    const selection = options.selection !== undefined
      ? options.selection
      : options.preserveSelection && this.selectionIsValid(this.current.selection, validation.normalized ?? document)
        ? this.current.selection
        : null;
    const transaction = createTransaction({
      workspaceId: (validation.normalized ?? document).workspace.id,
      clientId: this.clientId,
      idFactory: this.idFactory,
      clock: this.clock,
      operations: [],
      metadata: { source: 'api', label: 'setDocument', undoable: false }
    });
    this.commitState(validation.normalized ?? document, selection, options.markDirty ?? false, transaction, []);
    return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction, issues: validation.issues };
  }

  acceptTransaction(id: TransactionId, document: DocumentState): TransactionResult {
    this.assertUsable();
    const pending = this.pendingControlled.get(id);
    if (!pending) {
      const error = new EditorError('transaction_not_found', `Transaction ${String(id)} is not pending`);
      return { ok: false, committed: false, state: this.current, issues: [], error };
    }
    const validation = validateDocumentState(document, { normalize: true });
    if (!validation.ok) {
      const error = new EditorError('invalid_document', 'Accepted document failed validation', { issues: validation.issues });
      this.emitError(error, true);
      return { ok: false, committed: false, state: this.current, transaction: pending.transaction, issues: validation.issues, error };
    }
    this.pendingControlled.delete(id);
    this.commitState(validation.normalized ?? document, this.current.selection, false, pending.transaction, validation.issues, [...this.pendingControlled.values()].map(item => item.transaction));
    return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction: pending.transaction, issues: validation.issues };
  }

  rejectTransaction(id: TransactionId, reason = 'Transaction rejected by host'): TransactionResult {
    this.assertUsable();
    const pending = this.pendingControlled.get(id);
    if (!pending) {
      const error = new EditorError('transaction_not_found', `Transaction ${String(id)} is not pending`);
      return { ok: false, committed: false, state: this.current, issues: [], error };
    }
    this.pendingControlled.delete(id);
    if (this.mode === 'controlled' && this.controlledPolicy === 'optimistic') {
      this.commitState(pending.beforeDocument, pending.beforeSelection, true, { ...pending.transaction, status: 'rejected' }, [], [...this.pendingControlled.values()].map(item => item.transaction));
    } else {
      this.current = createEditorState({
        version: this.current.version + 1,
        document: this.current.document as DocumentState,
        selection: this.current.selection,
        status: this.current.status,
        dirty: this.current.dirty,
        pendingTransactions: [...this.pendingControlled.values()].map(item => item.transaction)
      });
    }
    const error = new EditorError('transaction_rejected', reason);
    this.emit({ type: 'transaction:rejected', timestamp: this.now(), transaction: pending.transaction, error });
    this.emit({ type: 'transaction', timestamp: this.now(), phase: 'rejected', transaction: pending.transaction, version: this.current.version, ...(pending.transaction.metadata?.source ? { source: pending.transaction.metadata.source } : {}) });
    return { ok: false, committed: false, state: this.current, transaction: pending.transaction, issues: [], error };
  }

  async mount(host: HTMLElement): Promise<void> {
    this.assertUsable();
    const HTMLElementCtor = globalThis.HTMLElement;
    if (typeof HTMLElementCtor !== 'function' || !(host instanceof HTMLElementCtor)) {
      throw new EditorError('invalid_host', 'mount() requires an HTMLElement host');
    }
    if (this.surface) throw new EditorError('already_mounted', 'Editor is already mounted');
    this.surface = new VanillaEditorSurface({
      editor: this,
      getState: () => this.current,
      rendererForBlock: block => this.renderers.forBlock(block.type),
      onRendererError: (rendererId, error, blockId) => {
        this.emit({ type: 'renderer:error', timestamp: this.now(), rendererId, ...(blockId ? { blockId } : {}), error });
        this.emitError(error, true);
      }
    });
    this.surface.mount(host);
    this.emit({ type: 'lifecycle', timestamp: this.now(), status: { state: 'ready' } });
  }

  async unmount(): Promise<void> {
    this.assertUsable();
    this.surface?.unmount();
    this.surface = null;
    this.emit({ type: 'lifecycle', timestamp: this.now(), status: { state: 'ready' } });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.surface) await this.unmount();
    if (this.persistence?.flush) {
      try {
        await this.persistence.flush();
      } catch (cause) {
        this.emitError(toEditorError('persistence_failed', 'Persistence flush failed', cause), true);
      }
    }
    for (const plugin of [...this.plugins].reverse()) {
      await this.runPluginHook(plugin, 'onStop');
      await this.runPluginHook(plugin, 'onUninstall');
      for (const dispose of this.pluginDisposers.get(plugin.id) ?? []) dispose();
    }
    this.pluginDisposers.clear();
    this.plugins.length = 0;
    this.destroyed = true;
    this.current = createEditorState({
      version: this.current.version + 1,
      document: this.current.document as DocumentState,
      selection: this.current.selection,
      status: { state: 'destroyed' },
      dirty: this.current.dirty,
      pendingTransactions: this.current.pendingTransactions
    });
    this.emit({ type: 'lifecycle', timestamp: this.now(), status: { state: 'destroyed' } });
    this.emitter.clear();
  }

  private async dispatchNow(input: TransactionInput): Promise<TransactionResult> {
    this.assertUsable();
    if (this.isReadOnly()) {
      const error = new EditorError('read_only', 'Editor is read-only');
      this.emitError(error, true);
      return { ok: false, committed: false, state: this.current, issues: [], error };
    }
    const beforeDocument = cloneDeep(this.current.document) as DocumentState;
    const beforeSelection = cloneDeep(this.current.selection) as EditorSelection | null;
    const { transaction, afterSelection } = this.toTransaction(input);

    if (this.mode === 'controlled' && this.controlledPolicy === 'strict') {
      this.pendingControlled.set(transaction.id, { transaction, beforeDocument, beforeSelection });
      this.current = createEditorState({
        version: this.current.version + 1,
        document: this.current.document as DocumentState,
        selection: this.current.selection,
        status: this.current.status,
        dirty: this.current.dirty,
        pendingTransactions: [...this.pendingControlled.values()].map(item => item.transaction)
      });
      this.emit({ type: 'transaction', timestamp: this.now(), phase: 'proposed', transaction, version: this.current.version, ...(transaction.metadata?.source ? { source: transaction.metadata.source } : {}) });
      return { ok: true, committed: false, state: this.current, snapshot: this.getSnapshot(), transaction, issues: [] };
    }

    const pipeline = this.applyPipeline(beforeDocument, transaction);
    if (!pipeline.ok) {
      this.emit({ type: 'transaction:rejected', timestamp: this.now(), transaction: pipeline.transaction, error: pipeline.error });
      this.emit({ type: 'transaction', timestamp: this.now(), phase: 'rejected', transaction: pipeline.transaction, version: this.current.version, ...(pipeline.transaction.metadata?.source ? { source: pipeline.transaction.metadata.source } : {}) });
      this.emitError(pipeline.error, true);
      return { ok: false, committed: false, state: this.current, transaction: pipeline.transaction, issues: pipeline.issues, error: pipeline.error };
    }

    const finalSelection = afterSelection !== undefined ? afterSelection : this.current.selection;
    if (this.mode === 'controlled' && this.controlledPolicy === 'optimistic') {
      this.pendingControlled.set(pipeline.transaction.id, { transaction: pipeline.transaction, beforeDocument, beforeSelection });
    }
    this.commitState(pipeline.document, finalSelection, true, pipeline.transaction, pipeline.issues, [...this.pendingControlled.values()].map(item => item.transaction));

    if (this.shouldRecordHistory(pipeline.transaction)) {
      this.historyUndo.push({
        transaction: pipeline.transaction,
        beforeDocument,
        afterDocument: cloneDeep(pipeline.document) as DocumentState,
        beforeSelection,
        afterSelection: finalSelection
      });
      this.historyRedo.length = 0;
      this.emitHistoryChanged();
    }

    const persistenceError = await this.persistAfterCommit(pipeline.transaction);
    if (persistenceError) {
      return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction: pipeline.transaction, issues: pipeline.issues, persistenceError };
    }
    return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction: pipeline.transaction, issues: pipeline.issues };
  }

  private applyPipeline(baseDocument: DocumentState, initialTransaction: TransactionRecord): PipelineResult {
    try {
      this.emit({ type: 'transaction:beforeApply', timestamp: this.now(), transaction: initialTransaction });
      this.emit({ type: 'transaction', timestamp: this.now(), phase: 'before', transaction: initialTransaction, version: this.current.version, ...(initialTransaction.metadata?.source ? { source: initialTransaction.metadata.source } : {}) });
      const first = applyModelTransaction(baseDocument, initialTransaction, { clock: this.clock, ...(this.actorId ? { actorId: this.actorId } : {}), recordTransaction: false });
      if (!first.ok) {
        return { ok: false, transaction: first.transaction, issues: first.issues, error: new EditorError('validation_failed', first.error.message, { cause: first.error, issues: first.issues }) };
      }
      let document = first.state;
      const appendedOperations: Operation[] = [];
      for (let pass = 0; pass < this.maxNormalizationPasses; pass += 1) {
        const operations = this.collectNormalizerOperations(document);
        if (operations.length === 0) {
          const validation = this.validateFinalDocument(document);
          if (!validation.ok) {
            return { ok: false, transaction: initialTransaction, issues: validation.issues, error: new EditorError('validation_failed', 'Transaction failed editor validation', { issues: validation.issues }) };
          }
          const transaction: TransactionRecord = {
            ...initialTransaction,
            operations: [...initialTransaction.operations, ...appendedOperations],
            status: 'applied'
          };
          const nextTransactions = [...(document.transactions ?? []), transaction];
          return { ok: true, document: { ...document, transactions: nextTransactions }, transaction, issues: validation.issues };
        }
        appendedOperations.push(...operations);
        const normalizerTransaction = createTransaction({
          workspaceId: document.workspace.id,
          clientId: this.clientId,
          idFactory: this.idFactory,
          clock: this.clock,
          operations,
          metadata: { source: 'plugin', label: 'normalization', undoable: false }
        });
        const normalized = applyModelTransaction(document, normalizerTransaction, { clock: this.clock, ...(this.actorId ? { actorId: this.actorId } : {}), recordTransaction: false });
        if (!normalized.ok) {
          return { ok: false, transaction: initialTransaction, issues: normalized.issues, error: new EditorError('normalization_failed', normalized.error.message, { cause: normalized.error, issues: normalized.issues }) };
        }
        document = normalized.state;
      }
      return { ok: false, transaction: initialTransaction, issues: [], error: new EditorError('normalization_loop', 'Normalization did not converge', { details: { maxPasses: this.maxNormalizationPasses } }) };
    } catch (cause) {
      const error = toEditorError('transaction_rejected', 'Transaction pipeline failed', cause);
      return { ok: false, transaction: initialTransaction, issues: error.issues as ValidationIssue[], error };
    }
  }

  private collectNormalizerOperations(document: DocumentState): Operation[] {
    const operations: Operation[] = [];
    const normalizers = [...this.schemas.normalizers(), ...this.validators.listNormalizers()];
    for (const normalizer of normalizers) {
      try {
        operations.push(...normalizer(document));
      } catch (cause) {
        throw toEditorError('normalization_failed', 'Document normalizer failed', cause);
      }
    }
    return operations;
  }

  private validateFinalDocument(document: DocumentState): { ok: boolean; issues: ValidationIssue[] } {
    const modelValidation = validateDocumentState(document);
    const issues = [...modelValidation.issues, ...this.schemas.validate(document)];
    for (const validator of this.validators.listValidators()) {
      try {
        issues.push(...validator(document));
      } catch (cause) {
        throw toEditorError('validation_failed', 'Document validator failed', cause);
      }
    }
    return { ok: modelValidation.ok && !issues.some(issue => issue.severity === 'error'), issues };
  }

  private commitState(document: DocumentState, selection: EditorSelection | null, dirty: boolean, transaction: TransactionRecord | null, issues: readonly ValidationIssue[], pendingTransactions?: readonly TransactionRecord[]): void {
    this.current = createEditorState({
      version: this.current.version + 1,
      document,
      selection: selection ? cloneDeep(selection) as EditorSelection : null,
      status: this.current.status,
      dirty,
      pendingTransactions: pendingTransactions ?? this.current.pendingTransactions
    });
    if (transaction) {
      this.emit({ type: 'transaction:committed', timestamp: this.now(), transaction, snapshot: this.getSnapshot() });
      this.emit({ type: 'transaction', timestamp: this.now(), phase: 'after', transaction, version: this.current.version, ...(transaction.metadata?.source ? { source: transaction.metadata.source } : {}) });
    }
    this.emit({ type: 'change', timestamp: this.now(), transaction, snapshot: this.getSnapshot(), dirty: this.current.dirty });
    if (selection) {
      this.emit({ type: 'selectionChange', timestamp: this.now(), selection, cause: 'transaction' });
      this.emit({ type: 'selection:changed', timestamp: this.now(), selection, cause: 'transaction' });
    }
    this.surface?.render();
    void issues;
  }

  private async persistAfterCommit(transaction: TransactionRecord): Promise<EditorError | undefined> {
    if (!this.shouldPersist()) return undefined;
    const adapter = this.persistence;
    if (!adapter) return undefined;
    this.emit({ type: 'effect:scheduled', timestamp: this.now(), effect: 'persistence', transactionId: transaction.id });
    this.emit({ type: 'persistence', timestamp: this.now(), adapterId: adapter.id, status: 'saving' });
    try {
      const snapshot = { ...this.getSnapshot(), persistenceKey: this.persistenceKey } as PersistedSnapshot;
      await adapter.save(this.persistenceKey, snapshot);
      this.current = createEditorState({
        version: this.current.version,
        document: this.current.document as DocumentState,
        selection: this.current.selection,
        status: this.current.status,
        dirty: false,
        pendingTransactions: this.current.pendingTransactions
      });
      this.emit({ type: 'persistence', timestamp: this.now(), adapterId: adapter.id, status: 'saved' });
      return undefined;
    } catch (cause) {
      const error = toEditorError('persistence_failed', 'Persistence save failed', cause);
      this.emit({ type: 'persistence', timestamp: this.now(), adapterId: adapter.id, status: 'failed', error });
      this.emit({ type: 'effect:failed', timestamp: this.now(), effect: 'persistence', transactionId: transaction.id, error });
      this.emitError(error, true);
      return error;
    }
  }

  private shouldPersist(): boolean {
    if (!this.persistence || this.persistenceRole === 'disabled') return false;
    if (this.mode === 'uncontrolled') return true;
    return this.persistenceRole === 'cache' || this.persistenceRole === 'drafts';
  }

  private toTransaction(input: TransactionInput): { transaction: TransactionRecord; afterSelection?: EditorSelection | null } {
    if (isOperationArray(input)) {
      return { transaction: this.createTransactionRecord(input, { source: 'api', undoable: true }) };
    }
    if (isTransactionRecord(input)) {
      return { transaction: { ...input, operations: [...input.operations] } };
    }
    const draft = input;
    const metadata: TransactionMetadata = { ...(draft.metadata ?? {}) };
    metadata.source = draft.source ?? metadata.source ?? 'api';
    if (draft.label !== undefined) metadata.label = draft.label;
    if (draft.undoable !== undefined) metadata.undoable = draft.undoable;
    if (draft.historyGroup !== undefined) metadata.historyGroup = draft.historyGroup;
    const transaction = this.createTransactionRecord(draft.operations, metadata, draft.id);
    return draft.afterSelection === undefined ? { transaction } : { transaction, afterSelection: draft.afterSelection };
  }

  private createTransactionRecord(operations: readonly Operation[], metadata: TransactionMetadata, id?: TransactionId): TransactionRecord {
    const base = {
      workspaceId: this.current.document.workspace.id as WorkspaceId,
      clientId: this.clientId,
      operations: [...operations],
      idFactory: this.idFactory,
      clock: this.clock,
      ...(this.actorId !== undefined ? { actorId: this.actorId } : {}),
      metadata
    };
    return id === undefined ? createTransaction(base) : createTransaction({ ...base, id });
  }

  private async resolveCommandOutput(output: CommandOutput): Promise<TransactionResult | undefined> {
    if (!output) return undefined;
    if (isTransactionResult(output)) return output;
    return this.dispatch(Array.isArray(output) ? output : output);
  }

  private isReadOnly(): boolean {
    if (typeof this.readOnlyOption === 'function') return this.readOnlyOption(this.current);
    return this.readOnlyOption ?? false;
  }

  private shouldRecordHistory(transaction: TransactionRecord): boolean {
    return transaction.metadata?.undoable !== false && transaction.metadata?.source !== 'history' && transaction.operations.length > 0;
  }

  private createHistoryTransaction(action: 'undo' | 'redo', original: TransactionRecord): TransactionRecord {
    return createTransaction({
      workspaceId: this.current.document.workspace.id as WorkspaceId,
      clientId: this.clientId,
      idFactory: this.idFactory,
      clock: this.clock,
      operations: [],
      metadata: { source: 'history', label: action, undoable: false, extensions: { originalTransactionId: String(original.id) } }
    });
  }

  private async restoreHistorySnapshot(document: DocumentState, selection: EditorSelection | null, transaction: TransactionRecord): Promise<TransactionResult> {
    this.commitState(cloneDeep(document) as DocumentState, selection, true, transaction, []);
    const persistenceError = await this.persistAfterCommit(transaction);
    if (persistenceError) {
      return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction, issues: [], persistenceError };
    }
    return { ok: true, committed: true, state: this.current, snapshot: this.getSnapshot(), transaction, issues: [] };
  }

  private noopHistoryResult(label: 'undo' | 'redo'): TransactionResult {
    const transaction = this.createHistoryTransaction(label, createTransaction({
      workspaceId: this.current.document.workspace.id as WorkspaceId,
      clientId: this.clientId,
      idFactory: this.idFactory,
      clock: this.clock,
      operations: [],
      metadata: { source: 'history', label, undoable: false }
    }));
    return { ok: true, committed: false, state: this.current, snapshot: this.getSnapshot(), transaction, issues: [] };
  }

  private emitHistoryChanged(): void {
    this.emit({ type: 'history:changed', timestamp: this.now(), canUndo: this.canUndo(), canRedo: this.canRedo() });
  }

  private prepareInitialDocument(document: DocumentState): DocumentState {
    const validation = validateDocumentState(document, { normalize: true });
    if (!validation.ok) {
      throw new EditorError('invalid_document', 'Initial document failed validation', { issues: validation.issues });
    }
    return validation.normalized ?? document;
  }

  private async refreshFromLoader(loadDocument: () => Promise<DocumentState | EditorSnapshot>): Promise<void> {
    try {
      const loaded = await loadDocument();
      const document = snapshotDocument(loaded);
      const selection = snapshotSelection(loaded);
      const validation = validateDocumentState(document, { normalize: true });
      if (!validation.ok) {
        const error = new EditorError('invalid_document', 'Loaded document failed validation', { issues: validation.issues });
        this.current = createEditorState({
          version: this.current.version + 1,
          document: this.current.document as DocumentState,
          selection: this.current.selection,
          status: { state: 'degraded', reason: error.code, recoverable: true },
          dirty: this.current.dirty,
          pendingTransactions: this.current.pendingTransactions
        });
        this.emitError(error, true);
        return;
      }
      this.commitState(validation.normalized ?? document, selection, false, null, validation.issues);
    } catch (cause) {
      const error = toEditorError('adapter_failed', 'Document loader failed', cause);
      this.current = createEditorState({
        version: this.current.version + 1,
        document: this.current.document as DocumentState,
        selection: this.current.selection,
        status: { state: 'degraded', reason: error.code, recoverable: true },
        dirty: this.current.dirty,
        pendingTransactions: this.current.pendingTransactions
      });
      this.emitError(error, true);
    }
  }

  private installPlugin(plugin: Plugin): void {
    if (!plugin.id.trim()) throw new EditorError('plugin_failed', 'Plugin id is required');
    if (this.pluginDisposers.has(plugin.id)) throw new EditorError('plugin_failed', `Plugin ${plugin.id} is already installed`);
    const disposers: Array<() => void> = [];
    this.pluginDisposers.set(plugin.id, disposers);
    this.plugins.push(plugin);
    const api = this.createPluginApi(disposers);
    try {
      for (const schema of plugin.schemas ?? []) disposers.push(this.schemas.register(schema));
      for (const renderer of plugin.renderers ?? []) disposers.push(this.renderers.register(renderer));
      for (const normalizer of plugin.normalizers ?? []) disposers.push(this.validators.registerNormalizer(normalizer));
      for (const validator of plugin.validators ?? []) disposers.push(this.validators.registerValidator(validator));
      for (const command of plugin.commands ?? []) disposers.push(this.commands.register(command));
      void this.runPluginHook(plugin, 'onInstall', api);
      void this.runPluginHook(plugin, 'onStart', api);
    } catch (cause) {
      const error = toEditorError('plugin_failed', `Plugin ${plugin.id} failed to install`, cause);
      this.emit({ type: 'plugin:error', timestamp: this.now(), pluginId: plugin.id, error });
      this.emitError(error, true);
      throw error;
    }
  }

  private createPluginApi(disposers: Array<() => void>): PluginAPI {
    return {
      editor: this,
      registerCommand: command => {
        const dispose = this.commands.register(command);
        disposers.push(dispose);
        return dispose;
      },
      registerRenderer: renderer => {
        const dispose = this.renderers.register(renderer);
        disposers.push(dispose);
        return dispose;
      },
      registerSchema: schema => {
        const dispose = this.schemas.register(schema);
        disposers.push(dispose);
        return dispose;
      },
      registerNormalizer: normalizer => {
        const dispose = this.validators.registerNormalizer(normalizer);
        disposers.push(dispose);
        return dispose;
      },
      registerValidator: validator => {
        const dispose = this.validators.registerValidator(validator);
        disposers.push(dispose);
        return dispose;
      },
      on: (type, handler) => {
        const dispose = this.on(type, handler);
        disposers.push(dispose);
        return dispose;
      }
    };
  }

  private async runPluginHook(plugin: Plugin, hook: 'onInstall' | 'onStart' | 'onStop' | 'onUninstall', api?: PluginAPI): Promise<void> {
    const fn = plugin[hook];
    if (!fn) return;
    try {
      await fn(api ?? this.createPluginApi(this.pluginDisposers.get(plugin.id) ?? []));
    } catch (cause) {
      const error = toEditorError('plugin_failed', `Plugin ${plugin.id} ${hook} failed`, cause);
      this.emit({ type: 'plugin:error', timestamp: this.now(), pluginId: plugin.id, error });
      this.emitError(error, true);
    }
  }

  private registerCoreSchemas(): void {
    const richTextTypes = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code']);
    for (const type of ['page', 'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'divider', 'callout', 'code', 'equation', 'table_of_contents', 'breadcrumb', 'unsupported'] as const) {
      this.schemas.register({
        type,
        supportsChildren: type === 'page' || type === 'toggle' || type === 'callout',
        allowedChildTypes: 'any',
        validate(block) {
          if (richTextTypes.has(block.type)) {
            const richText = (block.data as Record<string, unknown>).richText;
            if (!Array.isArray(richText)) {
              return [{ severity: 'error', code: 'invalid_rich_text', message: `${block.type} richText must be an array`, path: `blocks.${String(block.id)}.data.richText`, record: { kind: 'block', id: block.id }, fix: 'manual' }];
            }
          }
          return [];
        }
      });
    }
  }

  private registerCoreCommands(): void {
    this.commands.register({
      id: 'history.undo',
      title: 'Undo',
      category: 'history',
      aliases: ['undo'],
      isEnabled: () => this.canUndo(),
      run: () => this.undo()
    });
    this.commands.register({
      id: 'history.redo',
      title: 'Redo',
      category: 'history',
      aliases: ['redo'],
      isEnabled: () => this.canRedo(),
      run: () => this.redo()
    });
    this.commands.register<InsertParagraphArgs>({
      id: 'block.insertParagraph',
      title: 'Insert paragraph',
      category: 'basic',
      aliases: ['paragraph', 'text'],
      run: (ctx, args) => {
        const parentId = args.parentId ?? ctx.editor.rootPageId;
        const block = createParagraphBlock({
          workspaceId: ctx.state.document.workspace.id as WorkspaceId,
          parent: parentRefFor(ctx.state.document, parentId),
          text: args.text ?? '',
          idFactory: this.idFactory,
          clock: this.clock,
          ...(this.actorId ? { actorId: this.actorId } : {})
        });
        return {
          source: 'command',
          label: 'insert paragraph',
          undoable: true,
          operations: [
            { op: 'create_block', block },
            { op: 'insert_child', parentId, childId: block.id, at: args.at ?? { kind: 'append' } }
          ]
        };
      }
    });
  }

  private selectionIsValid(selection: EditorSelection | null, document: DocumentState): boolean {
    if (!selection) return false;
    if (selection.mode === 'none') return true;
    if (selection.mode === 'text') return Boolean(document.blocks[selection.anchor.blockId] && document.blocks[selection.focus.blockId]);
    if (selection.mode === 'blocks') return selection.selectedBlockIds.every(blockId => Boolean(document.blocks[blockId]));
    return true;
  }

  private emit<TEvent extends EditorEvent>(event: TEvent): void {
    this.emitter.emit(event);
  }

  private emitError(error: EditorError, recoverable: boolean): void {
    this.emitter.emit({ type: 'error', timestamp: this.now(), error, recoverable });
  }

  private assertUsable(): void {
    if (this.destroyed || this.current.status.state === 'destroyed') throw new EditorDestroyedError();
  }

  private now(): string {
    return this.clock.now();
  }
}

export function createEditor(options: EditorOptions = {}): Editor {
  return new Editor(options);
}

function parentRefFor(document: DocumentState, parentId: BlockId | PageId): ParentRef {
  if (document.pages[parentId as PageId]) return { kind: 'page', pageId: parentId as PageId };
  if (document.blocks[parentId as BlockId]) return { kind: 'block', blockId: parentId as BlockId };
  return { kind: 'workspace', workspaceId: document.workspace.id as WorkspaceId };
}

function isTransactionRecord(value: unknown): value is TransactionRecord {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { operations?: unknown }).operations)
    && typeof (value as { clientId?: unknown }).clientId === 'string'
    && typeof (value as { createdAt?: unknown }).createdAt === 'string'
    && typeof (value as { status?: unknown }).status === 'string';
}

function isOperationArray(value: TransactionInput): value is readonly Operation[] {
  return Array.isArray(value);
}

function isTransactionResult(value: unknown): value is TransactionResult {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
    && 'committed' in value;
}
