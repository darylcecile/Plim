import { cloneDeep } from '@plim/model';
import type { ComputedValue, DataSourceRecord, DateMention, PageId, PagePropertyValue, PropertyId } from '@plim/model';
import {
  defaultFormulaContext,
  formulaValueFromProperty,
  formulaValueToComputedValue
} from './formula.js';
import type {
  ClientDatabaseState,
  ClientRollupFunction,
  FormulaValue,
  QueryDependencySet,
  RelationEdge,
  RelationGraph,
  RollupEvaluationResult
} from './types.js';

export function createRelationGraph(state: ClientDatabaseState): RelationGraph {
  const graph: RelationGraph = { edgesById: {}, outgoing: {}, incoming: {} };
  for (const dataSource of Object.values(state.dataSources)) {
    const relationPropertyIds = Object.values(dataSource.properties)
      .filter(property => property.config.type === 'relation')
      .map(property => property.id);
    for (const entry of Object.values(dataSource.entries)) {
      const page = state.pages[entry.pageId];
      if (page === undefined) continue;
      for (const propertyId of relationPropertyIds) {
        const value = page.properties[propertyId];
        if (value?.type !== 'relation') continue;
        value.relation.forEach((reference, index) => {
          const targetDataSourceId = reference.dataSourceId ?? state.pages[reference.pageId]?.dataSourceId ?? dataSource.id;
          const edge: RelationEdge = {
            id: relationEdgeId(entry.pageId, propertyId, reference.pageId, index),
            fromPageId: entry.pageId,
            fromDataSourceId: dataSource.id,
            fromPropertyId: propertyId,
            toPageId: reference.pageId,
            toDataSourceId: targetDataSourceId,
            orderKey: index.toString(36).padStart(6, '0')
          };
          insertRelationEdge(graph, edge);
        });
      }
    }
  }
  return graph;
}

export function getRelationEdges(graph: RelationGraph, pageId: PageId, propertyId?: PropertyId): RelationEdge[] {
  if (propertyId !== undefined) {
    return (graph.outgoing[pageId]?.[propertyId] ?? []).flatMap(edgeId => graph.edgesById[edgeId] === undefined ? [] : [graph.edgesById[edgeId]]);
  }
  const byProperty = graph.outgoing[pageId] ?? {};
  return Object.values(byProperty).flatMap(edgeIds => edgeIds.flatMap(edgeId => graph.edgesById[edgeId] === undefined ? [] : [graph.edgesById[edgeId]]));
}

export function getRelatedPageIds(state: ClientDatabaseState, pageId: PageId, propertyId: PropertyId, graph: RelationGraph = state.relationGraph ?? createRelationGraph(state)): PageId[] {
  const edgeTargets = getRelationEdges(graph, pageId, propertyId).map(edge => edge.toPageId);
  if (edgeTargets.length > 0) return edgeTargets;
  const relation = state.pages[pageId]?.properties[propertyId];
  return relation?.type === 'relation' ? relation.relation.map(reference => reference.pageId) : [];
}

export function setRelationTargets(
  state: ClientDatabaseState,
  dataSourceId: DataSourceRecord['id'],
  pageId: PageId,
  propertyId: PropertyId,
  targetPageIds: readonly PageId[]
): ClientDatabaseState {
  const dataSource = state.dataSources[dataSourceId];
  const page = state.pages[pageId];
  const property = dataSource?.properties[propertyId];
  if (dataSource === undefined || page === undefined || property?.config.type !== 'relation') {
    throw new Error('Cannot set relation for missing or non-relation property');
  }
  if (property.config.maxItems !== undefined && targetPageIds.length > property.config.maxItems) {
    throw new Error('Relation target count exceeds property limit');
  }
  const next = cloneDeep(state) as ClientDatabaseState;
  const nextPage = next.pages[pageId];
  if (nextPage === undefined) throw new Error('Page disappeared while setting relation');
  nextPage.properties[propertyId] = {
    id: propertyId,
    type: 'relation',
    relation: uniquePageIds(targetPageIds).map(targetPageId => ({
      pageId: targetPageId,
      ...(next.pages[targetPageId]?.dataSourceId ? { dataSourceId: next.pages[targetPageId]?.dataSourceId } : {})
    }))
  };
  nextPage.version += 1;
  if (property.config.dualProperty !== undefined) {
    applyDualRelation(next, pageId, propertyId, targetPageIds, property.config.dualProperty.propertyId);
  }
  next.relationGraph = createRelationGraph(next);
  return next;
}

