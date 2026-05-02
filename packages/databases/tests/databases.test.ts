import { describe, expect, it } from 'vitest';
import {
  asBlockId,
  asDataSourceId,
  asDatabaseId,
  asPageId,
  asPropertyId,
  asUserId,
  asWorkspaceId,
  asViewId,
  createEmptyDocument,
  richTextFromPlainText
} from '@plim/model';
import type {
  BlockRecord,
  DataSourceProperty,
  DataSourceRecord,
  DatabaseRecord,
  DocumentState,
  PageId,
  PagePropertyValue,
  PageRecord,
  PropertyId,
  SelectOption,
  ViewRecord
} from '@plim/model';
import {
  aggregateRollup,
  applyDatabaseOperations,
  compileFormula,
  defaultFormulaContext,
  evaluateFormula,
  evaluateRollup,
  queryDatabaseViewBlock,
  queryDataSource,
  queryInputFromDatabaseViewBlock
} from '../src/index.js';
import type { ClientDatabaseState, DataSourceTemplate } from '../src/index.js';

const now = '2025-01-15T12:00:00.000Z';
const workspaceId = asWorkspaceId('workspace');
const databaseId = asDatabaseId('db_tasks');
const dataSourceId = asDataSourceId('ds_tasks');
const viewId = asViewId('view_tasks');
const titleId = asPropertyId('title');
const statusId = asPropertyId('status');
const scoreId = asPropertyId('score');
const tagsId = asPropertyId('tags');
const dueId = asPropertyId('due');
const doneId = asPropertyId('done');
const formulaId = asPropertyId('formula_label');
const relationId = asPropertyId('rel_tasks');
const rollupId = asPropertyId('rollup_estimate');

const todo: SelectOption = { id: 'todo', name: 'Active', color: 'blue' };
const done: SelectOption = { id: 'done', name: 'Done', color: 'green' };
const api: SelectOption = { id: 'api', name: 'API', color: 'purple' };
const docs: SelectOption = { id: 'docs', name: 'Docs', color: 'gray' };

describe('@plim/databases query engine', () => {
  it('filters, sorts, groups, searches, and windows deterministically', () => {
    const state = makeTaskState();
    const result = queryDataSource(state, {
      dataSourceId,
      filter: { type: 'property', propertyId: statusId, operator: 'equals', value: 'Active' },
      sorts: [{ kind: 'property', propertyId: scoreId, direction: 'descending' }],
      search: 'api',
      groupBy: { propertyId: statusId },
      window: { offset: 0, limit: 1 }
    });

    expect(result.rows.map(row => String(row.pageId))).toEqual(['task_3']);
    expect(result.totalKnown).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('offset:1');
    expect(result.groups?.map(group => [group.label, group.totalKnown])).toEqual([['todo', 2]]);

    const next = queryDataSource(state, {
      dataSourceId,
      filter: { type: 'property', propertyId: statusId, operator: 'equals', value: 'Active' },
      sorts: [{ kind: 'property', propertyId: scoreId, direction: 'descending' }],
      search: 'api',
      window: { cursor: result.nextCursor, limit: 1 }
    });
    expect(next.rows.map(row => String(row.pageId))).toEqual(['task_1']);
  });

  it('uses view definitions and database view blocks as query inputs', () => {
    const state = makeTaskState();
    const block = state.blocks[asBlockId('block_view')] as BlockRecord<'database_view'>;
    const input = queryInputFromDatabaseViewBlock(state, block, { search: 'docs' });
    expect(String(input.dataSourceId)).toBe('ds_tasks');
    expect(String(input.viewId)).toBe('view_tasks');
    expect(input.query.search).toBe('docs');

    const result = queryDatabaseViewBlock(state, block, {
      search: 'docs',
      filter: { type: 'property', propertyId: statusId, operator: 'equals', value: 'Done' }
    });
    expect(result.rows.map(row => String(row.pageId))).toEqual(['task_2']);
  });
});

