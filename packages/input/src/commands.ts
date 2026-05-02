import type {
  AsyncCommandProvider,
  CommandDefinition,
  CommandExecutionResult,
  CommandId,
  CommandMenuItem,
  CommandPredicate,
  CommandSurface,
  DisabledReason,
  EditorCommandContext,
  KeyboardBinding,
  SlashBinding
} from './types.js';
import { resolveKeyboardMatches, type KeyboardEventLike, eventToChord, detectPlatform } from './shortcuts.js';
import { foldForSearch, fuzzyScore, wordBoundaryScore } from './text-utils.js';

export interface CommandRegistryOptions<Context extends EditorCommandContext = EditorCommandContext> {
  commands?: readonly CommandDefinition<unknown, Context>[];
  providers?: readonly AsyncCommandProvider<Context>[];
  duplicatePolicy?: 'replace' | 'error';
}

export interface CommandProviderSession<Context extends EditorCommandContext = EditorCommandContext> {
  id: number;
  signal: AbortSignal;
  abort(): void;
  load(ctx: Context, request?: Omit<Parameters<AsyncCommandProvider<Context>['getCommands']>[1], 'signal'>): Promise<readonly CommandDefinition<unknown, Context>[]>;
}

export class CommandRegistry<Context extends EditorCommandContext = EditorCommandContext> {
  readonly #commands = new Map<CommandId, CommandDefinition<unknown, Context>>();
  readonly #providers = new Map<string, AsyncCommandProvider<Context>>();
  readonly #duplicatePolicy: 'replace' | 'error';
  #providerSessionId = 0;

  constructor(options: CommandRegistryOptions<Context> = {}) {
    this.#duplicatePolicy = options.duplicatePolicy ?? 'replace';
    for (const command of options.commands ?? []) this.register(command);
    for (const provider of options.providers ?? []) this.registerProvider(provider);
  }

  register(command: CommandDefinition<unknown, Context>): this {
    if (this.#commands.has(command.id) && this.#duplicatePolicy === 'error') {
      throw new Error(`Command ${command.id} is already registered`);
    }
    this.#commands.set(command.id, command);
    return this;
  }

  registerMany(commands: readonly CommandDefinition<unknown, Context>[]): this {
    for (const command of commands) this.register(command);
    return this;
  }

  unregister(id: CommandId): boolean {
    return this.#commands.delete(id);
  }

  registerProvider(provider: AsyncCommandProvider<Context>): this {
    this.#providers.set(provider.id, provider);
    return this;
  }

  unregisterProvider(id: string): boolean {
    return this.#providers.delete(id);
  }

  get<Args = unknown>(id: CommandId): CommandDefinition<Args, Context> | undefined {
    const command = this.#commands.get(id);
    return command as CommandDefinition<Args, Context> | undefined;
  }

  require<Args = unknown>(id: CommandId): CommandDefinition<Args, Context> {
    const command = this.get<Args>(id);
    if (!command) throw new Error(`Command ${id} is not registered`);
    return command;
  }