export function evaluateRollup(
  state: ClientDatabaseState,
  dataSourceId: DataSourceRecord['id'],
  pageId: PageId,
  rollupPropertyId: PropertyId,
  graph: RelationGraph = state.relationGraph ?? createRelationGraph(state)
): RollupEvaluationResult {
  const dataSource = state.dataSources[dataSourceId];
  const rollupProperty = dataSource?.properties[rollupPropertyId];
  if (dataSource === undefined || rollupProperty?.config.type !== 'rollup') {
    return {
      value: { type: 'unsupported', raw: { reason: 'missing_rollup_property' } },
      dependencies: emptyRollupDependencies(dataSourceId)
    };
  }

  const relationPropertyId = rollupProperty.config.relationPropertyId;
  const targetPropertyId = rollupProperty.config.rollupPropertyId;
  const relatedPageIds = getRelatedPageIds(state, pageId, relationPropertyId, graph);
  const targetValues: FormulaValue[] = [];
  const context = defaultFormulaContext();
  for (const targetPageId of relatedPageIds) {
    const targetPage = state.pages[targetPageId];
    if (targetPage === undefined || targetPage.lifecycle === 'trashed' || targetPage.lifecycle === 'deleted') continue;
    targetValues.push(formulaValueFromProperty(targetPage.properties[targetPropertyId], state, targetPage.dataSourceId ?? dataSourceId, targetPageId, context));
  }

  const value = aggregateRollup(targetValues, rollupProperty.config.function as ClientRollupFunction);
  return {
    value,
    dependencies: {
      dataSourceId,
      schemaVersion: dataSource.version,
      propertyIds: uniquePropertyIds([relationPropertyId, targetPropertyId]),
      relationPropertyIds: [relationPropertyId],
      formulaPropertyIds: [],
      rollupPropertyIds: [rollupPropertyId],
      pageIds: uniquePageIds([pageId, ...relatedPageIds])
    }
  };
}

export function aggregateRollup(values: readonly FormulaValue[], rollupFunction: ClientRollupFunction): ComputedValue {
  const normalizedFunction = rollupFunction === 'count_all' ? 'count'
    : rollupFunction === 'count_not_empty' ? 'count_values'
      : rollupFunction;
  switch (normalizedFunction) {
    case 'show_original':
      return { type: 'array', array: values.map(formulaValueToComputedValue) };
    case 'show_unique':
      return { type: 'array', array: uniqueFormulaValues(values).map(formulaValueToComputedValue) };
    case 'count':
      return { type: 'number', number: values.length };
    case 'count_values':
      return { type: 'number', number: values.filter(value => !formulaValueEmpty(value)).length };
    case 'count_unique_values':
      return { type: 'number', number: uniqueFormulaValues(values.filter(value => !formulaValueEmpty(value))).length };
    case 'count_empty':
      return { type: 'number', number: values.filter(formulaValueEmpty).length };
    case 'sum':
      return { type: 'number', number: numericValues(values).reduce((total, value) => total + value, 0) };
    case 'average': {
      const numbers = numericValues(values);
      return { type: 'number', number: numbers.length === 0 ? null : numbers.reduce((total, value) => total + value, 0) / numbers.length };
    }
    case 'median': {
      const numbers = numericValues(values).sort((left, right) => left - right);
      if (numbers.length === 0) return { type: 'number', number: null };
      const mid = Math.floor(numbers.length / 2);
      const number = numbers.length % 2 === 0
        ? ((numbers[mid - 1] ?? 0) + (numbers[mid] ?? 0)) / 2
        : numbers[mid] ?? null;
      return { type: 'number', number };
    }
    case 'min':
      return minMaxComputed(values, 'min');
    case 'max':
      return minMaxComputed(values, 'max');
    case 'range': {
      const numbers = numericValues(values);
      return { type: 'number', number: numbers.length === 0 ? null : Math.max(...numbers) - Math.min(...numbers) };
    }
    case 'earliest_date':
      return boundaryDateComputed(values, 'min');
    case 'latest_date':
      return boundaryDateComputed(values, 'max');
    case 'date_range':
      return dateRangeComputed(values);
    case 'checked':
      return { type: 'number', number: values.filter(value => value.type === 'boolean' && value.value).length };
    case 'unchecked':
      return { type: 'number', number: values.filter(value => value.type === 'boolean' && !value.value).length };
    case 'percent_checked':
      return percentBoolean(values, true);
    case 'percent_unchecked':
      return percentBoolean(values, false);
    case 'percent_empty':
      return { type: 'number', number: values.length === 0 ? 0 : values.filter(formulaValueEmpty).length / values.length };
    case 'percent_not_empty':
      return { type: 'number', number: values.length === 0 ? 0 : values.filter(value => !formulaValueEmpty(value)).length / values.length };
  }
}

