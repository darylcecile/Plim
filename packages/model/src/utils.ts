import type { DeepPartial, JsonObject, JsonValue } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn<T extends string>(value: Record<string, unknown>, key: T): value is Record<T, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function cloneDeep<T>(value: T): T {
  const structuredCloneFn = globalThis.structuredClone as ((input: unknown) => unknown) | undefined;
  if (typeof structuredCloneFn === 'function') {
    return structuredCloneFn(value) as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (patch === undefined) return cloneDeep(base);
  if (Array.isArray(base) || Array.isArray(patch) || !isRecord(base) || !isRecord(patch)) {
    return cloneDeep(patch as T);
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const baseValue = result[key];
    result[key] = isRecord(baseValue) && isRecord(patchValue)
      ? deepMerge(baseValue, patchValue as DeepPartial<typeof baseValue>)
      : cloneDeep(patchValue);
  }
  return result as T;
}

export function uniqueStable<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const next: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      next.push(value);
    }
  }
  return next;
}

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) sorted[key] = sortJsonValue(child);
  }
  return sorted;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}

export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const json = toJsonValue(child);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const json = toJsonValue(item);
      if (json !== undefined) items.push(json);
    }
    return items;
  }
  if (isRecord(value)) return toJsonObject(value);
  return undefined;
}

export function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child;
  }
  return out as T;
}
