import { cloneDeep } from '@plim/model';
import type { PersistedSnapshot, PersistenceAdapter, PersistenceWatchEvent } from './types.js';

export interface MemoryPersistenceAdapterOptions {
  readonly id?: string;
  readonly initial?: Readonly<Record<string, PersistedSnapshot>>;
}

export function createMemoryPersistenceAdapter(options: MemoryPersistenceAdapterOptions = {}): PersistenceAdapter {
  const snapshots = new Map<string, PersistedSnapshot>();
  const watchers = new Map<string, Set<(event: PersistenceWatchEvent) => void>>();
  for (const [key, snapshot] of Object.entries(options.initial ?? {})) {
    snapshots.set(key, cloneDeep(snapshot) as PersistedSnapshot);
  }

  const notify = (event: PersistenceWatchEvent): void => {
    for (const watcher of watchers.get(event.key) ?? []) watcher(event);
  };

  return {
    id: options.id ?? 'memory',
    capabilities: { durable: false, async: true, supportsTransactions: false, supportsBroadcast: false },
    async load(key) {
      const snapshot = snapshots.get(key);
      return snapshot ? cloneDeep(snapshot) as PersistedSnapshot : null;
    },
    async save(key, snapshot) {
      const persisted = cloneDeep({ ...snapshot, persistenceKey: key }) as PersistedSnapshot;
      snapshots.set(key, persisted);
      notify({ key, snapshot: cloneDeep(persisted) as PersistedSnapshot, source: 'save' });
    },
    async remove(key) {
      snapshots.delete(key);
      notify({ key, snapshot: null, source: 'remove' });
    },
    watch(key, cb) {
      const current = watchers.get(key) ?? new Set<(event: PersistenceWatchEvent) => void>();
      current.add(cb);
      watchers.set(key, current);
      return () => {
        const existing = watchers.get(key);
        existing?.delete(cb);
        if (existing?.size === 0) watchers.delete(key);
      };
    },
    async flush() {
      return undefined;
    }
  };
}
