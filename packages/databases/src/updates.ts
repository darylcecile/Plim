import { cloneDeep, deepMerge, plainTextFromRichText, richTextFromPlainText } from '@plim/model';
import type {
  BlockId,
  BlockRecord,
  DataSourceEntry,
  DataSourceRecord,
  JsonObject,
  PageId,
  PagePropertyValue,
  PageRecord,
  PropertyId,
  ViewRecord
} from '@plim/model';
import { defaultPropertyValue } from './query.js';
import { createRelationGraph, setRelationTargets } from './relations.js';
import type {
  ClientDatabaseState,
  DataSourceTemplate,
  DatabaseOperation,
  DatabaseTransactionOptions,
  DatabaseTransactionResult,
  EditablePropertyValue,
  FormulaDiagnostic,
  PropertyTemplateValue,
  QueryDependencySet
} from './types.js';

export function applyDatabaseOperations(
  state: ClientDatabaseState,
  operations: readonly DatabaseOperation[],
  options: DatabaseTransactionOptions
): DatabaseTransactionResult {
  let next = cloneDeep(state) as ClientDatabaseState;
  const invalidated: QueryDependencySet[] = [];
  const diagnostics: FormulaDiagnostic[] = [];
  for (const operation of operations) {
    next = applyDatabaseOperation(next, operation, options, invalidated);
  }
  next.revision = (state.revision ?? state.schema.version) + 1;
  next.schema.updatedAt = options.now;
  next.relationGraph = createRelationGraph(next);
  return {
    state: next,
    revision: next.revision,
    applied: [...operations],
    invalidated,
    diagnostics
  };
}

export function applyDatabaseOperation(
  state: ClientDatabaseState,
  operation: DatabaseOperation,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[] = []
): ClientDatabaseState {
  switch (operation.type) {
    case 'create_database':
      return applyCreateDatabase(state, operation, options, invalidated);
    case 'update_database':
      return applyUpdateDatabase(state, operation, options);
    case 'create_data_source':
      return applyCreateDataSource(state, operation, options, invalidated);
    case 'update_data_source':
      return applyUpdateDataSource(state, operation, options, invalidated);
    case 'create_property':
      return applyCreateProperty(state, operation, options, invalidated);
    case 'update_property':
      return applyUpdateProperty(state, operation, options, invalidated);
    case 'delete_property':
      return applyDeleteProperty(state, operation, options, invalidated);
    case 'reorder_property':
      return applyReorderProperty(state, operation, options, invalidated);
    case 'create_page_row':
      return applyCreatePageRow(state, operation, options, invalidated);
    case 'update_page_properties':
      return applyUpdatePageProperties(state, operation, options, invalidated);
    case 'move_page_row':
      return applyMovePageRow(state, operation, options, invalidated);
    case 'trash_page_row':
      return applyTrashPageRow(state, operation, options, invalidated);
    case 'create_view':
      return applyCreateView(state, operation, options, invalidated);
    case 'update_view':
      return applyUpdateView(state, operation, options, invalidated);
    case 'delete_view':
      return applyDeleteView(state, operation, options, invalidated);
    case 'set_relation':
      return applySetRelation(state, operation, options, invalidated);
    case 'create_template':
      return applyCreateTemplate(state, operation, options, invalidated);
    case 'update_template':
      return applyUpdateTemplate(state, operation, options, invalidated);
    case 'delete_template':
      return applyDeleteTemplate(state, operation, invalidated);
  }
}

export function createTemplatePropertyValues(
  template: DataSourceTemplate,
  dataSource: DataSourceRecord,
  options: DatabaseTransactionOptions
): Partial<Record<PropertyId, EditablePropertyValue>> {
  const values: Partial<Record<PropertyId, EditablePropertyValue>> = {};
  for (const [rawPropertyId, templateValue] of Object.entries(template.propertyDefaults)) {
    const propertyId = rawPropertyId as PropertyId;
    const property = dataSource.properties[propertyId];
    if (property === undefined) continue;
    const value = resolveTemplateValue(propertyId, property.type, templateValue, options);
    if (value !== undefined) values[propertyId] = value;
  }
  return values;
}

export function validateEditablePropertyValue(property: DataSourceRecord['properties'][PropertyId], value: PagePropertyValue): asserts value is EditablePropertyValue {
  if (property.type !== value.type) {
    throw new Error(`Property ${String(property.id)} expects ${property.type}, received ${value.type}`);
  }
  if (!isEditablePropertyType(value.type)) {
    throw new Error(`Property ${String(property.id)} is computed and cannot be edited directly`);
  }
}

