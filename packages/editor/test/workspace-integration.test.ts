import { describe, expect, it } from 'vitest';
import {
  TITLE_PROPERTY_ID,
  asDataSourceId,
  asDatabaseId,
  asViewId,
  createEditor,
  createEmptyDocument,
  createIdFactory,
  plainTextFromRichText,
  richTextFromPlainText
} from '@plim/editor';
import type { DataSourceRecord, DatabaseRecord, ViewRecord } from '@plim/editor';
import { createDefaultBlockData, validateBlockByDefinition } from '@plim/blocks';
import { evaluateMarkdownInput } from '@plim/input';
import { createCaretSelection, createTextPoint, validateSelection } from '@plim/selection';
import { queryDataSource } from '@plim/databases';
import type { ClientDatabaseState } from '@plim/databases';

const now = '2026-05-01T00:00:00.000Z';
const clock = { now: () => now };

describe('workspace package integration', () => {
  it('uses editor, block, input, selection, and database APIs together deterministically', async () => {
    const idFactory = createIdFactory({ seed: 'workspace-integration' });
    const document = createEmptyDocument({ idFactory, clock, title: 'Roadmap' });
    const editor = createEditor({ document, idFactory, clock });

    const inserted = await editor.executeCommand('block.insertParagraph', { text: 'Draft heading' });
    expect(inserted.ok).toBe(true);

    const paragraphId = editor.state.document.blocks[editor.rootPageId]?.children[0];
    expect(paragraphId).toBeDefined();
    if (!paragraphId) throw new Error('Expected inserted paragraph block');

    const markdown = evaluateMarkdownInput({
      text: '# ',
      caretOffset: 2,
      blockId: paragraphId,
      blockType: 'paragraph'
    });
    expect(markdown?.ruleId).toBe('markdown.heading_1');
    if (!markdown) throw new Error('Expected markdown heading transform');

    const transformed = await editor.dispatch(markdown.operations);
    expect(transformed.ok).toBe(true);

    const heading = editor.state.document.blocks[paragraphId];
    expect(heading?.type).toBe('heading_1');
    expect(heading ? validateBlockByDefinition(heading.type, heading.data).map(issue => issue.code) : ['missing']).toEqual([]);

    const todoData = createDefaultBlockData('to_do');
    expect(validateBlockByDefinition('to_do', todoData)).toEqual([]);

    const selection = createCaretSelection(createTextPoint(paragraphId, 0));
    expect(validateSelection(editor.state.document, selection, { repair: true }).ok).toBe(true);

    const dataSourceId = asDataSourceId('ds_integration');
    const databaseId = asDatabaseId('db_integration');
    const viewId = asViewId('view_integration');
    const rootPageId = editor.rootPageId;
    const dataSource: DataSourceRecord = {
      createdAt: now,
      lastEditedAt: now,
      id: dataSourceId,
      workspaceId: editor.state.document.workspace.id,
      databaseId,
      title: richTextFromPlainText('Pages'),
      properties: {
        [TITLE_PROPERTY_ID]: {
          id: TITLE_PROPERTY_ID,
          name: 'Name',
          type: 'title',
          config: { type: 'title' },
          lifecycle: 'active'
        }
      },
      propertyOrder: [TITLE_PROPERTY_ID],
      entries: {
        [rootPageId]: { pageId: rootPageId, order: 'a' }
      },
      lifecycle: 'active',
      version: 1
    };
    const database: DatabaseRecord = {
      createdAt: now,
      lastEditedAt: now,
      id: databaseId,
      workspaceId: editor.state.document.workspace.id,
      parent: { kind: 'workspace', workspaceId: editor.state.document.workspace.id },
      title: richTextFromPlainText('Pages'),
      dataSourceIds: [dataSourceId],
      viewIds: [viewId],
      isInline: true,
      lifecycle: 'active',
      version: 1
    };
    const view: ViewRecord = {
      createdAt: now,
      lastEditedAt: now,
      id: viewId,
      workspaceId: editor.state.document.workspace.id,
      databaseId,
      dataSourceId,
      name: 'All pages',
      type: 'table',
      sorts: [{ propertyId: TITLE_PROPERTY_ID, direction: 'ascending' }],
      visiblePropertyIds: [TITLE_PROPERTY_ID],
      configuration: {},
      version: 1
    };
    const databaseState: ClientDatabaseState = {
      ...editor.state.document,
      workspace: {
        ...editor.state.document.workspace,
        rootDatabaseIds: [databaseId]
      },
      databases: { [databaseId]: database },
      dataSources: { [dataSourceId]: dataSource },
      views: { [viewId]: view },
      revision: 1
    };

    const query = queryDataSource(databaseState, {
      dataSourceId,
      search: 'road',
      sorts: [{ propertyId: TITLE_PROPERTY_ID, direction: 'ascending' }]
    });

    expect(query.rows.map(row => row.pageId)).toEqual([rootPageId]);
    expect(plainTextFromRichText(query.rows[0]?.title ?? [])).toBe('Roadmap');
  });
});
