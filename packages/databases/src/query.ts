import { isRecord, plainTextFromRichText } from '@plim/model';
import type {
  DataSourceEntry,
  DataSourceRecord,
  DateMention,
  JsonValue,
  PageId,
  PagePropertyValue,
  PageRecord,
  PropertyId,
  RichText,
  ViewRecord
} from '@plim/model';
import {
  compileFormula,
  defaultFormulaContext,
  evaluateFormula,
  formulaValueToComputedValue
} from './formula.js';
import { createRelationGraph, evaluateRollup } from './relations.js';
import type {
  ClientDatabaseState,
  DataSourceQueryInput,
  DataSourceQueryResult,
  FilterNode,
  FilterOperator,
  GroupKey,
  GroupSpec,
  ProjectionSpec,
  QueryDependencySet,
  QueryGroup,
  QueryRow,
  RelationGraph,
  SortKey,
  SortSpec
} from './types.js';

const FILTER_OPERATORS = new Set<FilterOperator>([
  'is_empty',
  'is_not_empty',
  'equals',
  'does_not_equal',
  'contains',
  'does_not_contain',
  'starts_with',
  'ends_with',
  'greater_than',
  'greater_than_or_equal_to',
  'less_than',
  'less_than_or_equal_to',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'within',
  'past_week',
  'past_month',
  'past_year',
  'next_week',
  'next_month',
  'next_year',
  'this_week'
]);

export function queryDataSource(state: ClientDatabaseState, input: DataSourceQueryInput): DataSourceQueryResult {
  const dataSource = state.dataSources[input.dataSourceId];
  if (dataSource === undefined) {
    throw new Error(`Missing data source ${String(input.dataSourceId)}`);
  }
  const view = input.viewId === undefined ? undefined : state.views[input.viewId];
  const merged = mergeQueryInput(view, input);
  const context = { ...defaultFormulaContext(input.formulaContext?.now ?? state.schema.updatedAt), ...input.formulaContext };
  const graph = state.relationGraph ?? createRelationGraph(state);
  const rows = Object.values(dataSource.entries)
    .filter(entry => entryVisible(entry, state.pages[entry.pageId], Boolean(merged.includeTrashed)))
    .map(entry => materializeRow(state, dataSource, entry, context, graph))
    .filter(row => merged.filter === undefined || evaluateFilter(merged.filter, row, context.now))
    .filter(row => merged.search === undefined || searchRow(row, merged.search, projectionPropertyIds(dataSource, view, merged.projection)));

  const sorted = sortMaterializedRows(rows, merged.sorts ?? []);
  const groupSpec = merged.groupBy ?? firstViewGroup(view);
  const groups = groupSpec === undefined ? undefined : buildGroups(sorted, groupSpec);
  const window = merged.window;
  const offset = resolveOffset(window?.cursor, window?.offset);
  const limit = window?.limit ?? sorted.length;
  const overscan = window?.overscan ?? 0;
  const end = Math.min(sorted.length, offset + limit + overscan);
  const windowed = sorted.slice(offset, end);
  const projectionIds = projectionPropertyIds(dataSource, view, merged.projection);
  const queryRows = windowed.map(row => toQueryRow(row, projectionIds, merged.projection));
  const nextOffset = offset + limit;
  const hasMore = nextOffset < sorted.length;
  const dependencies = buildDependencies(dataSource, sorted, view, merged, projectionIds);
  return {
    dataSourceId: input.dataSourceId,
    revision: merged.revision ?? state.revision ?? state.schema.version,
    rows: queryRows,
    ...(groups === undefined ? {} : { groups }),
    totalKnown: sorted.length,
    hasMore,
    ...(hasMore ? { nextCursor: createCursor(nextOffset) } : {}),
    completeness: 'complete',
    dependencies
  };
}

