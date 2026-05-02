import type { BlockRecord, DataSourceId, DatabaseId, ViewId } from '@plim/model';
import { queryDataSource } from './query.js';
import type {
  ClientDatabaseState,
  DatabaseViewBlockQueryInput,
  DatabaseViewBlockQueryOverrides,
  DataSourceQueryInput,
  DataSourceQueryResult
} from './types.js';

export function queryInputFromView(state: ClientDatabaseState, viewId: ViewId, overrides: DatabaseViewBlockQueryOverrides = {}): DataSourceQueryInput {
  const view = state.views[viewId];
  if (view === undefined || view.dataSourceId === undefined) {
    throw new Error(`Cannot query missing or multi-source view ${String(viewId)}`);
  }
  return {
    dataSourceId: view.dataSourceId,
    viewId,
    ...(overrides.filter !== undefined ? { filter: overrides.filter } : {}),
    ...(overrides.sorts !== undefined ? { sorts: overrides.sorts } : {}),
    ...(overrides.search !== undefined ? { search: overrides.search } : {}),
    ...(overrides.projection !== undefined ? { projection: overrides.projection } : {}),
    ...(overrides.window !== undefined ? { window: overrides.window } : {}),
    ...(overrides.includeTrashed !== undefined ? { includeTrashed: overrides.includeTrashed } : {}),
    ...(overrides.includeComputed !== undefined ? { includeComputed: overrides.includeComputed } : {}),
    ...(overrides.formulaContext !== undefined ? { formulaContext: overrides.formulaContext } : {})
  };
}

export function queryInputFromDatabaseViewBlock(
  state: ClientDatabaseState,
  block: BlockRecord<'database_view'> | BlockRecord<'child_database'>,
  overrides: DatabaseViewBlockQueryOverrides = {}
): DatabaseViewBlockQueryInput {
  if (block.type === 'database_view') {
    const data = block.data;
    const view = state.views[data.viewId];
    const dataSourceId = data.dataSourceId || view?.dataSourceId || firstDataSourceForDatabase(state, data.databaseId);
    if (dataSourceId === undefined) throw new Error(`Database view block ${String(block.id)} has no data source`);
    const query: DataSourceQueryInput = {
      dataSourceId,
      viewId: data.viewId,
      ...(overrides.filter !== undefined ? { filter: overrides.filter } : {}),
      ...(overrides.sorts !== undefined ? { sorts: overrides.sorts } : {}),
      ...(overrides.search !== undefined ? { search: overrides.search } : {}),
      ...(overrides.projection !== undefined ? { projection: overrides.projection } : {}),
      ...(overrides.window !== undefined ? { window: overrides.window } : {}),
      ...(overrides.includeTrashed !== undefined ? { includeTrashed: overrides.includeTrashed } : {}),
      ...(overrides.includeComputed !== undefined ? { includeComputed: overrides.includeComputed } : {}),
      ...(overrides.formulaContext !== undefined ? { formulaContext: overrides.formulaContext } : {})
    };
    return {
      blockId: block.id,
      databaseId: data.databaseId,
      dataSourceId,
      viewId: data.viewId,
      linked: Boolean(block.extensions?.linked),
      query
    };
  }

  const databaseId = block.data.databaseId;
  const dataSourceId = firstDataSourceForDatabase(state, databaseId);
  if (dataSourceId === undefined) throw new Error(`Child database block ${String(block.id)} has no data source`);
  const viewId = firstViewForDatabase(state, databaseId);
  const query: DataSourceQueryInput = {
    dataSourceId,
    ...(viewId !== undefined ? { viewId } : {}),
    ...(overrides.filter !== undefined ? { filter: overrides.filter } : {}),
    ...(overrides.sorts !== undefined ? { sorts: overrides.sorts } : {}),
    ...(overrides.search !== undefined ? { search: overrides.search } : {}),
    ...(overrides.projection !== undefined ? { projection: overrides.projection } : {}),
    ...(overrides.window !== undefined ? { window: overrides.window } : {}),
    ...(overrides.includeTrashed !== undefined ? { includeTrashed: overrides.includeTrashed } : {}),
    ...(overrides.includeComputed !== undefined ? { includeComputed: overrides.includeComputed } : {}),
    ...(overrides.formulaContext !== undefined ? { formulaContext: overrides.formulaContext } : {})
  };
  return {
    blockId: block.id,
    databaseId,
    dataSourceId,
    ...(viewId !== undefined ? { viewId } : {}),
    linked: false,
    query
  };
}

export function queryDatabaseViewBlock(
  state: ClientDatabaseState,
  block: BlockRecord<'database_view'> | BlockRecord<'child_database'>,
  overrides: DatabaseViewBlockQueryOverrides = {}
): DataSourceQueryResult {
  return queryDataSource(state, queryInputFromDatabaseViewBlock(state, block, overrides).query);
}

export function linkedViewQueryInput(
  sourceDataSourceId: DataSourceId,
  databaseId: DatabaseId,
  localViewId: ViewId,
  overrides: DatabaseViewBlockQueryOverrides = {}
): DatabaseViewBlockQueryInput {
  const query: DataSourceQueryInput = {
    dataSourceId: sourceDataSourceId,
    viewId: localViewId,
    ...(overrides.filter !== undefined ? { filter: overrides.filter } : {}),
    ...(overrides.sorts !== undefined ? { sorts: overrides.sorts } : {}),
    ...(overrides.search !== undefined ? { search: overrides.search } : {}),
    ...(overrides.projection !== undefined ? { projection: overrides.projection } : {}),
    ...(overrides.window !== undefined ? { window: overrides.window } : {}),
    ...(overrides.includeTrashed !== undefined ? { includeTrashed: overrides.includeTrashed } : {}),
    ...(overrides.includeComputed !== undefined ? { includeComputed: overrides.includeComputed } : {}),
    ...(overrides.formulaContext !== undefined ? { formulaContext: overrides.formulaContext } : {})
  };
  return {
    blockId: localViewId as unknown as BlockRecord['id'],
    databaseId,
    dataSourceId: sourceDataSourceId,
    viewId: localViewId,
    linked: true,
    query
  };
}

function firstDataSourceForDatabase(state: ClientDatabaseState, databaseId: DatabaseId): DataSourceId | undefined {
  return state.databases[databaseId]?.dataSourceIds[0];
}

function firstViewForDatabase(state: ClientDatabaseState, databaseId: DatabaseId): ViewId | undefined {
  return state.databases[databaseId]?.viewIds[0];
}
