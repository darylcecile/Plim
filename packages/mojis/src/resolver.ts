// ──────────────────────────────────────────────────────────────────────────
// Moji resolver — how a `:slug:` shortcode maps to something renderable.
// ──────────────────────────────────────────────────────────────────────────
//
// A "moji" is a custom inline emoji. It resolves to either a native emoji
// glyph (`char`) or an image URL (`src`). Applications register their own
// mojis (à la custom Slackmojis) by passing `mojis` and/or a `resolver`
// function to the extension.

/** A resolved moji definition. Must carry either `char` or `src`. */
export interface MojiDefinition {
	/** Lowercase shortcode without the surrounding colons, e.g. `moon`. */
	slug: string;
	/** Native emoji glyph, e.g. `🌑`. Rendered inline as text. */
	char?: string;
	/** Image URL. Rendered as an em-sized square via CSS background-image. */
	src?: string;
	/** Optional human label (used by pickers / a11y tooling). */
	label?: string;
}

/**
 * Resolve a shortcode slug to a moji definition. Return `null`/`undefined`
 * for unknown slugs — unknown slugs are left as literal text and never
 * converted (so `10:30:` and `http://` are safe).
 */
export type MojiResolver = (slug: string) => MojiDefinition | null | undefined;

/**
 * Asynchronously resolve a shortcode slug — e.g. a network lookup against a
 * workspace's custom-emoji registry (à la Slack fetching its emoji list on
 * demand). Resolve to a {@link MojiDefinition}, or to `null`/`undefined` for a
 * slug the registry does not know. A negative result is cached so it is not
 * re-fetched; a *rejection* is treated as transient and is NOT cached, so the
 * slug is retried on a later edit.
 */
export type AsyncMojiResolver = (slug: string) => Promise<MojiDefinition | null | undefined>;

/**
 * A small, sensible default set so the extension is useful out of the box.
 * Applications typically extend or replace this via `mojis` / `resolver`.
 * Includes `smile` and `moon` (the shortcodes used in the package examples).
 */
export const DEFAULT_MOJIS: readonly MojiDefinition[] = [
	{ slug: 'smile', char: '😄', label: 'Smile' },
	{ slug: 'smiley', char: '😃', label: 'Smiley' },
	{ slug: 'grin', char: '😁', label: 'Grin' },
	{ slug: 'joy', char: '😂', label: 'Joy' },
	{ slug: 'laughing', char: '😆', label: 'Laughing' },
	{ slug: 'wink', char: '😉', label: 'Wink' },
	{ slug: 'blush', char: '😊', label: 'Blush' },
	{ slug: 'thinking', char: '🤔', label: 'Thinking' },
	{ slug: 'sob', char: '😭', label: 'Sob' },
	{ slug: 'sunglasses', char: '😎', label: 'Sunglasses' },
	{ slug: 'heart', char: '❤️', label: 'Heart' },
	{ slug: 'fire', char: '🔥', label: 'Fire' },
	{ slug: 'tada', char: '🎉', label: 'Tada' },
	{ slug: 'rocket', char: '🚀', label: 'Rocket' },
	{ slug: 'eyes', char: '👀', label: 'Eyes' },
	{ slug: 'sparkles', char: '✨', label: 'Sparkles' },
	{ slug: 'zap', char: '⚡', label: 'Zap' },
	{ slug: 'star', char: '⭐', label: 'Star' },
	{ slug: 'moon', char: '🌑', label: 'New moon' },
	{ slug: 'sun', char: '☀️', label: 'Sun' },
	{ slug: 'rainbow', char: '🌈', label: 'Rainbow' },
	{ slug: 'check', char: '✅', label: 'Check' },
	{ slug: 'x', char: '❌', label: 'Cross mark' },
	{ slug: 'warning', char: '⚠️', label: 'Warning' },
	{ slug: 'bulb', char: '💡', label: 'Bulb' },
	{ slug: 'bell', char: '🔔', label: 'Bell' },
	{ slug: '100', char: '💯', label: 'Hundred' },
	{ slug: '+1', char: '👍', label: 'Thumbs up' },
	{ slug: 'thumbsup', char: '👍', label: 'Thumbs up' },
	{ slug: '-1', char: '👎', label: 'Thumbs down' },
	{ slug: 'thumbsdown', char: '👎', label: 'Thumbs down' },
	{ slug: 'clap', char: '👏', label: 'Clap' },
	{ slug: 'wave', char: '👋', label: 'Wave' },
	{ slug: 'pray', char: '🙏', label: 'Pray' },
	{ slug: 'muscle', char: '💪', label: 'Muscle' },
	{ slug: 'ok_hand', char: '👌', label: 'OK hand' },
	{ slug: 'coffee', char: '☕', label: 'Coffee' },
	{ slug: 'pizza', char: '🍕', label: 'Pizza' },
	{ slug: 'cake', char: '🎂', label: 'Cake' },
	{ slug: 'ghost', char: '👻', label: 'Ghost' },
	{ slug: 'robot', char: '🤖', label: 'Robot' },
	{ slug: 'unicorn', char: '🦄', label: 'Unicorn' },
	{ slug: 'poop', char: '💩', label: 'Poop' },
];

/**
 * Normalize a `mojis` option (array of definitions or a `slug -> def|char`
 * record) into a `MojiDefinition[]` with lowercased slugs. A bare string
 * value is treated as a native glyph.
 */
