import { describe, expect, it } from 'vitest';
import {
	MemoryBus,
	createMemoryTransportPair,
	mapTransport,
	WebSocketTransport,
	type WebSocketCtor,
	type WebSocketLike,
	type WebSocketStatus,
} from '@plim/transports';

describe('createMemoryTransportPair', () => {
	it('delivers a message from one endpoint to the other, not back to the sender', () => {
		const [a, b] = createMemoryTransportPair<string>();
		const aSeen: string[] = [];
		const bSeen: string[] = [];
		a.onMessage((m) => aSeen.push(m));
		b.onMessage((m) => bSeen.push(m));

		a.send('hello');
		b.send('world');

		expect(bSeen).toEqual(['hello']);
		expect(aSeen).toEqual(['world']);
	});

	it('stops delivering after close', () => {
		const [a, b] = createMemoryTransportPair<number>();
		const seen: number[] = [];
		b.onMessage((m) => seen.push(m));
		a.send(1);
		b.close();
		a.send(2);
		expect(seen).toEqual([1]);
	});

	it('throws when sending on a closed transport', () => {
		const [a] = createMemoryTransportPair<number>();
		a.close();
		expect(() => a.send(1)).toThrow(/closed/);
	});
});

describe('MemoryBus', () => {
	it('broadcasts to all other endpoints', () => {
		const bus = new MemoryBus<string>();
		const a = bus.connect();
		const b = bus.connect();
		const c = bus.connect();
		const bSeen: string[] = [];
		const cSeen: string[] = [];
		const aSeen: string[] = [];
		a.onMessage((m) => aSeen.push(m));
		b.onMessage((m) => bSeen.push(m));
		c.onMessage((m) => cSeen.push(m));

		a.send('x');
		expect(bSeen).toEqual(['x']);
		expect(cSeen).toEqual(['x']);
		expect(aSeen).toEqual([]);
		expect(bus.size).toBe(3);
	});

	it('preserves FIFO order even when a handler sends during dispatch', () => {
		const bus = new MemoryBus<number>();
		const a = bus.connect();
		const b = bus.connect();
		const order: number[] = [];
		b.onMessage((m) => {
			order.push(m);
			if (m === 1) a.send(2); // re-entrant send must be queued, not nested
		});
		a.send(1);
		expect(order).toEqual([1, 2]);
	});

	it('unsubscribes a single handler without affecting others', () => {
		const bus = new MemoryBus<string>();
		const a = bus.connect();
		const b = bus.connect();
		const seen: string[] = [];
		const off = b.onMessage((m) => seen.push(`one:${m}`));
		b.onMessage((m) => seen.push(`two:${m}`));
		a.send('a');
		off();
		a.send('b');
		expect(seen).toEqual(['one:a', 'two:a', 'two:b']);
	});
});

describe('mapTransport', () => {
	it('encodes outbound and decodes inbound through the codec', () => {
		const [rawA, rawB] = createMemoryTransportPair<string>();
		const a = mapTransport<string, { n: number }>(
			rawA,
			(msg) => JSON.stringify(msg),
			(raw) => JSON.parse(raw) as { n: number },
		);
		const b = mapTransport<string, { n: number }>(
			rawB,
			(msg) => JSON.stringify(msg),
			(raw) => JSON.parse(raw) as { n: number },
		);
		const seen: number[] = [];
		b.onMessage((m) => seen.push(m.n));
		a.send({ n: 42 });
		expect(seen).toEqual([42]);
	});
});

// ---- A deterministic fake WebSocket to exercise the reconnect logic ----------

class FakeWebSocket implements WebSocketLike {
	static OPEN = 1 as const;
	static readonly instances: FakeWebSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	// test helpers
	emitOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.fire('open', {});
	}
	emitMessage(data: unknown): void {
		this.fire('message', { data });
	}
	emitClose(): void {
		this.readyState = 3;
		this.fire('close', {});
	}
	private fire(type: string, event: unknown): void {
		for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
	}
}

describe('WebSocketTransport', () => {
	it('buffers sends while down and flushes them on open', () => {
		FakeWebSocket.instances.length = 0;
		const transport = new WebSocketTransport<{ hi: string }>('ws://x', {
			WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
		});
		transport.send({ hi: 'a' });
		transport.send({ hi: 'b' });
		const socket = FakeWebSocket.instances[0]!;
		expect(socket.sent).toEqual([]); // not open yet

		socket.emitOpen();
		expect(socket.sent).toEqual([JSON.stringify({ hi: 'a' }), JSON.stringify({ hi: 'b' })]);
	});

	it('parses inbound JSON frames and dispatches to handlers', () => {
		FakeWebSocket.instances.length = 0;
		const transport = new WebSocketTransport<{ n: number }>('ws://x', {
			WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
		});
		const seen: number[] = [];
		transport.onMessage((m) => seen.push(m.n));
		const socket = FakeWebSocket.instances[0]!;
		socket.emitOpen();
		socket.emitMessage(JSON.stringify({ n: 7 }));
		expect(seen).toEqual([7]);
	});

	it('reconnects with backoff after an unexpected close and reports status', () => {
		FakeWebSocket.instances.length = 0;
		const statuses: WebSocketStatus[] = [];
		let pending: (() => void) | null = null;
		const transport = new WebSocketTransport('ws://x', {
			WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
			onStatus: (s) => statuses.push(s),
			setTimeoutImpl: (handler) => {
				pending = handler;
				return 1;
			},
			clearTimeoutImpl: () => {
				pending = null;
			},
		});
		const first = FakeWebSocket.instances[0]!;
		first.emitOpen();
		first.emitClose(); // unexpected drop → should schedule a reconnect
		expect(pending).toBeTypeOf('function');
		pending!(); // fire the backoff timer
		expect(FakeWebSocket.instances.length).toBe(2); // a new socket was created
		expect(statuses).toContain('connecting');
		expect(statuses).toContain('open');
		transport.close();
	});

	it('does not reconnect after the user closes it', () => {
		FakeWebSocket.instances.length = 0;
		let pending: (() => void) | null = null;
		const transport = new WebSocketTransport('ws://x', {
			WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
			setTimeoutImpl: (handler) => {
				pending = handler;
				return 1;
			},
		});
		const socket = FakeWebSocket.instances[0]!;
		socket.emitOpen();
		transport.close();
		socket.emitClose();
		expect(pending).toBeNull();
		expect(transport.connectionStatus).toBe('closed');
		expect(() => transport.send('x')).toThrow(/closed/);
	});
});