export function mergeQueryInput(view: ViewRecord | undefined, input: DataSourceQueryInput): DataSourceQueryInput {
  const viewFilter = normalizeModelFilter(view?.filter);
  const viewSorts = normalizeModelSorts(view?.sorts);
  const viewSearch = viewSearchValue(view);
  const viewGroup = firstViewGroup(view);
  const result: DataSourceQueryInput = {
    dataSourceId: input.dataSourceId,
    ...(input.viewId !== undefined ? { viewId: input.viewId } : view?.id !== undefined ? { viewId: view.id } : {}),
    ...(viewFilter !== undefined ? { filter: viewFilter } : {}),
    ...(viewSorts.length > 0 ? { sorts: viewSorts } : {}),
    ...(viewSearch !== undefined ? { search: viewSearch } : {}),
    ...(viewGroup !== undefined ? { groupBy: viewGroup } : {}),
    ...(input.projection !== undefined ? { projection: input.projection } : {}),
    ...(input.window !== undefined ? { window: input.window } : {}),
    ...(input.includeTrashed !== undefined ? { includeTrashed: input.includeTrashed } : {}),
    ...(input.includeComputed !== undefined ? { includeComputed: input.includeComputed } : {}),
    ...(input.includeIncomplete !== undefined ? { includeIncomplete: input.includeIncomplete } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(input.formulaContext !== undefined ? { formulaContext: input.formulaContext } : {})
  };
  if (input.filter !== undefined) result.filter = input.filter;
  if (input.sorts !== undefined) result.sorts = input.sorts;
  if (input.search !== undefined) result.search = input.search;
  if (input.groupBy !== undefined) result.groupBy = input.groupBy;
  return result;
}

export function normalizeModelFilter(filter: ViewRecord['filter'] | undefined): FilterNode | undefined {
  if (filter === undefined) return undefined;
  const candidate: unknown = filter;
  if (isRecord(candidate) && typeof candidate['type'] === 'string') return candidate as FilterNode;
  if ('op' in filter) {
    return {
      type: filter.op,
      filters: filter.filters.map(child => normalizeModelFilter(child)).filter((child): child is FilterNode => child !== undefined)
    };
  }
  const operator = FILTER_OPERATORS.has(filter.condition as FilterOperator) ? filter.condition as FilterOperator : 'equals';
  return {
    type: 'property',
    propertyId: filter.propertyId,
    operator,
    ...(filter.value !== undefined ? { value: filter.value } : {})
  };
}

export function normalizeModelSorts(sorts: readonly ViewRecord['sorts'][number][] | undefined): SortSpec[] {
  return (sorts ?? []).map(sort => ({
    kind: sort.propertyId === undefined ? 'timestamp' : 'property',
    ...(sort.propertyId !== undefined ? { propertyId: sort.propertyId } : {}),
    ...(sort.timestamp !== undefined ? { timestamp: sort.timestamp } : {}),
    direction: sort.direction
  }));
}

export function readQueryPropertyValue(
  state: ClientDatabaseState,
  dataSource: DataSourceRecord,
  page: PageRecord,
  propertyId: PropertyId,
  graph: RelationGraph = state.relationGraph ?? createRelationGraph(state)
): PagePropertyValue | undefined {
  const property = dataSource.properties[propertyId];
  if (property === undefined) return undefined;
  if (property.config.type === 'formula') {
    const context = defaultFormulaContext(state.schema.updatedAt);
    const compiled = compileFormula(property.config.expression, { dataSource });
    const result = evaluateFormula({ state, dataSourceId: dataSource.id, pageId: page.id, propertyId, context }, compiled);
    return { id: propertyId, type: 'formula', formula: formulaValueToComputedValue(result.value) };
  }
  if (property.config.type === 'rollup') {
    return { id: propertyId, type: 'rollup', rollup: evaluateRollup(state, dataSource.id, page.id, propertyId, graph).value };
  }
  return page.properties[propertyId] ?? defaultPropertyValue(property, page);
}

export function defaultPropertyValue(property: DataSourceRecord['properties'][PropertyId], page: PageRecord): PagePropertyValue | undefined {
  switch (property.type) {
    case 'title':
      {
        const existing = page.properties[property.id];
        return { id: property.id, type: 'title', title: existing?.type === 'title' ? existing.title : [] };
      }
    case 'rich_text':
      return { id: property.id, type: 'rich_text', richText: [] };
    case 'number':
      return { id: property.id, type: 'number', number: null };
    case 'select':
      return { id: property.id, type: 'select', select: null };
    case 'multi_select':
      return { id: property.id, type: 'multi_select', multiSelect: [] };
    case 'status':
      return { id: property.id, type: 'status', status: null };
    case 'date':
      return { id: property.id, type: 'date', date: null };
    case 'formula':
      return { id: property.id, type: 'formula', formula: { type: 'string', string: null } };
    case 'relation':
      return { id: property.id, type: 'relation', relation: [] };
    case 'rollup':
      return { id: property.id, type: 'rollup', rollup: { type: 'array', array: [] } };
    case 'people':
      return { id: property.id, type: 'people', people: [] };
    case 'files':
      return { id: property.id, type: 'files', files: [] };
    case 'checkbox':
      return { id: property.id, type: 'checkbox', checkbox: false };
    case 'url':
      return { id: property.id, type: 'url', url: null };
    case 'email':
      return { id: property.id, type: 'email', email: null };
    case 'phone_number':
      return { id: property.id, type: 'phone_number', phoneNumber: null };
    case 'created_time':
      return { id: property.id, type: 'created_time', createdTime: page.createdAt };
    case 'created_by':
      return page.createdBy === undefined ? undefined : { id: property.id, type: 'created_by', createdBy: page.createdBy };
    case 'last_edited_time':
      return { id: property.id, type: 'last_edited_time', lastEditedTime: page.lastEditedAt };
    case 'last_edited_by':
      return page.lastEditedBy === undefined ? undefined : { id: property.id, type: 'last_edited_by', lastEditedBy: page.lastEditedBy };
    case 'unique_id':
      return { id: property.id, type: 'unique_id', uniqueId: { ...(property.config.type === 'unique_id' && property.config.prefix ? { prefix: property.config.prefix } : {}), number: 0 } };
    case 'unsupported':
      return undefined;
  }
}

function materializeRow(
  state: ClientDatabaseState,
  dataSource: DataSourceRecord,
  entry: DataSourceEntry,
  context: ReturnType<typeof defaultFormulaContext>,
  graph: RelationGraph
): MaterializedRow {
  const page = state.pages[entry.pageId];
  if (page === undefined) throw new Error(`Missing page ${String(entry.pageId)} for data source entry`);
  const values: Partial<Record<PropertyId, PagePropertyValue>> = {};
  for (const propertyId of dataSource.propertyOrder) {
    const value = readQueryPropertyValue(state, dataSource, page, propertyId, graph);
    if (value !== undefined) values[propertyId] = value;
  }
  const title = titleForRow(dataSource, page, values);
  return {
    entry,
    page,
    dataSource,
    title,
    values,
    sortKeys: [],
    groupKeys: [],
    contextNow: context.now
  };
}

function entryVisible(entry: DataSourceEntry, page: PageRecord | undefined, includeTrashed: boolean): boolean {
  if (page === undefined) return false;
  if (includeTrashed) return true;
  return page.lifecycle !== 'trashed'
    && page.lifecycle !== 'deleted'
    && entry.lifecycle !== 'trashed'
    && entry.lifecycle !== 'deleted';
}

function evaluateFilter(filter: FilterNode, row: MaterializedRow, now: string): boolean {
  switch (filter.type) {
    case 'and':
      return filter.filters.every(child => evaluateFilter(child, row, now));
    case 'or':
      return filter.filters.some(child => evaluateFilter(child, row, now));
    case 'not':
      return !evaluateFilter(filter.filter, row, now);
    case 'property':
      return evaluatePropertyFilter(row.values[filter.propertyId], filter.operator, filter.value, now);
  }
}

function evaluatePropertyFilter(value: PagePropertyValue | undefined, operator: FilterOperator, expected: JsonValue | undefined, now: string): boolean {
  const empty = propertyValueEmpty(value);
  switch (operator) {
    case 'is_empty':
      return empty;
    case 'is_not_empty':
      return !empty;
    case 'equals':
      return comparePropertyValue(value, expected) === 0;
    case 'does_not_equal':
      return comparePropertyValue(value, expected) !== 0;
    case 'contains':
      return containsPropertyValue(value, expected);
    case 'does_not_contain':
      return !containsPropertyValue(value, expected);
    case 'starts_with':
      return normalizedDisplay(value).startsWith(normalizeForSearch(jsonDisplay(expected)));
    case 'ends_with':
      return normalizedDisplay(value).endsWith(normalizeForSearch(jsonDisplay(expected)));
    case 'greater_than':
      return orderPropertyValue(value, expected) > 0;
    case 'greater_than_or_equal_to':
      return orderPropertyValue(value, expected) >= 0;
    case 'less_than':
      return orderPropertyValue(value, expected) < 0;
    case 'less_than_or_equal_to':
      return orderPropertyValue(value, expected) <= 0;
    case 'before':
      return compareDateValue(value, expected) < 0;
    case 'after':
      return compareDateValue(value, expected) > 0;
    case 'on_or_before':
      return compareDateValue(value, expected) <= 0;
    case 'on_or_after':
      return compareDateValue(value, expected) >= 0;
    case 'within':
      return dateWithin(value, expected);
    case 'past_week':
      return relativeDate(value, now, -7, 0);
    case 'past_month':
      return relativeDate(value, now, -31, 0);
    case 'past_year':
      return relativeDate(value, now, -366, 0);
    case 'next_week':
      return relativeDate(value, now, 0, 7);
    case 'next_month':
      return relativeDate(value, now, 0, 31);
    case 'next_year':
      return relativeDate(value, now, 0, 366);
    case 'this_week':
      return relativeDate(value, now, -7, 7);
  }
}

function sortMaterializedRows(rows: MaterializedRow[], sorts: SortSpec[]): MaterializedRow[] {
  const manualSort: SortSpec = { kind: 'manual', direction: 'ascending' };
  const effectiveSorts: SortSpec[] = sorts.length === 0 ? [manualSort] : sorts;
  const withKeys = rows.map(row => ({
    row,
    keys: effectiveSorts.map(sort => sortKeyForRow(row, sort))
  }));
  withKeys.sort((left, right) => {
    for (let index = 0; index < effectiveSorts.length; index += 1) {
      const sort = effectiveSorts[index] ?? manualSort;
      const comparison = compareSortKey(left.keys[index] ?? null, right.keys[index] ?? null, sort);
      if (comparison !== 0) return comparison;
    }
    return compareTieBreakers(left.row, right.row);
  });
  return withKeys.map(item => {
    item.row.sortKeys = item.keys;
    return item.row;
  });
}

function sortKeyForRow(row: MaterializedRow, sort: SortSpec): SortKey {
  if (sort.kind === 'manual') return row.entry.order ?? '';
  if (sort.timestamp === 'created_time') return row.page.createdAt;
  if (sort.timestamp === 'last_edited_time') return row.page.lastEditedAt;
  if (sort.propertyId !== undefined) return propertySortKey(row.values[sort.propertyId]);
  return row.entry.order ?? '';
}

function compareSortKey(left: SortKey, right: SortKey, sort: Pick<SortSpec, 'direction' | 'emptyPlacement'>): number {
  const leftEmpty = left === null || left === '';
  const rightEmpty = right === null || right === '';
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    const placement = sort.emptyPlacement ?? 'auto';
    const emptyFirst = placement === 'first' || (placement === 'auto' && sort.direction === 'descending');
    return (leftEmpty ? -1 : 1) * (emptyFirst ? 1 : -1);
  }
  const base = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right));
  return sort.direction === 'descending' ? -base : base;
}