function applyCreateDatabase(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_database' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  ensureMissing(state.databases[operation.database.id], 'database');
  state.blocks[operation.block.id] = touchBlock(operation.block, options);
  state.databases[operation.database.id] = touchDatabase(operation.database, options);
  for (const dataSource of operation.dataSources) {
    const created = touchDataSource(dataSource, options);
    state.dataSources[dataSource.id] = created;
    invalidated.push(dependencyForDataSource(created));
  }
  for (const view of operation.views) {
    state.views[view.id] = touchView(view, options);
  }
  if (!state.workspace.rootDatabaseIds.includes(operation.database.id)) {
    state.workspace.rootDatabaseIds.push(operation.database.id);
    state.workspace.version += 1;
  }
  return state;
}

function applyUpdateDatabase(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_database' }>,
  options: DatabaseTransactionOptions
): ClientDatabaseState {
  const database = requireRecord(state.databases[operation.databaseId], 'database');
  state.databases[operation.databaseId] = {
    ...database,
    ...operation.patch,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: database.version + 1
  };
  return state;
}

function applyCreateDataSource(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_data_source' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const database = requireRecord(state.databases[operation.databaseId], 'database');
  ensureMissing(state.dataSources[operation.dataSource.id], 'data source');
  state.dataSources[operation.dataSource.id] = touchDataSource(operation.dataSource, options);
  database.dataSourceIds = unique([...database.dataSourceIds, operation.dataSource.id]);
  database.version += 1;
  database.lastEditedAt = options.now;
  if (operation.defaultView !== undefined) {
    state.views[operation.defaultView.id] = touchView(operation.defaultView, options);
    database.viewIds = unique([...database.viewIds, operation.defaultView.id]);
  }
  invalidated.push(dependencyForDataSource(operation.dataSource));
  return state;
}

function applyUpdateDataSource(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_data_source' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  const updated = {
    ...dataSource,
    ...operation.patch,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: dataSource.version + 1
  };
  state.dataSources[operation.dataSourceId] = updated;
  invalidated.push(dependencyForDataSource(updated));
  return state;
}

function applyCreateProperty(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_property' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  ensureMissing(dataSource.properties[operation.property.id], 'property');
  dataSource.properties[operation.property.id] = { ...operation.property, lifecycle: operation.property.lifecycle ?? 'active' };
  dataSource.propertyOrder = insertAfter(dataSource.propertyOrder, operation.property.id, operation.afterPropertyId);
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, [operation.property.id]));
  return state;
}

function applyUpdateProperty(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_property' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  const property = requireRecord(dataSource.properties[operation.propertyId], 'property');
  const updatedProperty = deepMerge<DataSourceRecord['properties'][PropertyId]>(property, operation.patch);
  updatedProperty.id = operation.propertyId;
  dataSource.properties[operation.propertyId] = updatedProperty;
  touchDataSourceInPlace(dataSource, options);
  if (operation.patch.type !== undefined || operation.patch.config !== undefined) {
    clearComputedValuesForProperty(state, operation.dataSourceId, operation.propertyId);
  }
  invalidated.push(dependencyForDataSource(dataSource, [operation.propertyId]));
  return state;
}

function applyDeleteProperty(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'delete_property' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  const property = requireRecord(dataSource.properties[operation.propertyId], 'property');
  if (operation.mode === 'trash') {
    property.lifecycle = 'trashed';
  } else {
    delete dataSource.properties[operation.propertyId];
    dataSource.propertyOrder = dataSource.propertyOrder.filter(propertyId => propertyId !== operation.propertyId);
    for (const entry of Object.values(dataSource.entries)) {
      const page = state.pages[entry.pageId];
      if (page !== undefined) delete page.properties[operation.propertyId];
    }
    repairViewsAfterPropertyRemoval(state, operation.propertyId);
  }
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, [operation.propertyId]));
  return state;
}

function applyReorderProperty(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'reorder_property' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  requireRecord(dataSource.properties[operation.propertyId], 'property');
  dataSource.propertyOrder = insertAfter(dataSource.propertyOrder.filter(propertyId => propertyId !== operation.propertyId), operation.propertyId, operation.afterPropertyId);
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, [operation.propertyId]));
  return state;
}

