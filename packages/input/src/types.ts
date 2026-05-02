import type {
  BlockId,
  BlockRecord,
  BlockType,
  DocumentState,
  JsonObject,
  NotionColor,
  Operation,
  PageId,
  ParentRef,
  RichText,
  TextAnnotations,
  TransactionRecord,
  WorkspaceId
} from '@plim/model';

export type {
  BlockId,
  BlockRecord,
  BlockType,
  DocumentState,
  JsonObject,
  NotionColor,
  Operation,
  PageId,
  ParentRef,
  RichText,
  TextAnnotations,
  TransactionRecord,
  WorkspaceId
} from '@plim/model';

export type Platform = 'mac' | 'windows' | 'linux';
export type SelectionKind = 'text' | 'block' | 'cell' | 'databaseRows' | 'gap';
export type CommandId = string;

export type CommandSurface =
  | 'keyboard'
  | 'slash'
  | 'plus-menu'
  | 'block-handle'
  | 'selected-block-menu'
  | 'command-palette'
  | 'mention-menu'
  | 'paste-menu'
  | 'mobile-toolbar'
  | 'api-test';

export type CommandCategory =
  | 'basic'
  | 'inline'
  | 'media'
  | 'database'
  | 'embed'
  | 'advanced'
  | 'transform'
  | 'color'
  | 'comment'
  | 'navigation';

export type DisabledReasonCode =
  | 'read_only'
  | 'invalid_selection'
  | 'invalid_parent'
  | 'unsupported_block'
  | 'requires_text_selection'
  | 'requires_block_selection'
  | 'requires_provider'
  | 'offline_unavailable'
  | 'browser_reserved'
  | 'nested_editor_owns_event'
  | 'feature_disabled';

export interface DisabledReason {
  code: DisabledReasonCode;
  message: string;
}

export interface TextPoint {
  blockId: BlockId;
  offsetUtf16: number;
  field?: string;
}

export interface CellPoint {
  tableId: BlockId;
  rowIndex: number;
  columnIndex: number;
}

export interface BlockPosition {
  parentId: BlockId | PageId;
  index: number;
}

export type EditorSelection =
  | { kind: 'text'; anchor: TextPoint; focus: TextPoint }
  | { kind: 'block'; blockIds: readonly BlockId[]; anchorId: BlockId; focusId: BlockId }
  | { kind: 'cell'; tableId: BlockId; anchor: CellPoint; focus: CellPoint }
  | { kind: 'databaseRows'; viewId: string; rowIds: readonly PageId[] }
  | { kind: 'gap'; position: BlockPosition };

export interface EditorCommandContext {
  selection: EditorSelection;
  platform?: Platform;
  document?: DocumentState;
  readOnly?: boolean;
  composing?: boolean;
  nestedEditorOwnsEvent?: boolean;
  currentBlockIds?: () => readonly BlockId[];
  currentBlock?: () => BlockRecord | undefined;
  blockSupportsChildren?: (type: BlockType) => boolean;
  capabilities?: Readonly<Record<string, boolean>>;
  recentCommandIds?: readonly CommandId[];
  commandUsage?: Readonly<Record<CommandId, number>>;
}

export type CommandPredicate<Context extends EditorCommandContext = EditorCommandContext> = (ctx: Context) => true | DisabledReason;

export interface KeyChord {
  key: string;
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export interface KeyboardBinding {
  chord: string;
  when: readonly SelectionKind[];
  platform?: Platform | 'all';
  preventDefault?: 'always' | 'when-enabled' | 'never';
  priority?: number;
}

export interface SlashBinding {
  trigger: '/';
  aliases: readonly string[];
  placement: 'insert-block' | 'inline' | 'action' | 'transform';
  consumesQuery?: boolean;
}

export interface MarkdownInputRule<Context extends EditorCommandContext = EditorCommandContext> {
  id: string;
  trigger: 'space' | 'enter' | 'character';
  scope: 'line-start' | 'inline' | 'block-end';
  pattern: RegExp;
  contexts?: readonly BlockType[];
  excludeContexts?: readonly BlockType[];
  commandId: CommandId;
  getArgs(match: RegExpMatchArray, ctx: Context): unknown;
}

export interface CommandPreview {
  label?: string;
  operations?: readonly Operation[];
  description?: string;
}

export interface CommandInvocation {
  commandId: CommandId;
  args?: unknown;
  source?: CommandSurface | 'markdown' | 'autocomplete';
}

export type CommandExecutionPayload =
  | { kind: 'operations'; operations: readonly Operation[]; label?: string; selectionAfter?: EditorSelection }
  | { kind: 'transaction'; transaction: TransactionRecord }
  | { kind: 'command'; invocation: CommandInvocation }
  | { kind: 'ui'; effect: string; payload?: unknown };

export type CommandExecute<Args = unknown, Context extends EditorCommandContext = EditorCommandContext> = (
  ctx: Context,
  args: Args
) => CommandExecutionPayload | Promise<CommandExecutionPayload>;

export interface CommandDefinition<Args = unknown, Context extends EditorCommandContext = EditorCommandContext> {
  id: CommandId;
  title: string;
  description?: string;
  category: CommandCategory;
  icon?: string;
  group?: string;
  surfaces: readonly CommandSurface[];
  search: {
    aliases: readonly string[];
    keywords?: readonly string[];
    boost?: number;
  };
  predicates: readonly CommandPredicate<Context>[];
  keyboard?: readonly KeyboardBinding[];
  slash?: readonly SlashBinding[];
  markdown?: readonly MarkdownInputRule<Context>[];
  priority?: number;
  preview?: (ctx: Context, args: Args) => CommandPreview | null;
  execute: CommandExecute<Args, Context>;
}

export type CommandExecutionResult =
  | { status: 'ok'; commandId: CommandId; payload: CommandExecutionPayload }
  | { status: 'disabled'; commandId: CommandId; reason: DisabledReason }
  | { status: 'missing'; commandId: CommandId }
  | { status: 'error'; commandId: CommandId; message: string; error: unknown };

export interface CommandMenuItem {
  key: string;
  commandId: CommandId;
  title: string;
  subtitle?: string;
  icon?: string;
  group: CommandCategory | string;
  aliases: readonly string[];
  disabled?: DisabledReason;
  score: number;
  preview?: CommandPreview;
  asyncState?: 'idle' | 'loading' | 'loaded' | 'error';
}

export interface AsyncCommandProviderRequest {
  query?: string;
  surface?: CommandSurface;
  signal?: AbortSignal;
}

export interface AsyncCommandProvider<Context extends EditorCommandContext = EditorCommandContext> {
  id: string;
  getCommands(ctx: Context, request: AsyncCommandProviderRequest): Promise<readonly CommandDefinition<unknown, Context>[]>;
}

export interface BlockFragment {
  type: BlockType;
  text?: string;
  richText?: RichText;
  data?: JsonObject;
  children?: readonly BlockFragment[];
  source?: 'plain-text' | 'markdown' | 'html' | 'url' | 'file' | 'internal';
}

export interface ModelOperationPlan {
  operations: readonly Operation[];
  rootBlockIds: readonly BlockId[];
}

export type ColorName = Extract<NotionColor,
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
>;
