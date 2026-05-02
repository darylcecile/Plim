import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  CompositionGuard,
  activeMenuItem,
  classifyBeforeInput,
  createDefaultInputCommands,
  createMenuNavigationState,
  detectAutocompleteTrigger,
  detectSlashTrigger,
  evaluateMarkdownInput,
  evaluateMarkdownInputAfterInsertion,
  eventToChord,
  formatShortcutLabel,
  getLocalAutocompleteItems,
  moveMenuNavigation,
  parseClipboardData,
  parseHtmlToFragments,
  parseKeyBinding,
  parseMarkdownToFragments,
  searchSlashCommands,
  shouldRunInputRules,
  chordMatches,
  type BlockId,
  type EditorCommandContext
} from '../src/index.js';

const blockId = 'block_test' as BlockId;

const textContext: EditorCommandContext = {
  selection: { kind: 'text', anchor: { blockId, offsetUtf16: 0 }, focus: { blockId, offsetUtf16: 0 } },
  readOnly: false,
  currentBlockIds: () => [blockId]
};

describe('@plim/input shortcuts', () => {
  it('normalizes and labels shortcuts across platforms', () => {
    const macChord = eventToChord({ key: 'B', code: 'KeyB', metaKey: true }, 'mac');
    expect(chordMatches(macChord, parseKeyBinding('mod+b'))).toBe(true);
    expect(formatShortcutLabel('mod+alt+1', 'mac')).toBe('⌘⌥1');

    const windowsChord = eventToChord({ key: '1', ctrlKey: true, shiftKey: true }, 'windows');
    expect(chordMatches(windowsChord, parseKeyBinding('mod+shift+1'))).toBe(true);
    expect(formatShortcutLabel('mod+shift+1', 'windows')).toBe('Ctrl+Shift+1');
  });

  it('resolves keyboard conflicts by selection priority and binding priority', () => {
    const registry = new CommandRegistry({ commands: createDefaultInputCommands() });
    const matches = registry.findKeyboardMatches({ key: 'd', ctrlKey: true }, { ...textContext, platform: 'windows' });
    expect(matches[0]?.command.id).toBe('block.duplicate');
  });
});

describe('@plim/input slash commands', () => {
  it('detects slash tokens and ranks exact aliases first', () => {
    expect(detectSlashTrigger('hello /h1', 9)?.query).toBe('h1');
    const commands = createDefaultInputCommands();
    const h1 = searchSlashCommands(commands, 'h1', { ctx: textContext });
    expect(h1[0]?.commandId).toBe('block.turn.heading_1');

    const book = searchSlashCommands(commands, 'book', { ctx: textContext });
    expect(book[0]?.commandId).toBe('embed.insert.bookmark');
  });

  it('groups menu state and moves active item with keyboard keys', () => {
    const items = searchSlashCommands(createDefaultInputCommands(), 'h', { ctx: textContext, limit: 4 });
    const state = moveMenuNavigation(createMenuNavigationState(items.length), 'ArrowDown');
    expect(activeMenuItem(items, state)).toBe(items[1]);
  });
});

describe('@plim/input markdown transforms', () => {
  it('turns line-start markers into block operations', () => {
    const heading = evaluateMarkdownInput({ text: '# ', caretOffset: 2, blockId, blockType: 'paragraph' });
    expect(heading?.ruleId).toBe('markdown.heading_1');
    expect(heading?.operations[0]).toMatchObject({ op: 'set_block_type', type: 'heading_1' });

    const heading2 = evaluateMarkdownInputAfterInsertion({
      text: '##',
      caretOffset: 2,
      insertedText: ' ',
      blockId,
      blockType: 'paragraph'
    });
    expect(heading2?.ruleId).toBe('markdown.heading_2');
    expect(heading2?.operations[0]).toMatchObject({ op: 'set_block_type', type: 'heading_2' });
    expect(heading2?.operations[0]).toMatchObject({ dataPatch: { richText: [] } });

    const heading3 = evaluateMarkdownInputAfterInsertion({
      text: '###',
      caretOffset: 3,
      insertedText: ' ',
      blockId,
      blockType: 'paragraph'
    });
    expect(heading3?.ruleId).toBe('markdown.heading_3');
    expect(heading3?.operations[0]).toMatchObject({ op: 'set_block_type', type: 'heading_3', dataPatch: { richText: [] } });

    const todo = evaluateMarkdownInput({ text: '[] ', caretOffset: 3, blockId, blockType: 'paragraph' });
    expect(todo?.operations[0]).toMatchObject({ op: 'set_block_type', type: 'to_do', dataPatch: { checked: false } });

    const divider = evaluateMarkdownInput({ text: '---', caretOffset: 3, blockId, blockType: 'paragraph' });
    expect(divider?.operations[0]).toMatchObject({ op: 'set_block_type', type: 'divider' });
  });

  it('returns rich text replacement operations for inline transforms', () => {
    const bold = evaluateMarkdownInput({ text: '**bold**', caretOffset: 8, blockId, blockType: 'paragraph' });
    expect(bold?.ruleId).toBe('markdown.bold');
    expect(bold?.operations[0]).toMatchObject({ op: 'replace_rich_text' });
    expect(bold?.replacement?.[0]).toMatchObject({ type: 'text', annotations: { bold: true }, text: { content: 'bold' } });
  });

  it('does not transform while composing or inside code', () => {
    expect(evaluateMarkdownInput({ text: '# ', caretOffset: 2, blockId, composing: true })).toBeNull();
    expect(evaluateMarkdownInput({ text: '# ', caretOffset: 2, blockId, blockType: 'code' })).toBeNull();
  });
});