function applyCreatePageRow(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_page_row' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  ensureMissing(state.pages[operation.pageId], 'page');
  const values = initialRowValues(state, dataSource, operation.values, operation.templateId, options);
  const titleId = titlePropertyId(dataSource);
  const titleValue = titleId === undefined ? undefined : values[titleId];
  const title = titleValue?.type === 'title' ? titleValue.title : richTextFromPlainText('Untitled');
  const metadata = auditMetadata(options);
  const page: PageRecord = {
    ...metadata,
    id: operation.pageId,
    workspaceId: dataSource.workspaceId,
    parent: { kind: 'data_source', dataSourceId: dataSource.id },
    titlePlain: plainTextFromRichText(title),
    properties: values as Record<PropertyId, PagePropertyValue>,
    dataSourceId: dataSource.id,
    lifecycle: 'active',
    version: 1
  };
  state.pages[operation.pageId] = page;
  state.blocks[operation.pageId as unknown as BlockId] = createPageBlock(page, title, dataSource.id);
  const entries = orderedEntryIds(dataSource);
  const insertIndex = operation.afterPageId === undefined ? entries.length : Math.max(0, entries.indexOf(operation.afterPageId) + 1);
  entries.splice(insertIndex, 0, operation.pageId);
  dataSource.entries[operation.pageId] = { pageId: operation.pageId };
  renumberEntries(dataSource, entries);
  cloneTemplateBlocks(state, operation.templateId, operation.pageId);
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, Object.keys(values) as PropertyId[]));
  return state;
}

function applyUpdatePageProperties(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_page_properties' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  const page = requireRecord(state.pages[operation.pageId], 'page');
  const changed: PropertyId[] = [];
  for (const [rawPropertyId, value] of Object.entries(operation.values)) {
    if (value === undefined) continue;
    const propertyId = rawPropertyId as PropertyId;
    const property = requireRecord(dataSource.properties[propertyId], 'property');
    validateEditablePropertyValue(property, value);
    page.properties[propertyId] = value;
    changed.push(propertyId);
  }
  touchPageInPlace(page, options);
  if (changed.some(propertyId => dataSource.properties[propertyId]?.type === 'title')) {
    const titleId = titlePropertyId(dataSource);
    const titleValue = titleId === undefined ? undefined : page.properties[titleId];
    if (titleValue?.type === 'title') page.titlePlain = plainTextFromRichText(titleValue.title);
  }
  invalidated.push(dependencyForDataSource(dataSource, changed, [operation.pageId]));
  return state;
}

function applyMovePageRow(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'move_page_row' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  requireRecord(dataSource.entries[operation.pageId], 'entry');
  const entries = orderedEntryIds(dataSource).filter(pageId => pageId !== operation.pageId);
  const index = operation.afterPageId === undefined ? 0 : Math.max(0, entries.indexOf(operation.afterPageId) + 1);
  entries.splice(index, 0, operation.pageId);
  renumberEntries(dataSource, entries);
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, [], [operation.pageId]));
  return state;
}

function applyTrashPageRow(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'trash_page_row' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const dataSource = requireRecord(state.dataSources[operation.dataSourceId], 'data source');
  const page = requireRecord(state.pages[operation.pageId], 'page');
  const entry = requireRecord(dataSource.entries[operation.pageId], 'entry');
  const lifecycle = operation.inTrash ? 'trashed' : 'active';
  page.lifecycle = lifecycle;
  entry.lifecycle = lifecycle;
  touchPageInPlace(page, options);
  touchDataSourceInPlace(dataSource, options);
  invalidated.push(dependencyForDataSource(dataSource, [], [operation.pageId]));
  return state;
}

function applyCreateView(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_view' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  ensureMissing(state.views[operation.view.id], 'view');
  state.views[operation.view.id] = touchView(operation.view, options);
  const database = state.databases[operation.view.databaseId];
  if (database !== undefined) database.viewIds = unique([...database.viewIds, operation.view.id]);
  const dataSourceId = operation.view.dataSourceId;
  if (dataSourceId !== undefined) invalidated.push(dependencyForDataSource(requireRecord(state.dataSources[dataSourceId], 'data source')));
  return state;
}

function applyUpdateView(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_view' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const view = requireRecord(state.views[operation.viewId], 'view');
  const merged = deepMerge<ViewRecord>(view, operation.patch);
  state.views[operation.viewId] = {
    ...merged,
    id: operation.viewId,
    workspaceId: view.workspaceId,
    databaseId: view.databaseId,
    name: merged.name,
    type: merged.type,
    sorts: merged.sorts,
    configuration: merged.configuration,
    createdAt: view.createdAt,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: view.version + 1
  };
  if (view.dataSourceId !== undefined) invalidated.push(dependencyForDataSource(requireRecord(state.dataSources[view.dataSourceId], 'data source')));
  return state;
}