describe('@plim/databases formula engine', () => {
  it('parses, extracts dependencies, evaluates deterministic functions, and reports errors', () => {
    const state = makeTaskState();
    const dataSource = state.dataSources[dataSourceId];
    const compiled = compileFormula('if(and(prop("Score") > 2, contains(prop("Name"), "API")), upper(prop("Status")), "skip")', { dataSource });
    expect(compiled.dependencies.map(dep => String(dep.propertyId)).sort()).toEqual(['score', 'status', 'title']);

    const result = evaluateFormula({
      state,
      dataSourceId,
      pageId: asPageId('task_3'),
      propertyId: formulaId,
      context: defaultFormulaContext(now)
    }, compiled);
    expect(result.value).toEqual({ type: 'string', value: 'ACTIVE' });

    const errorCompiled = compileFormula('prop("Score") / 0', { dataSource });
    const error = evaluateFormula({
      state,
      dataSourceId,
      pageId: asPageId('task_1'),
      propertyId: formulaId,
      context: defaultFormulaContext(now)
    }, errorCompiled);
    expect(error.value.type).toBe('error');
    expect(error.value.type === 'error' ? error.value.error.code : '').toBe('division_by_zero');
  });
});

describe('@plim/databases relations and rollups', () => {
  it('aggregates relation targets and exposes rollup dependencies', () => {
    const state = makeRelationState();
    const result = evaluateRollup(state, asDataSourceId('ds_projects'), asPageId('project_1'), rollupId);
    expect(result.value).toEqual({ type: 'number', number: 8 });
    expect(result.dependencies.pageIds?.map(String).sort()).toEqual(['project_1', 'task_a', 'task_b']);

    expect(aggregateRollup([
      { type: 'boolean', value: true },
      { type: 'boolean', value: false },
      { type: 'boolean', value: true }
    ], 'checked')).toEqual({ type: 'number', number: 2 });
    expect(aggregateRollup([
      { type: 'date', value: { start: '2025-01-10' } },
      { type: 'date', value: { start: '2025-01-05', end: '2025-01-20' } }
    ], 'date_range')).toEqual({ type: 'date', date: { start: '2025-01-05', end: '2025-01-20' } });
    expect(aggregateRollup([
      { type: 'string', value: 'A' },
      { type: 'string', value: 'A' },
      { type: 'string', value: 'B' }
    ], 'show_unique')).toEqual({
      type: 'array',
      array: [{ type: 'string', string: 'A' }, { type: 'string', string: 'B' }]
    });
  });
});

describe('@plim/databases update operations', () => {
  it('updates schema, rows, relations, views, and templates immutably', () => {
    const state = makeTaskState();
    const priorityId = asPropertyId('priority');
    const template: DataSourceTemplate = {
      id: 'tmpl_today',
      dataSourceId,
      name: 'Today',
      isDefault: false,
      propertyDefaults: {
        [dueId]: { kind: 'template_mention', value: 'today' },
        [statusId]: { kind: 'literal', value: { id: statusId, type: 'status', status: todo } }
      },
      bodyBlocks: [],
      createdTime: now,
      lastEditedTime: now
    };
    const result = applyDatabaseOperations(state, [
      {
        type: 'create_property',
        dataSourceId,
        property: property(priorityId, 'Priority', 'number', { type: 'number', format: 'number' })
      },
      { type: 'update_page_properties', dataSourceId, pageId: asPageId('task_1'), values: { [priorityId]: { id: priorityId, type: 'number', number: 10 } } },
      { type: 'create_template', template },
      { type: 'create_page_row', dataSourceId, pageId: asPageId('task_4'), templateId: template.id, values: { [titleId]: { id: titleId, type: 'title', title: richTextFromPlainText('New API task') } } },
      { type: 'update_view', viewId, patch: { visiblePropertyIds: [titleId, priorityId], configuration: { search: 'New' } } }
    ], { now, actorId: asUserId('user_1'), timeZone: 'UTC' });

    expect(state.pages[asPageId('task_1')].properties[priorityId]).toBeUndefined();
    expect(result.state.pages[asPageId('task_1')].properties[priorityId]).toEqual({ id: priorityId, type: 'number', number: 10 });
    expect(result.state.pages[asPageId('task_4')].properties[dueId]).toEqual({ id: dueId, type: 'date', date: { start: '2025-01-15', timeZone: 'UTC' } });
    expect(result.state.views[viewId].visiblePropertyIds?.map(String)).toEqual(['title', 'priority']);
    expect(result.revision).toBe((state.revision ?? state.schema.version) + 1);
  });
});