describe('@plim/input autocomplete', () => {
  it('prioritizes page links for [[ and page creation for +', () => {
    const pages = [{ id: 'page_1', title: 'Roadmap' }];
    const linkSession = detectAutocompleteTrigger('[[Road', 6);
    expect(linkSession?.trigger).toBe('[[');
    expect(getLocalAutocompleteItems(linkSession!, { pages })[0]?.command.commandId).toBe('inline.insert.page_link');

    const createSession = detectAutocompleteTrigger('+Road', 5);
    expect(createSession?.trigger).toBe('+');
    expect(getLocalAutocompleteItems(createSession!, { pages })[0]?.command.commandId).toBe('page.create_subpage');
  });

  it('detects dates, reminders, equations, and links locally', () => {
    const today = detectAutocompleteTrigger('@today', 6);
    expect(today?.kind).toBe('date');
    expect(getLocalAutocompleteItems(today!, { now: new Date('2026-05-01T12:00:00Z') })[0]?.subtitle).toBe('2026-05-01');

    expect(detectAutocompleteTrigger('@remind tomorrow', 16)?.kind).toBe('reminder');
    expect(detectAutocompleteTrigger('/math E=mc^2', 12)?.kind).toBe('equation');
    expect(detectAutocompleteTrigger('see example.com', 15)?.kind).toBe('link');
  });
});

describe('@plim/input paste and drop parsing', () => {
  it('parses plain text, markdown, html, URLs, and files into block fragments', () => {
    const plain = parseClipboardData({ types: ['text/plain'], getData: () => 'One\n\nTwo' });
    expect(plain.source).toBe('plain-text');
    expect(plain.fragments).toHaveLength(2);

    const markdown = parseMarkdownToFragments('# Title\n- Item\n```ts\nconst x = 1;\n```');
    expect(markdown.map(fragment => fragment.type)).toEqual(['heading_1', 'bulleted_list_item', 'code']);

    const html = parseHtmlToFragments('<h2>Section</h2><p>Hello <strong>world</strong></p><hr>');
    expect(html.map(fragment => fragment.type)).toEqual(['heading_2', 'paragraph', 'divider']);

    const url = parseClipboardData({ types: ['text/plain'], getData: () => 'https://example.com' });
    expect(url.source).toBe('url');
    expect(url.fragments[0]?.type).toBe('bookmark');

    const files = parseClipboardData({ types: [], files: [{ name: 'photo.png', type: 'image/png', size: 12 }], getData: () => '' });
    expect(files.fragments[0]?.type).toBe('image');
  });
});

describe('@plim/input IME and beforeinput guards', () => {
  it('guards input rules during composition and classifies beforeinput', () => {
    const guard = new CompositionGuard();
    guard.start({ data: '# ' });
    expect(shouldRunInputRules({ inputType: 'insertText', data: '# ' }, guard)).toBe(false);
    expect(guard.end({ data: '# ' })).toBe('# ');
    expect(shouldRunInputRules({ inputType: 'insertText', data: '# ' }, guard)).toBe(true);

    expect(classifyBeforeInput({ inputType: 'insertFromPaste', dataTransfer: {} }).kind).toBe('paste');
    expect(classifyBeforeInput({ inputType: 'historyUndo' }).kind).toBe('history_undo');
  });
});