function compareTieBreakers(left: MaterializedRow, right: MaterializedRow): number {
  return (left.entry.order ?? '').localeCompare(right.entry.order ?? '')
    || left.page.createdAt.localeCompare(right.page.createdAt)
    || String(left.page.id).localeCompare(String(right.page.id));
}

function buildGroups(rows: MaterializedRow[], groupSpec: GroupSpec): QueryGroup[] {
  const groups = new Map<string, QueryGroup>();
  for (const row of rows) {
    const keys = groupKeysForValue(row.values[groupSpec.propertyId], groupSpec);
    const effectiveKeys = keys.length === 0 && !groupSpec.hideEmptyGroups ? [emptyGroupKey(row.values[groupSpec.propertyId])] : keys;
    row.groupKeys = effectiveKeys;
    for (const key of effectiveKeys) {
      const id = groupKeyId(key);
      const existing = groups.get(id);
      if (existing === undefined) {
        groups.set(id, { key, label: groupKeyLabel(key), rowPageIds: [row.page.id], totalKnown: 1 });
      } else {
        existing.rowPageIds.push(row.page.id);
        existing.totalKnown = existing.rowPageIds.length;
      }
    }
  }
  const sorted = [...groups.values()].sort((left, right) => groupKeyLabel(left.key).localeCompare(groupKeyLabel(right.key)));
  return groupSpec.direction === 'descending' ? sorted.reverse() : sorted;
}