export function relationDependenciesForProperty(state: ClientDatabaseState, dataSourceId: DataSourceRecord['id'], propertyId: PropertyId): QueryDependencySet {
  const dataSource = state.dataSources[dataSourceId];
  return {
    dataSourceId,
    schemaVersion: dataSource?.version ?? 0,
    propertyIds: [propertyId],
    relationPropertyIds: [propertyId],
    formulaPropertyIds: [],
    rollupPropertyIds: [],
    pageIds: dataSource === undefined ? [] : Object.keys(dataSource.entries) as PageId[]
  };
}

function insertRelationEdge(graph: RelationGraph, edge: RelationEdge): void {
  graph.edgesById[edge.id] = edge;
  const outgoingByProperty = graph.outgoing[edge.fromPageId] ?? {};
  const outgoingForProperty = outgoingByProperty[edge.fromPropertyId] ?? [];
  outgoingByProperty[edge.fromPropertyId] = [...outgoingForProperty, edge.id];
  graph.outgoing[edge.fromPageId] = outgoingByProperty;
  graph.incoming[edge.toPageId] = [...(graph.incoming[edge.toPageId] ?? []), edge.id];
}

function relationEdgeId(fromPageId: PageId, propertyId: PropertyId, toPageId: PageId, index: number): string {
  return `rel:${String(fromPageId)}:${String(propertyId)}:${String(toPageId)}:${index.toString(36)}`;
}

