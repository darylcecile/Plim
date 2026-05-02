import type { CommandDefinition, CommandMenuItem, EditorCommandContext } from './types.js';
import { commandToMenuItem, scoreCommandForQuery } from './commands.js';

export interface SlashTriggerSession {
  trigger: '/';
  query: string;
  range: { start: number; end: number };
  escaped: boolean;
}

export interface SlashTriggerOptions {
  composing?: boolean;
  escapedRanges?: readonly { start: number; end: number }[];
  allowInsideWord?: boolean;
  blockType?: string;
}

export function detectSlashTrigger(text: string, caretOffset: number, options: SlashTriggerOptions = {}): SlashTriggerSession | null {
  if (options.composing) return null;
  if (options.blockType === 'code' || options.blockType === 'equation') return null;
  const safeCaret = Math.max(0, Math.min(caretOffset, text.length));
  const beforeCaret = text.slice(0, safeCaret);
  const slashIndex = beforeCaret.lastIndexOf('/');
  if (slashIndex < 0) return null;
  if (slashIndex > 0 && beforeCaret.charAt(slashIndex - 1) === '\\') return null;
  if (!options.allowInsideWord && slashIndex > 0 && /[\p{L}\p{N}_]/u.test(beforeCaret.charAt(slashIndex - 1))) return null;
  const query = beforeCaret.slice(slashIndex + 1);
  if (/\s{2,}/u.test(query) || /\n/u.test(query)) return null;
  const escaped = (options.escapedRanges ?? []).some(range => slashIndex >= range.start && slashIndex < range.end);
  if (escaped) return { trigger: '/', query, range: { start: slashIndex, end: safeCaret }, escaped: true };
  return { trigger: '/', query, range: { start: slashIndex, end: safeCaret }, escaped: false };
}

export interface SlashSearchOptions<Context extends EditorCommandContext = EditorCommandContext> {
  ctx?: Context;
  includeDisabled?: boolean;
  limit?: number;
  groups?: readonly string[];
}

export function searchSlashCommands<Context extends EditorCommandContext>(
  commands: readonly CommandDefinition<unknown, Context>[],
  query: string,
  options: SlashSearchOptions<Context> = {}
): readonly CommandMenuItem[] {
  const items: CommandMenuItem[] = [];
  for (const command of commands) {
    if (!command.surfaces.includes('slash')) continue;
    if (!command.slash || command.slash.length === 0) continue;
    const score = scoreCommandForQuery(command, query, options.ctx);
    if (!Number.isFinite(score) || score < 1) continue;
    const item = commandToMenuItem(command, score, options.ctx);
    if (!options.includeDisabled && item.disabled) continue;
    items.push(item);
  }
  const groupRank = new Map((options.groups ?? defaultSlashGroups).map((group, index) => [group, index]));
  return items
    .sort((a, b) => b.score - a.score || (groupRank.get(String(a.group)) ?? 99) - (groupRank.get(String(b.group)) ?? 99) || a.title.localeCompare(b.title))
    .slice(0, options.limit ?? items.length);
}

export const defaultSlashGroups = ['basic', 'database', 'media', 'embed', 'advanced', 'inline', 'color', 'comment', 'navigation'] as const;

export interface GroupedCommandMenu {
  group: string;
  items: readonly CommandMenuItem[];
}

export function groupCommandMenuItems(items: readonly CommandMenuItem[], groupOrder: readonly string[] = defaultSlashGroups): readonly GroupedCommandMenu[] {
  const rank = new Map(groupOrder.map((group, index) => [group, index]));
  const groups = new Map<string, CommandMenuItem[]>();
  for (const item of items) {
    const group = String(item.group);
    const existing = groups.get(group);
    if (existing) existing.push(item);
    else groups.set(group, [item]);
  }
  return [...groups.entries()]
    .sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99) || a[0].localeCompare(b[0]))
    .map(([group, groupItems]) => ({ group, items: groupItems }));
}

export interface MenuNavigationState {
  itemCount: number;
  activeIndex: number;
}

export interface MenuNavigationOptions {
  loop?: boolean;
  pageSize?: number;
}

export function createMenuNavigationState(itemCount: number, activeIndex = 0): MenuNavigationState {
  return {
    itemCount: Math.max(0, itemCount),
    activeIndex: itemCount <= 0 ? -1 : clamp(activeIndex, 0, itemCount - 1)
  };
}

export function moveMenuNavigation(state: MenuNavigationState, key: string, options: MenuNavigationOptions = {}): MenuNavigationState {
  if (state.itemCount <= 0) return createMenuNavigationState(0);
  const pageSize = Math.max(1, options.pageSize ?? 8);
  let next = state.activeIndex;
  switch (key) {
    case 'ArrowDown':
      next += 1;
      break;
    case 'ArrowUp':
      next -= 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = state.itemCount - 1;
      break;
    case 'PageDown':
      next += pageSize;
      break;
    case 'PageUp':
      next -= pageSize;
      break;
    default:
      return state;
  }
  if (options.loop) {
    const count = state.itemCount;
    next = ((next % count) + count) % count;
  } else {
    next = clamp(next, 0, state.itemCount - 1);
  }
  return { ...state, activeIndex: next };
}

export function activeMenuItem<T>(items: readonly T[], state: MenuNavigationState): T | undefined {
  return state.activeIndex >= 0 ? items[state.activeIndex] : undefined;
}

export function nextEnabledMenuIndex(items: readonly CommandMenuItem[], fromIndex: number, direction: 1 | -1, loop = true): number {
  if (items.length === 0) return -1;
  for (let step = 0; step < items.length; step += 1) {
    const raw = fromIndex + direction * (step + 1);
    const index = loop ? ((raw % items.length) + items.length) % items.length : raw;
    if (index < 0 || index >= items.length) return -1;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