function applyDeleteView(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'delete_view' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const view = requireRecord(state.views[operation.viewId], 'view');
  delete state.views[operation.viewId];
  const database = state.databases[view.databaseId];
  if (database !== undefined) {
    database.viewIds = database.viewIds.filter(viewId => viewId !== operation.viewId);
    database.lastEditedAt = options.now;
    database.version += 1;
  }
  if (view.dataSourceId !== undefined) {
    const dataSource = state.dataSources[view.dataSourceId];
    if (dataSource !== undefined) invalidated.push(dependencyForDataSource(dataSource));
  }
  return state;
}

function applySetRelation(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'set_relation' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  const next = setRelationTargets(state, operation.dataSourceId, operation.pageId, operation.propertyId, operation.targetPageIds);
  const page = next.pages[operation.pageId];
  if (page !== undefined) touchPageInPlace(page, options);
  const dataSource = requireRecord(next.dataSources[operation.dataSourceId], 'data source');
  invalidated.push(dependencyForDataSource(dataSource, [operation.propertyId], [operation.pageId, ...operation.targetPageIds]));
  return next;
}

function applyCreateTemplate(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'create_template' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  state.databaseTemplates = state.databaseTemplates ?? {};
  ensureMissing(state.databaseTemplates[operation.template.id], 'template');
  state.databaseTemplates[operation.template.id] = {
    ...operation.template,
    createdTime: operation.template.createdTime || options.now,
    lastEditedTime: options.now
  };
  invalidated.push(dependencyForDataSource(requireRecord(state.dataSources[operation.template.dataSourceId], 'data source')));
  return state;
}

function applyUpdateTemplate(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'update_template' }>,
  options: DatabaseTransactionOptions,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  state.databaseTemplates = state.databaseTemplates ?? {};
  const template = requireRecord(state.databaseTemplates[operation.templateId], 'template');
  const merged = deepMerge<DataSourceTemplate>(template, operation.patch);
  state.databaseTemplates[operation.templateId] = {
    ...merged,
    id: operation.templateId,
    dataSourceId: template.dataSourceId,
    name: merged.name,
    isDefault: merged.isDefault,
    propertyDefaults: merged.propertyDefaults,
    bodyBlocks: merged.bodyBlocks,
    createdTime: template.createdTime,
    lastEditedTime: options.now
  };
  invalidated.push(dependencyForDataSource(requireRecord(state.dataSources[template.dataSourceId], 'data source')));
  return state;
}

function applyDeleteTemplate(
  state: ClientDatabaseState,
  operation: Extract<DatabaseOperation, { type: 'delete_template' }>,
  invalidated: QueryDependencySet[]
): ClientDatabaseState {
  state.databaseTemplates = state.databaseTemplates ?? {};
  const template = state.databaseTemplates[operation.templateId];
  if (template !== undefined) {
    delete state.databaseTemplates[operation.templateId];
    const dataSource = state.dataSources[template.dataSourceId];
    if (dataSource !== undefined) invalidated.push(dependencyForDataSource(dataSource));
  }
  return state;
}

function initialRowValues(
  state: ClientDatabaseState,
  dataSource: DataSourceRecord,
  explicitValues: Partial<Record<PropertyId, EditablePropertyValue>> | undefined,
  templateId: string | undefined,
  options: DatabaseTransactionOptions
): Partial<Record<PropertyId, PagePropertyValue>> {
  const values: Partial<Record<PropertyId, PagePropertyValue>> = {};
  for (const propertyId of dataSource.propertyOrder) {
    const property = dataSource.properties[propertyId];
    if (property === undefined || !isEditablePropertyType(property.type)) continue;
    const empty = defaultPropertyValue(property, createPlaceholderPage(dataSource, options));
    if (empty !== undefined && isEditablePropertyType(empty.type)) values[propertyId] = empty;
  }
  const template = templateId === undefined ? undefined : state.databaseTemplates?.[templateId];
  if (template !== undefined) {
    Object.assign(values, createTemplatePropertyValues(template, dataSource, options));
  }
  if (explicitValues !== undefined) {
    for (const [rawPropertyId, value] of Object.entries(explicitValues)) {
      if (value === undefined) continue;
      const propertyId = rawPropertyId as PropertyId;
      const property = requireRecord(dataSource.properties[propertyId], 'property');
      validateEditablePropertyValue(property, value);
      values[propertyId] = value;
    }
  }
  return values;
}