function makeTaskState(): ClientDatabaseState {
  const base = createEmptyDocument({ workspaceId, pageId: asPageId('root'), title: 'Root' }) as ClientDatabaseState;
  base.revision = 1;
  const properties: DataSourceRecord['properties'] = {
    [titleId]: property(titleId, 'Name', 'title', { type: 'title' }),
    [statusId]: property(statusId, 'Status', 'status', { type: 'status', options: [todo, done] }),
    [scoreId]: property(scoreId, 'Score', 'number', { type: 'number', format: 'number' }),
    [tagsId]: property(tagsId, 'Tags', 'multi_select', { type: 'multi_select', options: [api, docs] }),
    [dueId]: property(dueId, 'Due', 'date', { type: 'date' }),
    [doneId]: property(doneId, 'Done', 'checkbox', { type: 'checkbox' }),
    [formulaId]: property(formulaId, 'Formula', 'formula', { type: 'formula', expression: 'prop("Score") + 1' })
  };
  const dataSource: DataSourceRecord = {
    ...audit(),
    id: dataSourceId,
    workspaceId,
    databaseId,
    title: richTextFromPlainText('Tasks'),
    properties,
    propertyOrder: [titleId, statusId, scoreId, tagsId, dueId, doneId, formulaId],
    entries: {},
    lifecycle: 'active',
    version: 1
  };
  const database: DatabaseRecord = {
    ...audit(),
    id: databaseId,
    workspaceId,
    parent: { kind: 'workspace', workspaceId },
    title: richTextFromPlainText('Tasks'),
    dataSourceIds: [dataSourceId],
    viewIds: [viewId],
    isInline: true,
    lifecycle: 'active',
    version: 1
  };
  const view: ViewRecord = {
    ...audit(),
    id: viewId,
    workspaceId,
    databaseId,
    dataSourceId,
    name: 'Board',
    type: 'board',
    filter: { propertyId: statusId, condition: 'equals', value: 'Active' },
    sorts: [{ propertyId: scoreId, direction: 'descending' }],
    groups: [{ propertyId: statusId }],
    visiblePropertyIds: [titleId, statusId, scoreId, tagsId],
    configuration: {},
    version: 1
  };
  const rows = [
    row('task_1', 'Build API client', todo, 3, [api], '2025-01-20', false),
    row('task_2', 'Write docs', done, 5, [docs], '2025-01-21', true),
    row('task_3', 'API polish', todo, 8, [api], '2025-01-22', false)
  ];
  rows.forEach((page, index) => {
    base.pages[page.id] = page;
    dataSource.entries[page.id] = { pageId: page.id, order: index.toString(36).padStart(8, '0') };
  });
  base.databases[databaseId] = database;
  base.dataSources[dataSourceId] = dataSource;
  base.views[viewId] = view;
  base.blocks[asBlockId('block_view')] = {
    ...audit(),
    id: asBlockId('block_view'),
    workspaceId,
    type: 'database_view',
    parent: { kind: 'page', pageId: asPageId('root') },
    children: [],
    lifecycle: 'active',
    version: 1,
    data: { databaseId, dataSourceId, viewId }
  };
  return base;
}