  list(): readonly CommandDefinition<unknown, Context>[] {
    return [...this.#commands.values()];
  }

  commandsForSurface(surface: CommandSurface): readonly CommandDefinition<unknown, Context>[] {
    return this.list().filter(command => command.surfaces.includes(surface));
  }

  disabledReason(command: CommandDefinition<unknown, Context>, ctx: Context): DisabledReason | null {
    for (const predicate of command.predicates) {
      const result = predicate(ctx);
      if (result !== true) return result;
    }
    return null;
  }

  async executeCommand<Args = unknown>(id: CommandId, ctx: Context, args: Args): Promise<CommandExecutionResult> {
    const command = this.get<Args>(id);
    if (!command) return { status: 'missing', commandId: id };
    const disabled = this.disabledReason(command as CommandDefinition<unknown, Context>, ctx);
    if (disabled) return { status: 'disabled', commandId: id, reason: disabled };
    try {
      const payload = await command.execute(ctx, args);
      return { status: 'ok', commandId: id, payload };
    } catch (error) {
      return {
        status: 'error',
        commandId: id,
        message: error instanceof Error ? error.message : 'Command failed',
        error
      };
    }
  }

  findKeyboardMatches(eventOrChord: KeyboardEventLike | { key: string }, ctx: Context) {
    const platform = ctx.platform ?? detectPlatform();
    const chord = 'ctrlKey' in eventOrChord || 'metaKey' in eventOrChord || 'altKey' in eventOrChord || 'shiftKey' in eventOrChord
      ? eventToChord(eventOrChord as KeyboardEventLike, platform)
      : eventOrChord;
    return resolveKeyboardMatches(this.list(), chord, ctx, platform);
  }

  findSlashAlias(alias: string, ctx?: Context): readonly CommandDefinition<unknown, Context>[] {
    const query = foldForSearch(alias.replace(/^\//u, ''));
    const commands = this.commandsForSurface('slash').filter(command => {
      if (ctx && this.disabledReason(command, ctx)?.code === 'feature_disabled') return false;
      return (command.slash ?? []).some(binding => binding.aliases.some(candidate => foldForSearch(candidate) === query));
    });
    return commands.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.title.localeCompare(b.title));
  }

  createProviderSession(): CommandProviderSession<Context> {
    this.#providerSessionId += 1;
    const id = this.#providerSessionId;
    const controller = new AbortController();
    return {
      id,
      signal: controller.signal,
      abort: () => controller.abort(),
      load: async (ctx, request = {}) => {
        const loaded: CommandDefinition<unknown, Context>[] = [];
        const responses = await Promise.allSettled([...this.#providers.values()].map(provider => provider.getCommands(ctx, { ...request, signal: controller.signal })));
        if (controller.signal.aborted || id !== this.#providerSessionId) return [];
        for (const response of responses) {
          if (response.status === 'fulfilled') loaded.push(...response.value);
        }
        return loaded;
      }
    };
  }
}

export const canEdit: CommandPredicate = (ctx) => ctx.readOnly
  ? { code: 'read_only', message: 'You do not have edit access.' }
  : true;

export const notComposing: CommandPredicate = (ctx) => ctx.composing
  ? { code: 'nested_editor_owns_event', message: 'Text composition is active.' }
  : true;

export const textSelectionOnly: CommandPredicate = (ctx) => ctx.selection.kind === 'text'
  ? true
  : { code: 'requires_text_selection', message: 'Place the caret in text first.' };

export const blockSelectionOnly: CommandPredicate = (ctx) => ctx.selection.kind === 'block'
  ? true
  : { code: 'requires_block_selection', message: 'Select one or more blocks first.' };

export const nestedEditorDoesNotOwnEvent: CommandPredicate = (ctx) => ctx.nestedEditorOwnsEvent
  ? { code: 'nested_editor_owns_event', message: 'A nested editor owns this input.' }
  : true;

export function requiresCapability(capability: string, message = 'This feature is disabled.'): CommandPredicate {
  return (ctx) => ctx.capabilities?.[capability] === false ? { code: 'feature_disabled', message } : true;
}

export function makeCommand<Args = unknown, Context extends EditorCommandContext = EditorCommandContext>(
  definition: CommandDefinition<Args, Context>
): CommandDefinition<Args, Context> {
  return definition;
}

interface CatalogEntry {
  id: string;
  title: string;
  category: CommandDefinition['category'];
  aliases: readonly string[];
  keywords?: readonly string[];
  surfaces?: readonly CommandSurface[];
  slash?: SlashBinding['placement'];
  keyboard?: readonly KeyboardBinding[];
  icon?: string;
  group?: string;
  priority?: number;
}

const defaultSurfaces = ['slash', 'plus-menu', 'command-palette'] as const;

const catalog: readonly CatalogEntry[] = [
  { id: 'block.turn.paragraph', title: 'Text', category: 'basic', aliases: ['text', 'plain', 'paragraph', 'plain text'], slash: 'transform', keyboard: [{ chord: 'mod+alt+0', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+0', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+0', platform: 'linux', when: ['text', 'block'] }], icon: 'T', priority: 50 },
  { id: 'block.insert.page', title: 'Page', category: 'basic', aliases: ['page', 'subpage'], slash: 'insert-block', keyboard: [{ chord: 'mod+alt+9', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+9', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+9', platform: 'linux', when: ['text', 'block'] }], icon: '📄', priority: 45 },
  { id: 'block.turn.bulleted_list_item', title: 'Bulleted list', category: 'basic', aliases: ['bullet', 'bulleted list', 'unordered list', '*', '-'], slash: 'transform', keyboard: [{ chord: 'mod+alt+5', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+5', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+5', platform: 'linux', when: ['text', 'block'] }], icon: '•', priority: 44 },
  { id: 'block.turn.numbered_list_item', title: 'Numbered list', category: 'basic', aliases: ['num', 'number', 'numbered list', 'ordered list', '1.'], slash: 'transform', keyboard: [{ chord: 'mod+alt+6', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+6', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+6', platform: 'linux', when: ['text', 'block'] }], icon: '1.', priority: 43 },
  { id: 'block.turn.to_do', title: 'To-do list', category: 'basic', aliases: ['todo', 'to do', 'checkbox', 'checklist', '[]'], slash: 'transform', keyboard: [{ chord: 'mod+alt+4', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+4', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+4', platform: 'linux', when: ['text', 'block'] }], icon: '☐', priority: 42 },
  { id: 'block.turn.toggle', title: 'Toggle list', category: 'basic', aliases: ['toggle', 'toggle list', '>'], slash: 'transform', keyboard: [{ chord: 'mod+alt+7', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+7', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+7', platform: 'linux', when: ['text', 'block'] }], icon: '▸', priority: 41 },
  { id: 'block.insert.divider', title: 'Divider', category: 'basic', aliases: ['div', 'divider', 'horizontal rule', '---'], slash: 'insert-block', icon: '—', priority: 40 },
  { id: 'block.turn.quote', title: 'Quote', category: 'basic', aliases: ['quote', 'blockquote', '"'], slash: 'transform', icon: '❝', priority: 39 },
  { id: 'block.turn.heading_1', title: 'Heading 1', category: 'basic', aliases: ['h1', '#', 'heading1', 'heading 1', 'large heading'], slash: 'transform', keyboard: [{ chord: 'mod+alt+1', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+1', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+1', platform: 'linux', when: ['text', 'block'] }], icon: 'H1', priority: 60 },
  { id: 'block.turn.heading_2', title: 'Heading 2', category: 'basic', aliases: ['h2', '##', 'heading2', 'heading 2', 'medium heading'], slash: 'transform', keyboard: [{ chord: 'mod+alt+2', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+2', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+2', platform: 'linux', when: ['text', 'block'] }], icon: 'H2', priority: 59 },
  { id: 'block.turn.heading_3', title: 'Heading 3', category: 'basic', aliases: ['h3', '###', 'heading3', 'heading 3', 'small heading'], slash: 'transform', keyboard: [{ chord: 'mod+alt+3', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+3', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+3', platform: 'linux', when: ['text', 'block'] }], icon: 'H3', priority: 58 },
  { id: 'block.insert.table', title: 'Simple table', category: 'basic', aliases: ['table', 'simple table'], slash: 'insert-block', icon: '▦' },
  { id: 'block.insert.link_to_page', title: 'Link to page', category: 'basic', aliases: ['link', 'link to page', 'page link'], slash: 'insert-block', icon: '🔗' },
  { id: 'block.turn.callout', title: 'Callout', category: 'basic', aliases: ['callout', 'note', 'info'], slash: 'transform', icon: '💡' },
  { id: 'database.insert.table_view', title: 'Table view', category: 'database', aliases: ['table view', 'database table'], slash: 'insert-block', icon: '▦' },
  { id: 'database.insert.board_view', title: 'Board view', category: 'database', aliases: ['board view', 'kanban'], slash: 'insert-block', icon: '▥' },
  { id: 'database.insert.gallery_view', title: 'Gallery view', category: 'database', aliases: ['gallery view'], slash: 'insert-block', icon: '▧' },
  { id: 'database.insert.list_view', title: 'List view', category: 'database', aliases: ['list view'], slash: 'insert-block', icon: '☰' },
  { id: 'database.insert.calendar_view', title: 'Calendar view', category: 'database', aliases: ['calendar view'], slash: 'insert-block', icon: '📅' },
  { id: 'database.insert.timeline_view', title: 'Timeline view', category: 'database', aliases: ['timeline view'], slash: 'insert-block', icon: '↔' },
  { id: 'database.insert.inline', title: 'Database', category: 'database', aliases: ['database', 'inline database', 'linked database', 'linked view'], slash: 'insert-block', icon: '🗃' },
  { id: 'database.insert.chart', title: 'Chart', category: 'database', aliases: ['chart', 'dashboard'], slash: 'insert-block', icon: '📊' },
  { id: 'inline.open.mention', title: 'Mention', category: 'inline', aliases: ['mention', '@'], slash: 'inline', surfaces: ['slash', 'mention-menu', 'command-palette'], icon: '@' },
  { id: 'inline.open.date', title: 'Date or reminder', category: 'inline', aliases: ['date', 'reminder', 'remind'], slash: 'inline', surfaces: ['slash', 'mention-menu', 'command-palette'], icon: '📅' },
  { id: 'inline.insert.equation', title: 'Inline equation', category: 'inline', aliases: ['equation', 'inline equation'], slash: 'inline', icon: '∑' },
  { id: 'inline.open.emoji', title: 'Emoji', category: 'inline', aliases: ['emoji', 'emote'], slash: 'inline', icon: '😀' },
  { id: 'media.insert.image', title: 'Image', category: 'media', aliases: ['image', 'photo', 'picture'], slash: 'insert-block', icon: '🖼' },
  { id: 'media.insert.pdf', title: 'PDF', category: 'media', aliases: ['pdf'], slash: 'insert-block', icon: 'PDF' },
  { id: 'media.insert.video', title: 'Video', category: 'media', aliases: ['video', 'movie'], slash: 'insert-block', icon: '▶' },
  { id: 'media.insert.audio', title: 'Audio', category: 'media', aliases: ['audio', 'sound'], slash: 'insert-block', icon: '♪' },
  { id: 'media.insert.code', title: 'Code', category: 'media', aliases: ['code', 'code block'], slash: 'insert-block', keyboard: [{ chord: 'mod+alt+8', platform: 'mac', when: ['text', 'block'] }, { chord: 'mod+shift+8', platform: 'windows', when: ['text', 'block'] }, { chord: 'mod+shift+8', platform: 'linux', when: ['text', 'block'] }], icon: '</>' },
  { id: 'media.insert.file', title: 'File', category: 'media', aliases: ['file', 'upload', 'attachment'], slash: 'insert-block', icon: '📎' },
  { id: 'embed.insert.bookmark', title: 'Web bookmark', category: 'embed', aliases: ['book', 'bookmark', 'web'], slash: 'insert-block', icon: '🔖', priority: 20 },
  { id: 'embed.insert.generic', title: 'Embed', category: 'embed', aliases: ['embed', 'iframe'], slash: 'insert-block', icon: '<>' },
  { id: 'embed.insert.tweet', title: 'Tweet / X', category: 'embed', aliases: ['tweet', 'x', 'twitter'], slash: 'insert-block', icon: '𝕏' },
  { id: 'embed.insert.drive', title: 'Google Drive', category: 'embed', aliases: ['drive', 'google drive'], slash: 'insert-block', icon: 'Drive' },
  { id: 'embed.insert.maps', title: 'Google Maps', category: 'embed', aliases: ['maps', 'google maps'], slash: 'insert-block', icon: 'Map' },
  { id: 'embed.insert.figma', title: 'Figma', category: 'embed', aliases: ['figma'], slash: 'insert-block', icon: 'Figma' },
  { id: 'embed.insert.loom', title: 'Loom', category: 'embed', aliases: ['loom'], slash: 'insert-block', icon: 'Loom' },
  { id: 'embed.insert.typeform', title: 'Typeform', category: 'embed', aliases: ['typeform'], slash: 'insert-block', icon: 'Typeform' },
  { id: 'embed.insert.codepen', title: 'CodePen', category: 'embed', aliases: ['codepen'], slash: 'insert-block', icon: 'CodePen' },
  { id: 'embed.insert.whimsical', title: 'Whimsical', category: 'embed', aliases: ['whimsical'], slash: 'insert-block', icon: 'Whimsical' },
  { id: 'embed.insert.gist', title: 'GitHub Gist', category: 'embed', aliases: ['gist'], slash: 'insert-block', icon: 'Gist' },
  { id: 'block.duplicate', title: 'Duplicate', category: 'advanced', aliases: ['duplicate', 'copy block'], slash: 'action', surfaces: ['slash', 'selected-block-menu', 'block-handle', 'keyboard'], keyboard: [{ chord: 'mod+d', when: ['block', 'text'] }], icon: '⧉' },
  { id: 'block.move_to', title: 'Move to', category: 'advanced', aliases: ['moveto', 'move to'], slash: 'action', surfaces: ['slash', 'selected-block-menu', 'block-handle'], icon: '↗' },
  { id: 'block.delete', title: 'Delete', category: 'advanced', aliases: ['delete', 'remove'], slash: 'action', surfaces: ['slash', 'selected-block-menu', 'block-handle', 'keyboard'], keyboard: [{ chord: 'Backspace', when: ['block'] }, { chord: 'Delete', when: ['block'] }], icon: '⌫' },
  { id: 'block.insert.table_of_contents', title: 'Table of contents', category: 'advanced', aliases: ['toc', 'table of contents'], slash: 'insert-block', icon: '☷' },
  { id: 'block.insert.button', title: 'Button', category: 'advanced', aliases: ['button'], slash: 'insert-block', icon: '▣' },
  { id: 'block.insert.template', title: 'Template', category: 'advanced', aliases: ['template'], slash: 'insert-block', icon: '▤' },
  { id: 'block.insert.breadcrumb', title: 'Breadcrumb', category: 'advanced', aliases: ['bread', 'breadcrumb'], slash: 'insert-block', icon: '›' },
  { id: 'block.insert.equation', title: 'Equation', category: 'advanced', aliases: ['math', 'latex', 'equation block'], slash: 'insert-block', icon: '∑' },
  { id: 'block.insert.synced', title: 'Synced block', category: 'advanced', aliases: ['synced', 'synced block'], slash: 'insert-block', icon: '↻' },
  { id: 'assistant.open', title: 'Ask AI', category: 'advanced', aliases: ['ai', 'ask ai'], slash: 'action', icon: 'AI' },
  { id: 'comment.add', title: 'Comment', category: 'comment', aliases: ['comment', 'discuss'], slash: 'action', surfaces: ['slash', 'selected-block-menu', 'block-handle', 'keyboard'], keyboard: [{ chord: 'mod+shift+m', when: ['text', 'block'] }], icon: '💬' },
  { id: 'color.default', title: 'Default color', category: 'color', aliases: ['default', 'clear color'], slash: 'action', icon: 'A' }
];

const colorNames = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;

export function createDefaultInputCommands<Context extends EditorCommandContext = EditorCommandContext>(): readonly CommandDefinition<unknown, Context>[] {
  const built: CommandDefinition<unknown, Context>[] = catalog.map(entry => makeCatalogCommand<Context>(entry));
  for (const color of colorNames) {
    built.push(makeCatalogCommand<Context>({ id: `color.${color}`, title: titleCase(color), category: 'color', aliases: [color, `${color} text`], slash: 'action', icon: 'A' }));
    built.push(makeCatalogCommand<Context>({ id: `color.${color}_background`, title: `${titleCase(color)} background`, category: 'color', aliases: [`${color} background`, `${color} highlight`], slash: 'action', icon: '▣' }));
  }
  return built;
}

function makeCatalogCommand<Context extends EditorCommandContext>(entry: CatalogEntry): CommandDefinition<unknown, Context> {
  const surfaces = entry.surfaces ?? defaultSurfaces;
  const slash = entry.slash ? [{ trigger: '/', aliases: entry.aliases, placement: entry.slash } satisfies SlashBinding] : undefined;
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    surfaces,
    search: { aliases: entry.aliases, ...(entry.keywords ? { keywords: entry.keywords } : {}) },
    predicates: [canEdit as CommandPredicate<Context>, nestedEditorDoesNotOwnEvent as CommandPredicate<Context>],
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.group ? { group: entry.group } : {}),
    ...(entry.priority ? { priority: entry.priority } : {}),
    ...(entry.keyboard ? { keyboard: entry.keyboard } : {}),
    ...(slash ? { slash } : {}),
    execute: () => ({ kind: 'ui', effect: 'plim.command.request', payload: { commandId: entry.id } })
  };
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function scoreCommandForQuery<Context extends EditorCommandContext>(
  command: CommandDefinition<unknown, Context>,
  query: string,
  ctx?: Context
): number {
  const foldedQuery = foldForSearch(query);
  const boost = command.search.boost ?? 0;
  const usageBoost = ctx?.commandUsage?.[command.id] ?? 0;
  const recencyBoost = ctx?.recentCommandIds?.includes(command.id) ? 15 : 0;
  if (foldedQuery.length === 0) return boost + recencyBoost + Math.min(usageBoost, 20) + (command.priority ?? 0);
  const aliases = [command.title, ...command.search.aliases, ...(command.search.keywords ?? []), ...((command.slash ?? []).flatMap(binding => binding.aliases))];
  let best = Number.NEGATIVE_INFINITY;
  for (const alias of aliases) {
    const exact = foldForSearch(alias) === foldedQuery ? 150 : Number.NEGATIVE_INFINITY;
    best = Math.max(best, exact, wordBoundaryScore(alias, foldedQuery), fuzzyScore(alias, foldedQuery));
  }
  return best + boost + recencyBoost + Math.min(usageBoost, 20) + (command.priority ?? 0);
}

export function commandToMenuItem<Context extends EditorCommandContext>(
  command: CommandDefinition<unknown, Context>,
  score: number,
  ctx?: Context
): CommandMenuItem {
  const disabled = ctx ? runPredicates(command.predicates, ctx) : null;
  const aliases = [...command.search.aliases, ...((command.slash ?? []).flatMap(binding => binding.aliases))];
  return {
    key: command.id,
    commandId: command.id,
    title: command.title,
    group: command.group ?? command.category,
    aliases,
    score,
    ...(command.description ? { subtitle: command.description } : {}),
    ...(command.icon ? { icon: command.icon } : {}),
    ...(disabled ? { disabled } : {})
  };
}

function runPredicates<Context extends EditorCommandContext>(predicates: readonly CommandPredicate<Context>[], ctx: Context): DisabledReason | null {
  for (const predicate of predicates) {
    const result = predicate(ctx);
    if (result !== true) return result;
  }
  return null;
}