function resolveTemplateValue(
  propertyId: PropertyId,
  propertyType: DataSourceRecord['properties'][PropertyId]['type'],
  templateValue: PropertyTemplateValue | undefined,
  options: DatabaseTransactionOptions
): EditablePropertyValue | undefined {
  if (templateValue === undefined) return undefined;
  if (templateValue.kind === 'literal') return cloneDeep(templateValue.value);
  if (templateValue.kind === 'formula') {
    if (propertyType === 'rich_text') return { id: propertyId, type: 'rich_text', richText: richTextFromPlainText(templateValue.expression) };
    if (propertyType === 'title') return { id: propertyId, type: 'title', title: richTextFromPlainText(templateValue.expression) };
    return undefined;
  }
  if (templateValue.value === 'now') {
    if (propertyType === 'date') return { id: propertyId, type: 'date', date: { start: options.now, includeTime: true, ...(options.timeZone ? { timeZone: options.timeZone } : {}) } };
    if (propertyType === 'rich_text') return { id: propertyId, type: 'rich_text', richText: richTextFromPlainText(options.now) };
  }
  if (templateValue.value === 'today') {
    if (propertyType === 'date') return { id: propertyId, type: 'date', date: { start: options.now.slice(0, 10), ...(options.timeZone ? { timeZone: options.timeZone } : {}) } };
    if (propertyType === 'rich_text') return { id: propertyId, type: 'rich_text', richText: richTextFromPlainText(options.now.slice(0, 10)) };
  }
  if (templateValue.value === 'current_user' && options.actorId !== undefined) {
    if (propertyType === 'people') return { id: propertyId, type: 'people', people: [options.actorId] };
    if (propertyType === 'created_by') return undefined;
  }
  return undefined;
}

function cloneTemplateBlocks(state: ClientDatabaseState, templateId: string | undefined, pageId: PageId): void {
  const template = templateId === undefined ? undefined : state.databaseTemplates?.[templateId];
  if (template === undefined) return;
  for (const block of template.bodyBlocks) {
    if (state.blocks[block.id] !== undefined) throw new Error(`Template block id collision ${String(block.id)}`);
    state.blocks[block.id] = { ...cloneDeep(block), parent: { kind: 'page', pageId } };
  }
}

function createPageBlock(page: PageRecord, title: import('@plim/model').RichText, dataSourceId: DataSourceRecord['id']): BlockRecord<'page'> {
  return {
    createdAt: page.createdAt,
    ...(page.createdBy ? { createdBy: page.createdBy } : {}),
    lastEditedAt: page.lastEditedAt,
    ...(page.lastEditedBy ? { lastEditedBy: page.lastEditedBy } : {}),
    id: page.id as unknown as BlockId,
    workspaceId: page.workspaceId,
    type: 'page',
    parent: { kind: 'data_source', dataSourceId },
    children: [],
    lifecycle: page.lifecycle,
    version: page.version,
    data: { title }
  };
}

function createPlaceholderPage(dataSource: DataSourceRecord, options: DatabaseTransactionOptions): PageRecord {
  return {
    ...auditMetadata(options),
    id: '' as PageId,
    workspaceId: dataSource.workspaceId,
    parent: { kind: 'data_source', dataSourceId: dataSource.id },
    titlePlain: '',
    properties: {} as Record<PropertyId, PagePropertyValue>,
    dataSourceId: dataSource.id,
    lifecycle: 'active',
    version: 1
  };
}

function isEditablePropertyType(type: PagePropertyValue['type']): type is EditablePropertyValue['type'] {
  return !['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id'].includes(type);
}

function clearComputedValuesForProperty(state: ClientDatabaseState, dataSourceId: DataSourceRecord['id'], propertyId: PropertyId): void {
  const dataSource = state.dataSources[dataSourceId];
  if (dataSource === undefined) return;
  for (const entry of Object.values(dataSource.entries)) {
    const page = state.pages[entry.pageId];
    if (page !== undefined) delete page.properties[propertyId];
  }
}