function groupKeysForValue(value: PagePropertyValue | undefined, groupSpec: GroupSpec): GroupKey[] {
  if (value === undefined || propertyValueEmpty(value)) return [];
  switch (value.type) {
    case 'select':
      return [{ type: 'option', optionId: value.select?.id ?? null }];
    case 'status':
      return [{ type: 'option', optionId: value.status?.id ?? null }];
    case 'multi_select':
      return value.multiSelect.map(option => ({ type: 'option', optionId: option.id }));
    case 'checkbox':
      return [{ type: 'checkbox', checked: value.checkbox }];
    case 'date':
      return value.date === null ? [] : [dateBucketKey(value.date, groupSpec.dateGranularity ?? 'day')];
    case 'people':
      return value.people.map(userId => ({ type: 'person', userId }));
    case 'relation':
      return value.relation.map(reference => ({ type: 'relation', pageId: reference.pageId }));
    case 'number':
      return [{ type: 'value', value: value.number }];
    case 'formula':
      return computedGroupKeys(value.formula);
    case 'rollup':
      return computedGroupKeys(value.rollup);
    default:
      return [{ type: 'value', value: propertyDisplay(value) || null }];
  }
}

function computedGroupKeys(value: import('@plim/model').ComputedValue): GroupKey[] {
  switch (value.type) {
    case 'number':
      return [{ type: 'value', value: value.number }];
    case 'string':
      return [{ type: 'value', value: value.string }];
    case 'boolean':
      return [{ type: 'checkbox', checked: value.boolean }];
    case 'date':
      return value.date === null ? [] : [dateBucketKey(value.date, 'day')];
    case 'array':
      return value.array.flatMap(computedGroupKeys);
    case 'unsupported':
      return [{ type: 'value', value: null }];
  }
}

