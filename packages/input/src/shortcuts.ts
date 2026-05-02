import type { CommandDefinition, EditorCommandContext, KeyChord, KeyboardBinding, Platform, SelectionKind } from './types.js';

export interface KeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

export interface NavigatorPlatformLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

export type ConflictLayer =
  | 'system'
  | 'ime'
  | 'modal'
  | 'menu'
  | 'nested-editor'
  | 'grid'
  | 'block-selection'
  | 'text-editing'
  | 'app-shell';

export const conflictPriority: Readonly<Record<ConflictLayer, number>> = {
  system: 900,
  ime: 800,
  modal: 700,
  menu: 600,
  'nested-editor': 500,
  grid: 400,
  'block-selection': 300,
  'text-editing': 200,
  'app-shell': 100
};

const modifierOrder = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const;

const keyAliases: Readonly<Record<string, string>> = {
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  control: 'Control',
  ctrl: 'Control',
  option: 'Alt',
  opt: 'Alt',
  alt: 'Alt',
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: ' ',
  spacebar: ' ',
  plus: '+',
  minus: '-',
  slash: '/',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End'
};

export function detectPlatform(explicit?: Platform | NavigatorPlatformLike | string): Platform {
  if (explicit === 'mac' || explicit === 'windows' || explicit === 'linux') return explicit;
  const platformText = typeof explicit === 'string'
    ? explicit
    : explicit?.userAgentData?.platform ?? explicit?.platform ?? explicit?.userAgent ?? globalNavigatorText();
  const folded = platformText.toLowerCase();
  if (/(mac|iphone|ipad|ipod)/u.test(folded)) return 'mac';
  if (/(win|windows)/u.test(folded)) return 'windows';
  return 'linux';
}

function globalNavigatorText(): string {
  const maybeNavigator = globalThis.navigator as NavigatorPlatformLike | undefined;
  return maybeNavigator?.userAgentData?.platform ?? maybeNavigator?.platform ?? maybeNavigator?.userAgent ?? '';
}

export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const alias = keyAliases[lower];
  if (alias) return alias;
  return key.length === 1 ? key.toLowerCase() : key;
}

export function eventToChord(event: KeyboardEventLike, platform: Platform = detectPlatform()): KeyChord {
  const chord: KeyChord = {
    key: normalizeKey(event.key),
    mod: platform === 'mac' ? Boolean(event.metaKey) : Boolean(event.ctrlKey),
    shift: Boolean(event.shiftKey),
    alt: Boolean(event.altKey),
    ctrl: Boolean(event.ctrlKey),
    meta: Boolean(event.metaKey)
  };
  if (event.code) return { ...chord, code: event.code };
  return chord;
}

export function parseKeyBinding(binding: string): KeyChord {
  const parts = binding.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Keyboard binding must include a key');
  const chord: KeyChord = { key: '' };
  for (const part of parts) {
    const folded = part.toLowerCase();
    if (folded === 'mod') chord.mod = true;
    else if (folded === 'shift') chord.shift = true;
    else if (folded === 'alt' || folded === 'option' || folded === 'opt') chord.alt = true;
    else if (folded === 'ctrl' || folded === 'control') chord.ctrl = true;
    else if (folded === 'meta' || folded === 'cmd' || folded === 'command') chord.meta = true;
    else if (folded.startsWith('code:')) chord.code = part.slice('code:'.length);
    else chord.key = normalizeKey(part);
  }
  if (!chord.key && chord.code) chord.key = chord.code;
  if (!chord.key) throw new Error(`Keyboard binding "${binding}" is missing a non-modifier key`);
  return chord;
}

export function stringifyChord(chord: KeyChord): string {
  const modifiers = modifierOrder.filter(modifier => Boolean(chord[modifier]));
  const code = chord.code && chord.code !== chord.key ? `code:${chord.code}` : undefined;
  return [...modifiers, code ?? normalizeKey(chord.key)].join('+');
}