export function normalizeMojis(
	input?: readonly MojiDefinition[] | Record<string, MojiDefinition | string>,
): MojiDefinition[] {
	if (!input) return [];
	const out: MojiDefinition[] = [];
	if (Array.isArray(input)) {
		for (const d of input) {
			if (d && typeof d.slug === 'string' && d.slug) out.push({ ...d, slug: d.slug.toLowerCase() });
		}
		return out;
	}
	for (const [key, val] of Object.entries(input as Record<string, MojiDefinition | string>)) {
		const slug = key.toLowerCase();
		if (typeof val === 'string') out.push({ slug, char: val });
		else if (val) out.push({ ...val, slug });
	}
	return out;
}

/** Options shared by {@link createMojiResolver} and the extension. */
export interface CreateResolverOptions {
	/** Custom mojis, merged over (or replacing) the defaults. */
	mojis?: readonly MojiDefinition[] | Record<string, MojiDefinition | string>;
	/**
	 * Fully custom *synchronous* resolver, consulted first. Return
	 * `null`/`undefined` to fall through to `mojis` and the defaults. Use this
	 * for lookups you can answer without I/O (e.g. an in-memory map). For a
	 * remote registry that must be fetched, use the extension's `resolveAsync`
	 * option instead (see {@link AsyncMojiResolver} / {@link createMojiCache}).
	 */
	resolver?: MojiResolver;
	/** Include the built-in {@link DEFAULT_MOJIS}. Defaults to `true`. */
	includeDefaults?: boolean;
}

/**
 * Build a resolver from options. Resolution order for a slug:
 *   1. the custom `resolver` function (if it returns a renderable def),
 *   2. the `mojis` map,
 *   3. the built-in defaults (unless `includeDefaults: false`).
 * Slugs are matched case-insensitively. A definition is only returned if it
 * actually carries a `char` or `src` (otherwise it is treated as unknown).
 */
export function createMojiResolver(options: CreateResolverOptions = {}): MojiResolver {
	const map = new Map<string, MojiDefinition>();
	if (options.includeDefaults !== false) {
		for (const d of DEFAULT_MOJIS) map.set(d.slug, d);
	}
	for (const d of normalizeMojis(options.mojis)) map.set(d.slug, d);
	const custom = options.resolver;
	return (slug: string): MojiDefinition | null => {
		const key = String(slug).toLowerCase();
		if (custom) {
			const r = custom(key);
			if (r && (r.char || r.src)) return { ...r, slug: (r.slug ?? key).toLowerCase() };
		}
		const found = map.get(key);
		if (found && (found.char || found.src)) return found;
		return null;
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Async cache — dynamic slug resolution without hardcoding every emoji.
// ──────────────────────────────────────────────────────────────────────────
//
// A workspace can have *hundreds* of custom emojis, so the app can't enumerate
// them up front. Instead it provides an {@link AsyncMojiResolver} (a remote
// lookup) and this cache sits in front of it: each `:slug:` is fetched at most
// once, in-flight fetches are de-duplicated, and both positive and negative
// results are remembered. This mirrors how a Slack client loads its workspace
// emoji list lazily and memoizes it.

/**
 * A slug→definition cache in front of an {@link AsyncMojiResolver}. Lookups are
 * split into a synchronous, non-fetching {@link MojiCache.peek | peek} (used by
 * the live-conversion scan, which must never block on the network) and an
 * asynchronous {@link MojiCache.ensure | ensure} that starts a fetch on a miss.
 */
export interface MojiCache {
	/**
	 * Synchronous, non-fetching lookup:
	 *   • a {@link MojiDefinition} — resolved and cached,
	 *   • `null` — a cached *negative* result (a known-unknown slug),
	 *   • `undefined` — not cached yet (call {@link MojiCache.ensure}).
	 */
	peek(slug: string): MojiDefinition | null | undefined;
	/**
	 * Start an async fetch for a cache miss. Returns `false` (a no-op) when the
	 * slug is already cached or a fetch is already in flight; otherwise starts
	 * a fetch and returns `true`. Successful results (definition or negative)
	 * are cached; a rejected fetch is left uncached so a later edit retries.
	 */
	ensure(slug: string): boolean;
	/**
	 * Subscribe to be notified after a batch of fetches settles. Multiple
	 * settlements in the same tick are coalesced into a single call (via a
	 * microtask) so the editor re-scans once per batch. Returns an unsubscribe.
	 */
	onResolved(listener: () => void): () => void;
}

/** Build a {@link MojiCache} over an {@link AsyncMojiResolver}. */
export function createMojiCache(resolveAsync: AsyncMojiResolver): MojiCache {
	const cache = new Map<string, MojiDefinition | null>();
	const inflight = new Set<string>();
	const listeners = new Set<() => void>();
	let scheduled = false;

	function notify(): void {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			for (const listener of [...listeners]) listener();
		});
	}

	return {
		peek(slug: string): MojiDefinition | null | undefined {
			return cache.get(String(slug).toLowerCase());
		},
		ensure(slug: string): boolean {
			const key = String(slug).toLowerCase();
			if (cache.has(key) || inflight.has(key)) return false;
			inflight.add(key);
			Promise.resolve()
				.then(() => resolveAsync(key))
				.then((def) => {
					if (def && (def.char || def.src)) {
						cache.set(key, { ...def, slug: (def.slug ?? key).toLowerCase() });
					} else {
						cache.set(key, null); // known-unknown → negative cache
					}
				})
				.catch(() => {
					// Transient failure — leave uncached so a later edit retries.
				})
				.finally(() => {
					inflight.delete(key);
					notify();
				});
			return true;
		},
		onResolved(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
