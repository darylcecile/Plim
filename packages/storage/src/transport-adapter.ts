import type { Transport } from '@plim/transports';
import type { StorageAdapter } from './adapter.js';

export type StorageTransportSaveMessage = {
type: 'save';
key: string;
value: string;
};

export type StorageTransportLoadMessage = {
type: 'load';
key: string;
id: string;
};

export type StorageTransportLoadedMessage = {
type: 'loaded';
key: string;
id: string;
value: string | null;
};

export type StorageTransportRemoveMessage = {
type: 'remove';
key: string;
};

export type StorageTransportMessage =
| StorageTransportSaveMessage
| StorageTransportLoadMessage
| StorageTransportLoadedMessage
| StorageTransportRemoveMessage;

export interface TransportAdapterOptions {
timeoutMs?: number;
requestId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createTransportAdapter(
transport: Transport<StorageTransportMessage>,
options: TransportAdapterOptions = {},
): StorageAdapter {
const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const requestId = options.requestId ?? defaultRequestId;

return {
async load(key) {
const id = requestId();
return new Promise<string | null>((resolve, reject) => {
let settled = false;
let unsubscribe = (): void => {};
const timer = setTimeout(() => {
if (settled) return;
settled = true;
unsubscribe();
reject(new Error(`@plim/storage: timed out loading "${key}" over transport after ${timeoutMs}ms`));
}, timeoutMs);
unsubscribe = transport.onMessage((message) => {
if (message.type !== 'loaded' || message.id !== id || message.key !== key) return;
if (settled) return;
settled = true;
clearTimeout(timer);
unsubscribe();
resolve(message.value);
});
transport.send({ type: 'load', key, id });
});
},
async save(key, value) {
transport.send({ type: 'save', key, value });
},
async remove(key) {
transport.send({ type: 'remove', key });
},
};
}

function defaultRequestId(): string {
return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
