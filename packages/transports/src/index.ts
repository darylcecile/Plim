// @plim/transports — tiny, generic duplex-channel primitives. Write your sync
// code against `Transport<T>` and pick a wire: in-process loopback, cross-tab
// BroadcastChannel, or a reconnecting WebSocket.

export type { Transport } from './transport.js';
export { mapTransport } from './transport.js';

export type { MemoryBusOptions } from './memory.js';
export { MemoryBus, createMemoryTransportPair } from './memory.js';

export type { BroadcastChannelLike, BroadcastChannelTransportOptions } from './broadcast-channel.js';
export { BroadcastChannelTransport } from './broadcast-channel.js';

export type { WebSocketStatus, WebSocketLike, WebSocketCtor, WebSocketTransportOptions } from './websocket.js';
export { WebSocketTransport } from './websocket.js';