function repairViewsAfterPropertyRemoval(state: ClientDatabaseState, propertyId: PropertyId): void {
  for (const view of Object.values(state.views)) {
    const visiblePropertyIds = view.visiblePropertyIds?.filter(id => id !== propertyId);
    if (visiblePropertyIds === undefined) delete view.visiblePropertyIds;
    else view.visiblePropertyIds = visiblePropertyIds;
    view.sorts = view.sorts.filter(sort => sort.propertyId !== propertyId);
    const groups = view.groups?.filter(group => group.propertyId !== propertyId);
    if (groups === undefined) delete view.groups;
    else view.groups = groups;
    if (filterReferencesProperty(view.filter, propertyId)) delete view.filter;
  }
}

function filterReferencesProperty(filter: ViewRecord['filter'] | undefined, propertyId: PropertyId): boolean {
  if (filter === undefined) return false;
  if ('op' in filter) return filter.filters.some(child => filterReferencesProperty(child, propertyId));
  return filter.propertyId === propertyId;
}

function titlePropertyId(dataSource: DataSourceRecord): PropertyId | undefined {
  return dataSource.propertyOrder.find(propertyId => dataSource.properties[propertyId]?.type === 'title');
}

function orderedEntryIds(dataSource: DataSourceRecord): PageId[] {
  return Object.values(dataSource.entries)
    .sort((left, right) => (left.order ?? '').localeCompare(right.order ?? '') || String(left.pageId).localeCompare(String(right.pageId)))
    .map(entry => entry.pageId);
}

function renumberEntries(dataSource: DataSourceRecord, pageIds: readonly PageId[]): void {
  pageIds.forEach((pageId, index) => {
    const entry = dataSource.entries[pageId] ?? { pageId };
    dataSource.entries[pageId] = { ...entry, order: index.toString(36).padStart(8, '0') };
  });
}

function insertAfter<T>(items: readonly T[], item: T, after: T | undefined): T[] {
  const without = items.filter(value => value !== item);
  if (after === undefined) return [...without, item];
  const index = without.indexOf(after);
  if (index < 0) return [...without, item];
  return [...without.slice(0, index + 1), item, ...without.slice(index + 1)];
}

function unique<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function auditMetadata(options: DatabaseTransactionOptions) {
  return {
    createdAt: options.now,
    ...(options.actorId ? { createdBy: options.actorId } : {}),
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {})
  };
}

function touchBlock<T extends BlockRecord>(block: T, options: DatabaseTransactionOptions): T {
  return {
    ...block,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: block.version + 1
  };
}

function touchDatabase<T extends import('@plim/model').DatabaseRecord>(database: T, options: DatabaseTransactionOptions): T {
  return {
    ...database,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: database.version + 1
  };
}

function touchDataSource<T extends DataSourceRecord>(dataSource: T, options: DatabaseTransactionOptions): T {
  return {
    ...dataSource,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: dataSource.version + 1
  };
}

function touchView<T extends ViewRecord>(view: T, options: DatabaseTransactionOptions): T {
  return {
    ...view,
    lastEditedAt: options.now,
    ...(options.actorId ? { lastEditedBy: options.actorId } : {}),
    version: view.version + 1
  };
}

function touchDataSourceInPlace(dataSource: DataSourceRecord, options: DatabaseTransactionOptions): void {
  dataSource.lastEditedAt = options.now;
  if (options.actorId !== undefined) dataSource.lastEditedBy = options.actorId;
  dataSource.version += 1;
}

function touchPageInPlace(page: PageRecord, options: DatabaseTransactionOptions): void {
  page.lastEditedAt = options.now;
  if (options.actorId !== undefined) page.lastEditedBy = options.actorId;
  page.version += 1;
}

function dependencyForDataSource(dataSource: DataSourceRecord, propertyIds: PropertyId[] = [], pageIds?: PageId[]): QueryDependencySet {
  return {
    dataSourceId: dataSource.id,
    schemaVersion: dataSource.version,
    propertyIds,
    relationPropertyIds: propertyIds.filter(propertyId => dataSource.properties[propertyId]?.type === 'relation'),
    formulaPropertyIds: propertyIds.filter(propertyId => dataSource.properties[propertyId]?.type === 'formula'),
    rollupPropertyIds: propertyIds.filter(propertyId => dataSource.properties[propertyId]?.type === 'rollup'),
    ...(pageIds !== undefined ? { pageIds } : {})
  };
}

function requireRecord<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

function ensureMissing(value: unknown, label: string): void {
  if (value !== undefined) throw new Error(`Cannot create duplicate ${label}`);
}

void ({} as JsonObject);
void ({} as DataSourceEntry);