function toQueryRow(row: MaterializedRow, projectionIds: PropertyId[], projection: ProjectionSpec | undefined): QueryRow {
  const properties: Partial<Record<PropertyId, PagePropertyValue>> = {};
  for (const propertyId of projectionIds) {
    const value = row.values[propertyId];
    if (value !== undefined) properties[propertyId] = value;
  }
  if (projection?.includeTitle !== false) {
    const titleId = titlePropertyId(row.dataSource);
    if (titleId !== undefined && row.values[titleId] !== undefined) properties[titleId] = row.values[titleId];
  }
  return {
    pageId: row.page.id,
    dataSourceId: row.dataSource.id,
    orderKey: row.entry.order ?? '',
    title: row.title,
    properties,
    sortKeys: row.sortKeys,
    groupKeys: row.groupKeys
  };
}

function projectionPropertyIds(dataSource: DataSourceRecord, view: ViewRecord | undefined, projection: ProjectionSpec | undefined): PropertyId[] {
  if (projection?.propertyIds !== undefined) return projection.propertyIds;
  if (projection?.includeHidden) return dataSource.propertyOrder;
  if (view?.visiblePropertyIds !== undefined) return view.visiblePropertyIds;
  return dataSource.propertyOrder;
}

function searchRow(row: MaterializedRow, search: string, propertyIds: PropertyId[]): boolean {
  const tokens = tokenizeSearch(search);
  if (tokens.length === 0) return true;
  const haystack = normalizeForSearch([
    plainTextFromRichText(row.title),
    ...propertyIds.map(propertyId => propertyDisplay(row.values[propertyId]))
  ].join(' '));
  return tokens.every(token => haystack.includes(token));
}

function tokenizeSearch(search: string): string[] {
  return normalizeForSearch(search).split(/\s+/u).filter(Boolean);
}

function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('en-US').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function normalizedDisplay(value: PagePropertyValue | undefined): string {
  return normalizeForSearch(propertyDisplay(value));
}

function propertyValueEmpty(value: PagePropertyValue | undefined): boolean {
  if (value === undefined) return true;
  switch (value.type) {
    case 'title':
      return plainTextFromRichText(value.title).length === 0;
    case 'rich_text':
      return plainTextFromRichText(value.richText).length === 0;
    case 'number':
      return value.number === null;
    case 'select':
      return value.select === null;
    case 'multi_select':
      return value.multiSelect.length === 0;
    case 'status':
      return value.status === null;
    case 'date':
      return value.date === null;
    case 'formula':
      return computedEmpty(value.formula);
    case 'relation':
      return value.relation.length === 0;
    case 'rollup':
      return computedEmpty(value.rollup);
    case 'people':
      return value.people.length === 0;
    case 'files':
      return value.files.length === 0;
    case 'checkbox':
      return false;
    case 'url':
      return value.url === null || value.url.length === 0;
    case 'email':
      return value.email === null || value.email.length === 0;
    case 'phone_number':
      return value.phoneNumber === null || value.phoneNumber.length === 0;
    case 'created_time':
    case 'created_by':
    case 'last_edited_time':
    case 'last_edited_by':
    case 'unique_id':
      return false;
    case 'unsupported':
      return true;
  }
}