function uniquePageIds(values: readonly PageId[]): PageId[] {
  const seen = new Set<string>();
  const result: PageId[] = [];
  for (const value of values) {
    const key = String(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function uniquePropertyIds(values: readonly PropertyId[]): PropertyId[] {
  const seen = new Set<string>();
  const result: PropertyId[] = [];
  for (const value of values) {
    const key = String(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function applyDualRelation(next: ClientDatabaseState, sourcePageId: PageId, sourcePropertyId: PropertyId, targetPageIds: readonly PageId[], dualPropertyId: PropertyId): void {
  const targetSet = new Set(targetPageIds.map(String));
  for (const page of Object.values(next.pages)) {
    const current = page.properties[dualPropertyId];
    if (current?.type !== 'relation') continue;
    const withoutSource = current.relation.filter(reference => String(reference.pageId) !== String(sourcePageId));
    if (targetSet.has(String(page.id))) {
      page.properties[dualPropertyId] = {
        id: dualPropertyId,
        type: 'relation',
        relation: [...withoutSource, { pageId: sourcePageId, ...(next.pages[sourcePageId]?.dataSourceId ? { dataSourceId: next.pages[sourcePageId]?.dataSourceId } : {}) }]
      };
    } else if (withoutSource.length !== current.relation.length) {
      page.properties[dualPropertyId] = { id: dualPropertyId, type: 'relation', relation: withoutSource };
    }
  }
  void sourcePropertyId;
}

function emptyRollupDependencies(dataSourceId: DataSourceRecord['id']): QueryDependencySet {
  return {
    dataSourceId,
    schemaVersion: 0,
    propertyIds: [],
    relationPropertyIds: [],
    formulaPropertyIds: [],
    rollupPropertyIds: []
  };
}

function formulaValueEmpty(value: FormulaValue): boolean {
  switch (value.type) {
    case 'null':
      return true;
    case 'string':
      return value.value.length === 0;
    case 'list':
      return value.items.length === 0;
    case 'number':
    case 'boolean':
    case 'date':
    case 'person':
    case 'page':
    case 'file':
    case 'error':
      return false;
  }
}

function uniqueFormulaValues(values: readonly FormulaValue[]): FormulaValue[] {
  const seen = new Set<string>();
  const result: FormulaValue[] = [];
  for (const value of values) {
    const key = formulaIdentity(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function formulaIdentity(value: FormulaValue): string {
  switch (value.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return `boolean:${String(value.value)}`;
    case 'number':
      return `number:${String(value.value)}`;
    case 'string':
      return `string:${value.value}`;
    case 'date':
      return `date:${value.value.start}:${value.value.end ?? ''}`;
    case 'person':
      return `person:${String(value.userId)}`;
    case 'page':
      return `page:${String(value.pageId)}`;
    case 'file':
      return `file:${JSON.stringify(value.file)}`;
    case 'list':
      return `list:${value.items.map(formulaIdentity).join('|')}`;
    case 'error':
      return `error:${value.error.code}:${value.error.message}`;
  }
}

function numericValues(values: readonly FormulaValue[]): number[] {
  return values.flatMap(value => value.type === 'number' ? [value.value] : []);
}

function dateValues(values: readonly FormulaValue[]): DateMention[] {
  return values.flatMap(value => value.type === 'date' ? [value.value] : []);
}

function minMaxComputed(values: readonly FormulaValue[], boundary: 'min' | 'max'): ComputedValue {
  const numbers = numericValues(values);
  if (numbers.length > 0) return { type: 'number', number: boundary === 'min' ? Math.min(...numbers) : Math.max(...numbers) };
  const dates = dateValues(values);
  if (dates.length > 0) return boundaryDateComputed(values, boundary);
  const strings = values.flatMap(value => value.type === 'string' && value.value.length > 0 ? [value.value] : []);
  if (strings.length === 0) return { type: 'string', string: null };
  strings.sort();
  return { type: 'string', string: boundary === 'min' ? strings[0] ?? null : strings[strings.length - 1] ?? null };
}

function boundaryDateComputed(values: readonly FormulaValue[], boundary: 'min' | 'max'): ComputedValue {
  const dates = dateValues(values);
  if (dates.length === 0) return { type: 'date', date: null };
  const sorted = [...dates].sort((left, right) => dateMillis(left.start) - dateMillis(right.start));
  return { type: 'date', date: boundary === 'min' ? sorted[0] ?? null : sorted[sorted.length - 1] ?? null };
}

function dateRangeComputed(values: readonly FormulaValue[]): ComputedValue {
  const dates = dateValues(values);
  if (dates.length === 0) return { type: 'date', date: null };
  const starts = dates.map(date => date.start).sort((left, right) => dateMillis(left) - dateMillis(right));
  const ends = dates.map(date => date.end ?? date.start).sort((left, right) => dateMillis(left) - dateMillis(right));
  const start = starts[0];
  const end = ends[ends.length - 1];
  return start === undefined ? { type: 'date', date: null } : { type: 'date', date: end === undefined || end === start ? { start } : { start, end } };
}

function percentBoolean(values: readonly FormulaValue[], checked: boolean): ComputedValue {
  const booleans = values.flatMap(value => value.type === 'boolean' ? [value.value] : []);
  return { type: 'number', number: booleans.length === 0 ? 0 : booleans.filter(value => value === checked).length / booleans.length };
}

function dateMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.parse(`${value}T00:00:00.000Z`) : parsed;
}
