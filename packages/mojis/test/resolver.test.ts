import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MOJIS,
	createMojiCache,
	createMojiResolver,
	normalizeMojis,
	type MojiDefinition,
} from '@plim/mojis';

// Flush all pending microtasks (the async cache's fetch chain + its coalesced
// `onResolved` notification). A single macrotask tick drains the microtask
// queue, including chains enqueued while draining.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('DEFAULT_MOJIS', () => {
	it('includes the shortcodes used in the docs/examples', () => {
		const slugs = new Set(DEFAULT_MOJIS.map((d) => d.slug));
		expect(slugs.has('smile')).toBe(true);
		expect(slugs.has('moon')).toBe(true);
	});

	it('every default carries a renderable char or src', () => {
		for (const d of DEFAULT_MOJIS) {
			expect(Boolean(d.char || d.src)).toBe(true);
		}
	});
});

describe('normalizeMojis', () => {
	it('passes through an array, lowercasing slugs', () => {
		const out = normalizeMojis([{ slug: 'ShipIt', char: '🚀' }]);
		expect(out).toEqual([{ slug: 'shipit', char: '🚀' }]);
	});

	it('accepts a record of slug -> definition', () => {
		const out = normalizeMojis({ Plim: { src: 'https://x/y.svg', label: 'Plim' } });
		expect(out).toEqual([{ slug: 'plim', src: 'https://x/y.svg', label: 'Plim' }]);
	});

	it('treats a bare string value as a native glyph', () => {
		const out = normalizeMojis({ shipit: '🚀' });
		expect(out).toEqual([{ slug: 'shipit', char: '🚀' }]);
	});

	it('drops entries without a usable slug and returns [] for undefined', () => {
		expect(normalizeMojis()).toEqual([]);
		expect(normalizeMojis([{ slug: '', char: 'x' } as MojiDefinition])).toEqual([]);
	});
});

describe('createMojiResolver', () => {
	it('resolves a built-in default case-insensitively', () => {
		const resolve = createMojiResolver();
		expect(resolve('moon')?.char).toBe('🌑');
		expect(resolve('MOON')?.char).toBe('🌑');
		expect(resolve('smile')?.char).toBe('😄');
	});

	it('returns null for unknown slugs (so 10:30: / http:// are safe)', () => {
		const resolve = createMojiResolver();
		expect(resolve('nope')).toBeNull();
		expect(resolve('30')).toBeNull();
	});

	it('lets custom mojis override and extend the defaults', () => {
		const resolve = createMojiResolver({ mojis: { moon: '🌝', partyparrot: { src: 'p.gif' } } });
		expect(resolve('moon')?.char).toBe('🌝'); // overridden
		expect(resolve('partyparrot')?.src).toBe('p.gif'); // added
		expect(resolve('smile')?.char).toBe('😄'); // default still present
	});

	it('can opt out of the defaults', () => {
		const resolve = createMojiResolver({ includeDefaults: false, mojis: { moon: '🌝' } });
		expect(resolve('moon')?.char).toBe('🌝');
		expect(resolve('smile')).toBeNull();
	});

	it('consults a custom resolver first, then falls through', () => {
		const resolve = createMojiResolver({
			resolver: (slug) => (slug === 'me' ? { slug: 'me', char: '🧑' } : null),
			mojis: { moon: '🌝' },
		});
		expect(resolve('me')?.char).toBe('🧑'); // from resolver fn
		expect(resolve('moon')?.char).toBe('🌝'); // fell through to map
		expect(resolve('smile')?.char).toBe('😄'); // fell through to defaults
	});

	it('treats a definition with neither char nor src as unknown', () => {
		const resolve = createMojiResolver({ includeDefaults: false, mojis: { blank: {} as MojiDefinition } });
		expect(resolve('blank')).toBeNull();
	});
});

describe('createMojiCache', () => {
	it('fetches a slug once, caches the positive result, and notifies', async () => {
		let calls = 0;
		const cache = createMojiCache(async (slug) => {
			calls++;
			return { slug, char: '🦜' };
		});
		let notified = 0;
		cache.onResolved(() => {
			notified++;
		});

		expect(cache.peek('parrot')).toBeUndefined(); // not cached yet
		expect(cache.ensure('parrot')).toBe(true); // starts a fetch
		expect(cache.ensure('parrot')).toBe(false); // in-flight → de-duped

		await flush();

		expect(calls).toBe(1);
		expect(cache.peek('parrot')?.char).toBe('🦜');
		expect(cache.ensure('parrot')).toBe(false); // cached → no refetch
		expect(notified).toBe(1);
	});

	it('negative-caches an unknown slug so it is not refetched', async () => {
		let calls = 0;
		const cache = createMojiCache(async () => {
			calls++;
			return null;
		});

		cache.ensure('nope');
		await flush();
		expect(calls).toBe(1);
		expect(cache.peek('nope')).toBeNull(); // known-unknown (negative)
		expect(cache.ensure('nope')).toBe(false);
		await flush();
		expect(calls).toBe(1); // never refetched
	});

	it('does not cache a rejected fetch, so a later edit retries', async () => {
		let calls = 0;
		const cache = createMojiCache(async () => {
			calls++;
			throw new Error('network down');
		});

		cache.ensure('flaky');
		await flush();
		expect(calls).toBe(1);
		expect(cache.peek('flaky')).toBeUndefined(); // left uncached on error
		expect(cache.ensure('flaky')).toBe(true); // retried
		await flush();
		expect(calls).toBe(2);
	});

	it('treats a resolved def without char/src as a negative result', async () => {
		const cache = createMojiCache(async () => ({ slug: 'blank' }));
		cache.ensure('blank');
		await flush();
		expect(cache.peek('blank')).toBeNull();
	});

	it('looks up slugs case-insensitively', async () => {
		const cache = createMojiCache(async (slug) => ({ slug, char: '✅' }));
		expect(cache.ensure('CHECK')).toBe(true);
		expect(cache.ensure('check')).toBe(false); // same slug, in-flight
		await flush();
		expect(cache.peek('check')?.char).toBe('✅');
		expect(cache.peek('Check')?.char).toBe('✅');
	});

	it('stops notifying after the listener unsubscribes', async () => {
		const cache = createMojiCache(async (slug) => ({ slug, char: '⭐' }));
		let notified = 0;
		const off = cache.onResolved(() => {
			notified++;
		});
		off();
		cache.ensure('star');
		await flush();
		expect(cache.peek('star')?.char).toBe('⭐'); // still resolved + cached
		expect(notified).toBe(0); // but not notified
	});
});