function computedEmpty(value: import('@plim/model').ComputedValue): boolean {
  switch (value.type) {
    case 'number':
      return value.number === null;
    case 'string':
      return value.string === null || value.string.length === 0;
    case 'boolean':
      return value.boolean === null;
    case 'date':
      return value.date === null;
    case 'array':
      return value.array.length === 0;
    case 'unsupported':
      return true;
  }
}

function propertyDisplay(value: PagePropertyValue | undefined): string {
  if (value === undefined) return '';
  switch (value.type) {
    case 'title':
      return plainTextFromRichText(value.title);
    case 'rich_text':
      return plainTextFromRichText(value.richText);
    case 'number':
      return value.number === null ? '' : String(value.number);
    case 'select':
      return value.select?.name ?? '';
    case 'multi_select':
      return value.multiSelect.map(option => option.name).join(', ');
    case 'status':
      return value.status?.name ?? '';
    case 'date':
      return value.date === null ? '' : dateDisplay(value.date);
    case 'formula':
      return computedDisplay(value.formula);
    case 'relation':
      return value.relation.map(reference => String(reference.pageId)).join(', ');
    case 'rollup':
      return computedDisplay(value.rollup);
    case 'people':
      return value.people.map(String).join(', ');
    case 'files':
      return value.files.map(file => file.type === 'external' ? file.name ?? file.url : file.type === 'data_url' ? file.name ?? file.mimeType ?? 'file' : String(file.fileId)).join(', ');
    case 'checkbox':
      return value.checkbox ? 'true' : 'false';
    case 'url':
      return value.url ?? '';
    case 'email':
      return value.email ?? '';
    case 'phone_number':
      return value.phoneNumber ?? '';
    case 'created_time':
      return value.createdTime;
    case 'created_by':
      return String(value.createdBy);
    case 'last_edited_time':
      return value.lastEditedTime;
    case 'last_edited_by':
      return String(value.lastEditedBy);
    case 'unique_id':
      return `${value.uniqueId.prefix ?? ''}${value.uniqueId.number}`;
    case 'unsupported':
      return '';
  }
}

function computedDisplay(value: import('@plim/model').ComputedValue): string {
  switch (value.type) {
    case 'number':
      return value.number === null ? '' : String(value.number);
    case 'string':
      return value.string ?? '';
    case 'boolean':
      return value.boolean === null ? '' : String(value.boolean);
    case 'date':
      return value.date === null ? '' : dateDisplay(value.date);
    case 'array':
      return value.array.map(computedDisplay).join(', ');
    case 'unsupported':
      return '';
  }
}

function dateDisplay(date: DateMention): string {
  return date.end === undefined ? String(date.start) : `${String(date.start)} ${String(date.end)}`;
}

function comparePropertyValue(value: PagePropertyValue | undefined, expected: JsonValue | undefined): number {
  return normalizeForSearch(propertyDisplay(value)).localeCompare(normalizeForSearch(jsonDisplay(expected)));
}

function containsPropertyValue(value: PagePropertyValue | undefined, expected: JsonValue | undefined): boolean {
  const expectedText = normalizeForSearch(jsonDisplay(expected));
  if (value?.type === 'multi_select') return value.multiSelect.some(option => normalizeForSearch(option.id).includes(expectedText) || normalizeForSearch(option.name).includes(expectedText));
  if (value?.type === 'people') return value.people.some(userId => normalizeForSearch(String(userId)).includes(expectedText));
  if (value?.type === 'relation') return value.relation.some(reference => normalizeForSearch(String(reference.pageId)).includes(expectedText));
  if (value?.type === 'files') return propertyDisplay(value).includes(jsonDisplay(expected));
  return normalizedDisplay(value).includes(expectedText);
}

function orderPropertyValue(value: PagePropertyValue | undefined, expected: JsonValue | undefined): number {
  const sortValue = propertySortKey(value);
  const expectedValue = jsonSortKey(expected);
  if (sortValue === null || expectedValue === null) return 0;
  if (typeof sortValue === 'number' && typeof expectedValue === 'number') return sortValue - expectedValue;
  return String(sortValue).localeCompare(String(expectedValue));
}

function compareDateValue(value: PagePropertyValue | undefined, expected: JsonValue | undefined): number {
  const left = dateMillis(propertyDate(value));
  const right = dateMillis(jsonDate(expected));
  if (left === null || right === null) return 0;
  return left - right;
}

