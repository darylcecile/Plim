import { describe, expect, it } from 'vitest';
import { type Peer, PresenceTracker } from '@plim/collaboration';

const alice: Peer = { id: 'alice', name: 'Alice' };
const bob: Peer = { id: 'bob', name: 'Bob' };
const carol: Peer = { id: 'carol' };

function sel(offset: number) {
	return { anchor: { path: [0], offset }, head: { path: [0], offset } };
}

describe('PresenceTracker — local state', () => {
	it('bumps a monotonic clock on every local change and returns the broadcast', () => {
		const t = new PresenceTracker(alice);
		const a = t.setLocal({ status: 'editing' });
		const b = t.patchLocal({ selection: sel(3) });
		expect(a.clock).toBe(1);
		expect(b.clock).toBe(2);
		expect(b.peer).toBe(alice);
		expect(b.state).toEqual({ status: 'editing', selection: sel(3) });
	});

	it('clones state so later mutation of the broadcast does not leak back in', () => {
		const t = new PresenceTracker(alice);
		const input = { selection: sel(1) };
		t.setLocal(input);
		input.selection.head.offset = 99;
		expect(t.local.state).toEqual({ selection: sel(1) });
	});
});

describe('PresenceTracker — remote integration', () => {
	it('emits join then update, and exposes remote peers', () => {
		const t = new PresenceTracker(alice);
		const events: string[] = [];
		t.onChange((e) => events.push(`${e.kind}:${e.peerId}`));

		expect(t.applyRemote({ peer: bob, state: { selection: sel(2) }, clock: 1 })).toBe(true);
		expect(t.applyRemote({ peer: bob, state: { selection: sel(5) }, clock: 2 })).toBe(true);

		expect(events).toEqual(['join:bob', 'update:bob']);
		expect(t.get('bob')?.state).toEqual({ selection: sel(5) });
		expect(t.remotePeers()).toHaveLength(1);
		expect(t.allPeers().map((p) => p.peer.id).sort()).toEqual(['alice', 'bob']);
	});

	it('drops stale or duplicate updates by clock', () => {
		const t = new PresenceTracker(alice);
		t.applyRemote({ peer: bob, state: { selection: sel(5) }, clock: 5 });
		expect(t.applyRemote({ peer: bob, state: { selection: sel(1) }, clock: 5 })).toBe(false);
		expect(t.applyRemote({ peer: bob, state: { selection: sel(1) }, clock: 3 })).toBe(false);
		expect(t.get('bob')?.state).toEqual({ selection: sel(5) });
	});

	it('ignores echoes of the local peer', () => {
		const t = new PresenceTracker(alice);
		expect(t.applyRemote({ peer: alice, state: { selection: sel(1) }, clock: 1 })).toBe(false);
		expect(t.size).toBe(0);
	});

	it('removes a peer and emits leave', () => {
		const t = new PresenceTracker(alice);
		const events: string[] = [];
		t.applyRemote({ peer: bob, state: {}, clock: 1 });
		t.onChange((e) => events.push(e.kind));
		expect(t.remove('bob')).toBe(true);
		expect(t.remove('bob')).toBe(false);
		expect(events).toEqual(['leave']);
		expect(t.size).toBe(0);
	});
});

describe('PresenceTracker — pruning', () => {
	it('drops peers not seen within ttlMs', () => {
		let clock = 1000;
		const now = () => clock;
		const t = new PresenceTracker(alice, { now, ttlMs: 100 });
		t.applyRemote({ peer: bob, state: {}, clock: 1 });
		clock = 1050;
		t.applyRemote({ peer: carol, state: {}, clock: 1 });
		clock = 1120; // bob is 120ms stale (> 100), carol is 70ms (<= 100)
		const dropped = t.prune();
		expect(dropped).toEqual(['bob']);
		expect(t.has('carol')).toBe(true);
	});

	it('never prunes when ttlMs is 0', () => {
		const t = new PresenceTracker(alice, { now: () => 0, ttlMs: 0 });
		t.applyRemote({ peer: bob, state: {}, clock: 1 });
		expect(t.prune(1_000_000)).toEqual([]);
		expect(t.has('bob')).toBe(true);
	});
});
