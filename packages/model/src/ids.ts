import type {
  BlockId,
  CommentId,
  DataSourceId,
  DatabaseId,
  DiscussionId,
  FileId,
  IdKind,
  PageId,
  PropertyId,
  TransactionId,
  UserId,
  ViewId,
  WorkspaceId
} from './types.js';

export interface IdFactory {
  createId(kind?: IdKind): string;
}

export interface IdFactoryOptions {
  seed?: string;
  prefix?: string;
}

export function createIdFactory(options: IdFactoryOptions = {}): IdFactory {
  let counter = 0;
  const prefix = options.prefix ?? 'plim';
  const seed = options.seed;

  return {
    createId(kind: IdKind = 'block'): string {
      if (seed === undefined && typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
      counter += 1;
      const stableSeed = seed ?? 'local';
      return `${prefix}_${kind}_${stableSeed}_${counter.toString(36)}`;
    }
  };
}

export const defaultIdFactory = createIdFactory();

export function createRawId(kind: IdKind = 'block', factory: IdFactory = defaultIdFactory): string {
  return factory.createId(kind);
}

export const asWorkspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const asBlockId = (value: string): BlockId => value as BlockId;
export const asPageId = (value: string): PageId => value as PageId;
export const asDatabaseId = (value: string): DatabaseId => value as DatabaseId;
export const asDataSourceId = (value: string): DataSourceId => value as DataSourceId;
export const asViewId = (value: string): ViewId => value as ViewId;
export const asUserId = (value: string): UserId => value as UserId;
export const asCommentId = (value: string): CommentId => value as CommentId;
export const asDiscussionId = (value: string): DiscussionId => value as DiscussionId;
export const asFileId = (value: string): FileId => value as FileId;
export const asTransactionId = (value: string): TransactionId => value as TransactionId;
export const asPropertyId = (value: string): PropertyId => value as PropertyId;

export function createWorkspaceId(factory?: IdFactory): WorkspaceId { return asWorkspaceId(createRawId('workspace', factory)); }
export function createBlockId(factory?: IdFactory): BlockId { return asBlockId(createRawId('block', factory)); }
export function createPageId(factory?: IdFactory): PageId { return asPageId(createRawId('page', factory)); }
export function createDatabaseId(factory?: IdFactory): DatabaseId { return asDatabaseId(createRawId('database', factory)); }
export function createDataSourceId(factory?: IdFactory): DataSourceId { return asDataSourceId(createRawId('data_source', factory)); }
export function createViewId(factory?: IdFactory): ViewId { return asViewId(createRawId('view', factory)); }
export function createUserId(factory?: IdFactory): UserId { return asUserId(createRawId('user', factory)); }
export function createCommentId(factory?: IdFactory): CommentId { return asCommentId(createRawId('comment', factory)); }
export function createDiscussionId(factory?: IdFactory): DiscussionId { return asDiscussionId(createRawId('discussion', factory)); }
export function createFileId(factory?: IdFactory): FileId { return asFileId(createRawId('file', factory)); }
export function createTransactionId(factory?: IdFactory): TransactionId { return asTransactionId(createRawId('transaction', factory)); }
export function createPropertyId(factory?: IdFactory): PropertyId { return asPropertyId(createRawId('property', factory)); }