function dateWithin(value: PagePropertyValue | undefined, expected: JsonValue | undefined): boolean {
  const left = dateMillis(propertyDate(value));
  if (left === null || !isRecord(expected)) return false;
  const start = typeof expected.start === 'string' ? dateMillis(expected.start) : null;
  const end = typeof expected.end === 'string' ? dateMillis(expected.end) : null;
  return (start === null || left >= start) && (end === null || left <= end);
}

function relativeDate(value: PagePropertyValue | undefined, now: string, startOffsetDays: number, endOffsetDays: number): boolean {
  const left = dateMillis(propertyDate(value));
  if (left === null) return false;
  const base = dateMillis(now);
  if (base === null) return false;
  const day = 86_400_000;
  return left >= base + startOffsetDays * day && left <= base + endOffsetDays * day;
}

function propertyDate(value: PagePropertyValue | undefined): string | undefined {
  if (value?.type === 'date') return value.date?.start;
  if (value?.type === 'created_time') return value.createdTime;
  if (value?.type === 'last_edited_time') return value.lastEditedTime;
  if (value?.type === 'formula' && value.formula.type === 'date') return value.formula.date?.start;
  if (value?.type === 'rollup' && value.rollup.type === 'date') return value.rollup.date?.start;
  return undefined;
}

function propertySortKey(value: PagePropertyValue | undefined): SortKey {
  if (value === undefined || propertyValueEmpty(value)) return null;
  switch (value.type) {
    case 'number':
      return value.number;
    case 'checkbox':
      return value.checkbox;
    case 'date':
      return value.date?.start ?? null;
    case 'created_time':
      return value.createdTime;
    case 'last_edited_time':
      return value.lastEditedTime;
    case 'unique_id':
      return value.uniqueId.number;
    case 'formula':
      return computedSortKey(value.formula);
    case 'rollup':
      return computedSortKey(value.rollup);
    default:
      return propertyDisplay(value);
  }
}

function computedSortKey(value: import('@plim/model').ComputedValue): SortKey {
  switch (value.type) {
    case 'number':
      return value.number;
    case 'string':
      return value.string;
    case 'boolean':
      return value.boolean;
    case 'date':
      return value.date?.start ?? null;
    case 'array':
      return value.array.map(computedDisplay).join(', ');
    case 'unsupported':
      return null;
  }
}