export function chordMatches(actual: KeyChord, expected: KeyChord): boolean {
  if (normalizeKey(actual.key) !== normalizeKey(expected.key)) return false;
  if (Boolean(actual.mod) !== Boolean(expected.mod)) return false;
  if (!modifierMatches(actual, expected, 'shift')) return false;
  if (!modifierMatches(actual, expected, 'alt')) return false;
  if (!modifierMatches(actual, expected, 'ctrl')) return false;
  if (!modifierMatches(actual, expected, 'meta')) return false;
  return expected.code === undefined || actual.code === expected.code;
}

function modifierMatches(actual: KeyChord, expected: KeyChord, modifier: 'shift' | 'alt' | 'ctrl' | 'meta'): boolean {
  if (expected[modifier] === true) return actual[modifier] === true;
  if (expected.mod && (modifier === 'ctrl' || modifier === 'meta')) return true;
  return !actual[modifier];
}

export function bindingPlatformMatches(binding: KeyboardBinding, platform: Platform): boolean {
  return binding.platform === undefined || binding.platform === 'all' || binding.platform === platform;
}

export function formatShortcutLabel(chordOrBinding: KeyChord | string, platform: Platform = detectPlatform()): string {
  const chord = typeof chordOrBinding === 'string' ? parseKeyBinding(chordOrBinding) : chordOrBinding;
  const key = displayKey(chord.key);
  if (platform === 'mac') {
    const parts = [
      chord.mod || chord.meta ? '⌘' : '',
      chord.ctrl ? '⌃' : '',
      chord.alt ? '⌥' : '',
      chord.shift ? '⇧' : ''
    ].filter(part => part.length > 0);
    return `${parts.join('')}${key}`;
  }
  const parts = [
    chord.mod || chord.ctrl ? 'Ctrl' : '',
    chord.alt ? 'Alt' : '',
    chord.shift ? 'Shift' : '',
    chord.meta ? 'Meta' : ''
  ].filter(part => part.length > 0);
  return [...parts, key].join('+');
}

function displayKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key.replace(/^Arrow/u, '');
}

export interface KeyboardMatch<Context extends EditorCommandContext = EditorCommandContext> {
  command: CommandDefinition<unknown, Context>;
  binding: KeyboardBinding;
  priority: number;
  disabled: boolean;
}

export function keyboardBindingMatches(
  binding: KeyboardBinding,
  chord: KeyChord,
  platform: Platform,
  selectionKind: SelectionKind
): boolean {
  if (!bindingPlatformMatches(binding, platform)) return false;
  if (!binding.when.includes(selectionKind)) return false;
  return chordMatches(chord, parseKeyBinding(binding.chord));
}

export function resolveKeyboardMatches<Context extends EditorCommandContext>(
  commands: readonly CommandDefinition<unknown, Context>[],
  chord: KeyChord,
  ctx: Context,
  platform: Platform = ctx.platform ?? detectPlatform()
): readonly KeyboardMatch<Context>[] {
  const matches: KeyboardMatch<Context>[] = [];
  for (const command of commands) {
    for (const binding of command.keyboard ?? []) {
      if (!keyboardBindingMatches(binding, chord, platform, ctx.selection.kind)) continue;
      const disabled = command.predicates.some(predicate => predicate(ctx) !== true);
      const layer = layerForSelection(ctx.selection.kind);
      matches.push({
        command,
        binding,
        priority: conflictPriority[layer] + (binding.priority ?? 0) + (command.priority ?? 0),
        disabled
      });
    }
  }
  return matches.sort((a, b) => b.priority - a.priority || a.command.title.localeCompare(b.command.title));
}

function layerForSelection(selectionKind: SelectionKind): ConflictLayer {
  if (selectionKind === 'cell') return 'grid';
  if (selectionKind === 'block') return 'block-selection';
  if (selectionKind === 'text') return 'text-editing';
  return 'app-shell';
}

export function shouldPreventDefaultForMatch(match: KeyboardMatch, enabled: boolean): boolean {
  const policy = match.binding.preventDefault ?? 'when-enabled';
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return enabled;
}