function makeRelationState(): ClientDatabaseState {
  const state = makeTaskState();
  const projectDs = asDataSourceId('ds_projects');
  const projectTitle = asPropertyId('project_title');
  const estimateId = asPropertyId('estimate');
  const projectRelation = property(relationId, 'Tasks', 'relation', { type: 'relation', targetDataSourceId: dataSourceId });
  const projectRollup = property(rollupId, 'Total estimate', 'rollup', { type: 'rollup', relationPropertyId: relationId, rollupPropertyId: estimateId, function: 'sum' });
  state.dataSources[dataSourceId].properties[estimateId] = property(estimateId, 'Estimate', 'number', { type: 'number', format: 'number' });
  state.dataSources[dataSourceId].propertyOrder.push(estimateId);
  const taskA = relationTask('task_a', 3);
  const taskB = relationTask('task_b', 5);
  state.pages[taskA.id] = taskA;
  state.pages[taskB.id] = taskB;
  state.dataSources[dataSourceId].entries[taskA.id] = { pageId: taskA.id, order: '00000009' };
  state.dataSources[dataSourceId].entries[taskB.id] = { pageId: taskB.id, order: '0000000a' };
  state.dataSources[projectDs] = {
    ...audit(),
    id: projectDs,
    workspaceId,
    databaseId,
    title: richTextFromPlainText('Projects'),
    properties: {
      [projectTitle]: property(projectTitle, 'Name', 'title', { type: 'title' }),
      [relationId]: projectRelation,
      [rollupId]: projectRollup
    },
    propertyOrder: [projectTitle, relationId, rollupId],
    entries: { [asPageId('project_1')]: { pageId: asPageId('project_1'), order: '00000000' } },
    lifecycle: 'active',
    version: 1
  };
  state.pages[asPageId('project_1')] = {
    ...audit(),
    id: asPageId('project_1'),
    workspaceId,
    parent: { kind: 'data_source', dataSourceId: projectDs },
    titlePlain: 'Website',
    properties: {
      [projectTitle]: { id: projectTitle, type: 'title', title: richTextFromPlainText('Website') },
      [relationId]: {
        id: relationId,
        type: 'relation',
        relation: [
          { pageId: taskA.id, dataSourceId },
          { pageId: taskB.id, dataSourceId }
        ]
      }
    } as Record<PropertyId, PagePropertyValue>,
    dataSourceId: projectDs,
    lifecycle: 'active',
    version: 1
  };
  return state;
}

function row(id: string, title: string, status: SelectOption, score: number, tags: SelectOption[], due: string, checked: boolean): PageRecord {
  const pageId = asPageId(id);
  return {
    ...audit(),
    id: pageId,
    workspaceId,
    parent: { kind: 'data_source', dataSourceId },
    titlePlain: title,
    properties: {
      [titleId]: { id: titleId, type: 'title', title: richTextFromPlainText(title) },
      [statusId]: { id: statusId, type: 'status', status },
      [scoreId]: { id: scoreId, type: 'number', number: score },
      [tagsId]: { id: tagsId, type: 'multi_select', multiSelect: tags },
      [dueId]: { id: dueId, type: 'date', date: { start: due } },
      [doneId]: { id: doneId, type: 'checkbox', checkbox: checked }
    } as Record<PropertyId, PagePropertyValue>,
    dataSourceId,
    lifecycle: 'active',
    version: 1
  };
}

function relationTask(id: string, estimate: number): PageRecord {
  const page = row(id, id, todo, estimate, [api], '2025-01-20', false);
  const estimateId = asPropertyId('estimate');
  page.properties[estimateId] = { id: estimateId, type: 'number', number: estimate };
  return page;
}

function property(id: PropertyId, name: string, type: DataSourceProperty['type'], config: DataSourceProperty['config']): DataSourceProperty {
  return { id, name, type, config, lifecycle: 'active' };
}

function audit() {
  return { createdAt: now, lastEditedAt: now };
}