function jsonSortKey(value: JsonValue | undefined): SortKey {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

function jsonDisplay(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function jsonDate(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.start === 'string') return value.start;
  return undefined;
}

function dateMillis(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const dateOnly = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(dateOnly) ? null : dateOnly;
}

function titleForRow(dataSource: DataSourceRecord, page: PageRecord, values: Partial<Record<PropertyId, PagePropertyValue>>): RichText {
  const propertyId = titlePropertyId(dataSource);
  const value = propertyId === undefined ? undefined : values[propertyId];
  return value?.type === 'title' ? value.title : [{ type: 'text', text: { content: page.titlePlain }, plainText: page.titlePlain }];
}

function titlePropertyId(dataSource: DataSourceRecord): PropertyId | undefined {
  return dataSource.propertyOrder.find(propertyId => dataSource.properties[propertyId]?.type === 'title');
}

function firstViewGroup(view: ViewRecord | undefined): GroupSpec | undefined {
  const group = view?.groups?.[0];
  return group === undefined ? undefined : { propertyId: group.propertyId, ...(group.direction !== undefined ? { direction: group.direction } : {}) };
}

function viewSearchValue(view: ViewRecord | undefined): string | undefined {
  const search = view?.configuration.search;
  return typeof search === 'string' ? search : undefined;
}

function dateBucketKey(date: DateMention, granularity: NonNullable<GroupSpec['dateGranularity']>): GroupKey {
  const startDate = new Date(date.start);
  if (Number.isNaN(startDate.getTime())) return { type: 'value', value: String(date.start) };
  const start = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  if (granularity === 'week') start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  if (granularity === 'month') start.setUTCDate(1);
  if (granularity === 'quarter') {
    start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
  }
  if (granularity === 'year') start.setUTCMonth(0, 1);
  const end = new Date(start);
  if (granularity === 'day') end.setUTCDate(end.getUTCDate() + 1);
  else if (granularity === 'week') end.setUTCDate(end.getUTCDate() + 7);
  else if (granularity === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else if (granularity === 'quarter') end.setUTCMonth(end.getUTCMonth() + 3);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { type: 'date_bucket', start: start.toISOString(), end: end.toISOString(), granularity };
}

function emptyGroupKey(value: PagePropertyValue | undefined): GroupKey {
  if (value?.type === 'checkbox') return { type: 'checkbox', checked: null };
  if (value?.type === 'date') return { type: 'value', value: null };
  if (value?.type === 'people') return { type: 'person', userId: null };
  if (value?.type === 'relation') return { type: 'relation', pageId: null };
  if (value?.type === 'select' || value?.type === 'status' || value?.type === 'multi_select') return { type: 'option', optionId: null };
  return { type: 'value', value: null };
}

function groupKeyId(key: GroupKey): string {
  switch (key.type) {
    case 'option':
      return `option:${key.optionId ?? ''}`;
    case 'checkbox':
      return `checkbox:${key.checked === null ? '' : String(key.checked)}`;
    case 'date_bucket':
      return `date:${key.granularity}:${key.start}:${key.end}`;
    case 'person':
      return `person:${String(key.userId ?? '')}`;
    case 'relation':
      return `relation:${String(key.pageId ?? '')}`;
    case 'value':
      return `value:${String(key.value ?? '')}`;
  }
}

function groupKeyLabel(key: GroupKey): string {
  switch (key.type) {
    case 'option':
      return key.optionId ?? 'No value';
    case 'checkbox':
      return key.checked === null ? 'No value' : key.checked ? 'Checked' : 'Unchecked';
    case 'date_bucket':
      return key.start.slice(0, 10);
    case 'person':
      return key.userId === null ? 'No person' : String(key.userId);
    case 'relation':
      return key.pageId === null ? 'No relation' : String(key.pageId);
    case 'value':
      return key.value === null ? 'No value' : String(key.value);
  }
}

function createCursor(offset: number): string {
  return `offset:${offset.toString(36)}`;
}

function resolveOffset(cursor: string | undefined, offset: number | undefined): number {
  if (cursor?.startsWith('offset:')) {
    const parsed = Number.parseInt(cursor.slice('offset:'.length), 36);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return Math.max(0, offset ?? 0);
}

function buildDependencies(
  dataSource: DataSourceRecord,
  rows: MaterializedRow[],
  view: ViewRecord | undefined,
  input: DataSourceQueryInput,
  projectionIds: PropertyId[]
): QueryDependencySet {
  const propertyIds = new Set<PropertyId>(projectionIds);
  collectFilterProperties(input.filter, propertyIds);
  for (const sort of input.sorts ?? []) {
    if (sort.propertyId !== undefined) propertyIds.add(sort.propertyId);
  }
  if (input.groupBy !== undefined) propertyIds.add(input.groupBy.propertyId);
  const formulaPropertyIds: PropertyId[] = [];
  const relationPropertyIds: PropertyId[] = [];
  const rollupPropertyIds: PropertyId[] = [];
  for (const propertyId of propertyIds) {
    const property = dataSource.properties[propertyId];
    if (property?.config.type === 'formula') formulaPropertyIds.push(propertyId);
    if (property?.config.type === 'relation') relationPropertyIds.push(propertyId);
    if (property?.config.type === 'rollup') rollupPropertyIds.push(propertyId);
  }
  return {
    dataSourceId: dataSource.id,
    schemaVersion: dataSource.version,
    propertyIds: [...propertyIds],
    relationPropertyIds,
    formulaPropertyIds,
    rollupPropertyIds,
    pageIds: rows.map(row => row.page.id),
    ...(view?.id !== undefined ? { viewIds: [view.id] } : {})
  };
}

function collectFilterProperties(filter: FilterNode | undefined, out: Set<PropertyId>): void {
  if (filter === undefined) return;
  if (filter.type === 'property') {
    out.add(filter.propertyId);
    return;
  }
  if (filter.type === 'not') {
    collectFilterProperties(filter.filter, out);
    return;
  }
  filter.filters.forEach(child => collectFilterProperties(child, out));
}

interface MaterializedRow {
  entry: DataSourceEntry;
  page: PageRecord;
  dataSource: DataSourceRecord;
  title: RichText;
  values: Partial<Record<PropertyId, PagePropertyValue>>;
  sortKeys: SortKey[];
  groupKeys: GroupKey[];
  contextNow: string;
}
