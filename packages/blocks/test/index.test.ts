import { describe, expect, it } from 'vitest';
import type { BlockType, RichText } from '@plim/model';
import {
  BLOCK_CATALOG,
  BLOCK_TYPES,
  MODEL_BACKED_BLOCK_TYPES,
  canContainChildren,
  canNestBlock,
  createDefaultBlockData,
  findBlockTypesByAlias,
  getBlockDefinition,
  getSlashCommandsForBlocks,
  isDatabaseBlock,
  isLayoutBlock,
  isMediaBlock,
  isTextualBlock,
  normalizeBlockByDefinition,
  validateBlockByDefinition,
  type CatalogBlockType
} from '../src/index.js';

const expectedModelBlockTypes: readonly BlockType[] = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'toggle_heading_1',
  'toggle_heading_2',
  'toggle_heading_3',
  'quote',
  'callout',
  'code',
  'equation',
  'divider',
  'table_of_contents',
  'breadcrumb',
  'page',
  'child_page',
  'child_database',
  'database_view',
  'column_list',
  'column',
  'table',
  'table_row',
  'template',
  'synced_block',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'link_preview',
  'unsupported'
];

describe('@plim/blocks catalog', () => {
  it('defines every model-backed block plus compatibility-only blocks', () => {
    expect(MODEL_BACKED_BLOCK_TYPES).toEqual(expectedModelBlockTypes);
    expect(new Set(BLOCK_TYPES)).toEqual(new Set<CatalogBlockType>([...expectedModelBlockTypes, 'link_to_page', 'button']));
    expect(BLOCK_CATALOG).toHaveLength(BLOCK_TYPES.length);

    for (const type of BLOCK_TYPES) {
      const definition = getBlockDefinition(type);
      expect(definition, type).toBeDefined();
      expect(definition?.type).toBe(type);
      expect(definition?.label.length).toBeGreaterThan(0);
      expect(definition?.accessibility.label.length).toBeGreaterThan(0);
    }
  });

  it('captures child constraints for containers and structural blocks', () => {
    expect(canContainChildren('paragraph')).toBe(true);
    expect(canNestBlock('paragraph', 'bulleted_list_item')).toBe(true);
    expect(canNestBlock('paragraph', 'column')).toBe(false);
    expect(canNestBlock('page', 'table_row')).toBe(false);

    expect(canContainChildren('divider')).toBe(false);
    expect(canNestBlock('divider', 'paragraph')).toBe(false);

    expect(canNestBlock('column_list', 'column')).toBe(true);
    expect(canNestBlock('column_list', 'paragraph')).toBe(false);
    expect(canNestBlock('table', 'table_row')).toBe(true);
    expect(canNestBlock('table', 'paragraph')).toBe(false);

    expect(canContainChildren('heading_1')).toBe(false);
    expect(canNestBlock('heading_1', 'paragraph')).toBe(false);
    expect(canNestBlock('heading_1', 'paragraph', { parentData: { richText: [], isToggleable: true } })).toBe(true);
    expect(canNestBlock('toggle_heading_1', 'paragraph')).toBe(true);

    expect(canContainChildren('synced_block', { syncedFrom: null })).toBe(true);
    expect(canContainChildren('synced_block', { syncedFrom: { blockId: 'source' as never } })).toBe(false);
  });

  it('creates model-compatible default data', () => {
    expect(createDefaultBlockData('paragraph')).toEqual({ richText: [], color: 'default' });
    expect(createDefaultBlockData('to_do')).toMatchObject({ richText: [], checked: false, color: 'default' });
    expect(createDefaultBlockData('callout')).toMatchObject({ richText: [], icon: { type: 'emoji', emoji: '💡' }, color: 'default' });
    expect(createDefaultBlockData('table')).toEqual({ hasColumnHeader: false, hasRowHeader: false, columnCount: 2 });
    expect(createDefaultBlockData('table_row')).toEqual({ cells: [[], []] });
    expect(createDefaultBlockData('button')).toEqual({ label: [{ type: 'text', text: { content: 'Button' }, plainText: 'Button', href: null }], actions: [] });
    expect(createDefaultBlockData('link_to_page')).toEqual({ target: null });
  });

  it('finds slash aliases and command metadata', () => {
    expect(findBlockTypesByAlias('/text')).toEqual(['paragraph']);
    expect(findBlockTypesByAlias('##')).toEqual(['heading_2']);
    expect(findBlockTypesByAlias('numbered list')).toEqual(['numbered_list_item']);
    expect(findBlockTypesByAlias('table view')).toEqual(['database_view']);
    expect(findBlockTypesByAlias('button')).toEqual(['button']);

    const commands = getSlashCommandsForBlocks({ includeCompatibilityOnly: true });
    expect(commands.some(command => command.type === 'paragraph' && command.aliases.includes('text'))).toBe(true);
    expect(commands.some(command => command.type === 'button')).toBe(true);
    expect(commands.every(command => !command.aliases.some(alias => alias.startsWith('/')))).toBe(true);
  });

  it('normalizes rich text, table rows, and bounded layout data', () => {
    const richText: RichText = [
      { type: 'text', text: { content: 'Hello' }, plainText: 'Hello', href: null },
      { type: 'text', text: { content: '' }, plainText: '', href: null },
      { type: 'text', text: { content: ' world' }, plainText: ' world', href: null }
    ];

    expect(normalizeBlockByDefinition('paragraph', { richText })).toEqual({
      richText: [{ type: 'text', text: { content: 'Hello world' }, plainText: 'Hello world', href: null }],
      color: 'default'
    });

    expect(normalizeBlockByDefinition('numbered_list_item', { richText: [], numbering: 'lower_alpha' })).toMatchObject({ numbering: 'lower_alpha' });
    expect(normalizeBlockByDefinition('table', { hasColumnHeader: true, hasRowHeader: false, columnCount: 0 })).toEqual({ hasColumnHeader: true, hasRowHeader: false, columnCount: 1 });
    expect(normalizeBlockByDefinition('table_row', { cells: [richText] }, { tableColumnCount: 3 }).cells).toHaveLength(3);
    expect(normalizeBlockByDefinition('column', { widthRatio: 2 })).toEqual({ widthRatio: 1 });
  });

  it('validates urls, tables, and child placement', () => {
    expect(validateBlockByDefinition('bookmark', { url: 'javascript:alert(1)', caption: [] }).some(item => item.code === 'invalid_url')).toBe(true);
    expect(validateBlockByDefinition('table', { hasColumnHeader: false, hasRowHeader: false, columnCount: 0 }).some(item => item.code === 'invalid_table')).toBe(true);
    expect(validateBlockByDefinition('table_row', { cells: [[]] }, { parentType: 'paragraph', tableColumnCount: 2 }).map(item => item.code)).toEqual(['invalid_parent', 'invalid_table']);
    expect(validateBlockByDefinition('column_list', {}, { childTypes: ['column'] }).some(item => item.code === 'invalid_children_count')).toBe(true);
  });

  it('exposes block family helpers', () => {
    expect(isTextualBlock('paragraph')).toBe(true);
    expect(isTextualBlock('divider')).toBe(false);
    expect(isMediaBlock('image')).toBe(true);
    expect(isMediaBlock('bookmark')).toBe(false);
    expect(isLayoutBlock('column_list')).toBe(true);
    expect(isDatabaseBlock('database_view')).toBe(true);
  });
});
