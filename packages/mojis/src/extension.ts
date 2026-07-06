// ──────────────────────────────────────────────────────────────────────────
// The moji extension — live conversion, paste and whole-emoji deletion.
// ──────────────────────────────────────────────────────────────────────────
//
// Everything visual lives on `mojiMark`; this extension wires the behaviour:
//   1. onTransaction auto-conversion — after every transaction we scan the
//      caret block for `:slug:` shortcodes and rewrite each *resolvable* one
//      as a moji span. This uniformly covers typing (the shortcode completes
//      at the caret) and pasting (many shortcodes appear at once).
//   2. Async (dynamic) resolution — a workspace may have hundreds of custom
//      emojis that can't be enumerated up front, so an app can pass a
//      `resolveAsync(slug)` that looks a slug up remotely. Unknown-but-
//      fetchable slugs are left as text on the first pass; when the fetch
//      settles we re-scan the block it appeared in and convert it (once), all
//      without ever blocking typing. Results are cached (see `createMojiCache`)
//      so each slug is fetched at most once.
//   3. Grapheme-aware Backspace / Delete — mojis behave like ordinary text
//      (the caret moves before/after them and they highlight in a selection),
//      but a native moji glyph is often a multi-code-unit grapheme (surrogate
//      pair or ZWJ sequence). The editor's default delete removes a single
//      code unit, which would split the glyph, so when the caret is adjacent
//      to a moji we delete the whole grapheme cluster in one keystroke —
//      exactly how a normal text box deletes an emoji.
//
// Mojis are intentionally NOT atomic: there is no focus ring and no caret
// snapping. Copy-as-slug is handled generally by the editor (a same-block copy
// whose selection carries a mark with a `toMarkdown` descriptor is routed
// through the markdown serializer) plus the `moji` mark's `toMarkdown` hook.

import {
	defineAction,
	defineExtension,
	hasMark,
	triggers,
	type ActionContext,
	type TextSpan,
} from '@plim/core';
import { MOJI_MARK_NAME, mojiMark, mojiSpan } from './mark.js';
import {
	createMojiCache,
	createMojiResolver,
	type CreateResolverOptions,
	type MojiCache,
	type MojiDefinition,
} from './resolver.js';
import {
	blockAtPath,
	flatText,
	followedByMoji,
	nextGraphemeEnd,
	pathsEqual,
	precededByMoji,
	previousGraphemeStart,
} from './helpers.js';

/** Options for {@link mojiExtension}. */
export interface MojiExtensionOptions extends CreateResolverOptions {
	/**
	 * Dynamic, remote slug resolver — e.g. a lookup against a workspace's
	 * custom-emoji registry. Consulted only when the synchronous resolver
	 * (`resolver` / `mojis` / defaults) does not know a slug. Results are
	 * cached (positive *and* negative) and de-duplicated, so each unknown slug
	 * hits the network at most once. When a fetch resolves to a definition,
	 * the pending `:slug:` in the document is converted automatically.
	 */
	resolveAsync?: (slug: string) => Promise<MojiDefinition | null | undefined>;
}

// Shortcode pattern: `:slug:` where slug is `[a-z0-9_+-]+` (case-insensitive;
// normalized to lowercase on lookup). A fresh instance is created per scan so
// the stateful `g`-flag `lastIndex` never leaks between transactions.
const MOJI_PATTERN = ':([a-z0-9_+\\-]+):';

interface MojiMatch {
	start: number;
	end: number;
	span: TextSpan;
	newLen: number;
}

export function mojiExtension(options: MojiExtensionOptions = {}) {
	const resolve = createMojiResolver(options);
	// Cache in front of the (optional) async resolver: each unknown slug is
	// fetched at most once; positive and negative results are both remembered.
	const cache: MojiCache | null = options.resolveAsync
		? createMojiCache(options.resolveAsync)
		: null;

	// Re-entry guard: our own conversion transactions re-fire onTransaction;
	// the flag makes the recursive callback bail immediately.
	let suppress = false;
	// The most recent ActionContext (its `state` getter is live), captured so
	// an async resolution that settles *between* transactions can still commit
	// a conversion against the current document.
	let latestCtx: ActionContext | null = null;
	// Blocks that hold a `:slug:` awaiting async resolution, keyed by a stable
	// path string → the path to re-scan once fetches settle.
	const dirty = new Map<string, number[]>();
	const pathKey = (path: readonly number[]): string => path.join(',');

	// When a batch of async fetches settles, re-scan every block that had a
	// pending shortcode and convert the ones that now resolve.
	cache?.onResolved(() => {
		const ctx = latestCtx;
		if (!ctx) return;
		const paths = [...dirty.values()];
		dirty.clear();
		for (const path of paths) convertBlock(ctx, path);
	});

	function collectMatches(flat: string, spans: TextSpan[], path: readonly number[]): MojiMatch[] {
		const out: MojiMatch[] = [];
		const re = new RegExp(MOJI_PATTERN, 'gi');
		let m: RegExpExecArray | null;
		while ((m = re.exec(flat)) !== null) {
			const raw = m[1];
			if (!raw) continue;
			const start = m.index;
			const end = m.index + m[0].length;
			// Already a moji — skip so we never re-convert and loop. (Mojis no
			// longer keep their `:slug:` text, but this stays as a safety net.)
			if (hasMark(spans, start, end, MOJI_MARK_NAME)) continue;
			// Inside an applied inline-code run — the user's escape hatch.
			if (hasMark(spans, start, end, 'code')) continue;
			// Inside an *unclosed* inline-code fence on this line (odd number
			// of literal backticks precede it): the code mark isn't applied
			// yet, so `hasMark` misses it. Skip until the fence closes.
			const lineStart = flat.lastIndexOf('\n', start - 1) + 1;
			let backticks = 0;
			for (let i = lineStart; i < start; i++) if (flat.charCodeAt(i) === 0x60) backticks++;
			if (backticks % 2 === 1) continue;
			let def: MojiDefinition | null | undefined = resolve(raw);
			if (!def && cache) {
				// Not known synchronously — consult the async cache. A cache
				// hit converts now; a miss starts a fetch and marks the block
				// so we revisit it when the fetch settles; a cached negative
				// (known-unknown) is left as literal text.
				const peeked = cache.peek(raw);
				if (peeked === undefined) {
					cache.ensure(raw);
					dirty.set(pathKey(path), [...path]);
					continue;
				}
				def = peeked;
			}
			if (!def) continue; // unknown slug → leave as literal text
			const span = mojiSpan(def);
			out.push({ start, end, span, newLen: span.text.length });
		}
		return out;
	}

	// Convert every resolvable shortcode in the block at `path` in one
	// transaction. Shared by the live (caret-block) pass and the async
	// re-scan. The caret is only recomputed when it sits collapsed in this
	// same block; edits to any other block leave the selection untouched (the
	// transaction op maps same-block offsets on its own).
	function convertBlock(ctx: ActionContext, path: number[]): void {
		const state = ctx.state;
		const block = blockAtPath(state.doc, path);
		if (!block?.text) return;
		const spans = block.text;
		const flat = flatText(spans);
		const matches = collectMatches(flat, spans, path);
		if (matches.length === 0) return;

		const sel = state.selection;
		const caretHere =
			!!sel &&
			pathsEqual(sel.anchor.path, sel.head.path) &&
			sel.anchor.offset === sel.head.offset &&
			pathsEqual(sel.head.path, path);
		let newOffset = 0;
		if (caretHere && sel) {
			// Recompute the caret: shift it by the net length change of every
			// match that ends at or before it (covers both typing — the last
			// match ends exactly at the caret — and paste — all matches end
			// before the caret at the paste tail).
			const offset = sel.head.offset;
			let caret = offset;
			let totalDelta = 0;
			for (const mt of matches) {
				const delta = mt.newLen - (mt.end - mt.start);
				totalDelta += delta;
				if (mt.end <= offset) caret += delta;
			}
			const finalLen = flat.length + totalDelta;
			newOffset = Math.max(0, Math.min(caret, finalLen));
		}

		suppress = true;
		try {
			const tx = ctx.createTransaction();
			// Apply right-to-left so earlier offsets stay valid as we go.
			for (let i = matches.length - 1; i >= 0; i--) {
				const mt = matches[i]!;
				tx.replaceRange(path, mt.start, mt.end, [mt.span]);
			}
			if (caretHere) {
				tx.setSelection({
					anchor: { path: [...path], offset: newOffset },
					head: { path: [...path], offset: newOffset },
				});
			}
			tx.commit();
		} finally {
			suppress = false;
		}
	}

	return defineExtension(() => ({
		name: 'mojis',
		registeredMarks: [mojiMark],
		registeredActions: [
			// Backspace at a moji's trailing edge removes the whole moji
			// grapheme in one keystroke (native emoji are surrogate pairs / ZWJ
			// sequences the default code-unit delete would split).
			defineAction('mojis.deleteBackward', {
				trigger: triggers.keyboard.key('Backspace'),
				triggerValidationRules: ({ predicate, and }) =>
					and(['inTextBlock', predicate(precededByMoji, 'precededByMoji')]),
				perform: (state, ctx) => {
					const sel = state.selection;
					const block = blockAtPath(state.doc, sel.head.path);
					if (!block?.text) return;
					const to = sel.head.offset;
					const from = previousGraphemeStart(flatText(block.text), to);
					if (from >= to) return;
					const tx = ctx.createTransaction();
					tx.replaceRange(sel.head.path, from, to, []);
					tx.setSelection({
						anchor: { path: [...sel.head.path], offset: from },
						head: { path: [...sel.head.path], offset: from },
					});
					tx.commit();
				},
				priority: 11,
			}),
			// Forward Delete at a moji's leading edge removes the whole moji
			// grapheme (mirror of the Backspace handler).
			defineAction('mojis.deleteForward', {
				trigger: triggers.keyboard.key('Delete'),
				triggerValidationRules: ({ predicate, and }) =>
					and(['inTextBlock', predicate(followedByMoji, 'followedByMoji')]),
				perform: (state, ctx) => {
					const sel = state.selection;
					const block = blockAtPath(state.doc, sel.head.path);
					if (!block?.text) return;
					const from = sel.head.offset;
					const to = nextGraphemeEnd(flatText(block.text), from);
					if (to <= from) return;
					const tx = ctx.createTransaction();
					tx.replaceRange(sel.head.path, from, to, []);
					tx.setSelection({
						anchor: { path: [...sel.head.path], offset: from },
						head: { path: [...sel.head.path], offset: from },
					});
					tx.commit();
				},
				priority: 11,
			}),
		],
		onTransaction: (_tx: unknown, ctxUnknown: unknown) => {
			if (suppress) return;
			const ctx = ctxUnknown as ActionContext;
			// Remember the live context so async resolutions that settle later
			// (outside any transaction) can still commit a conversion.
			latestCtx = ctx;
			const sel = ctx.state.selection;
			if (!sel) return;
			// Only act on a collapsed caret in a single block; ignore ranges.
			if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
				return;
			}
			// Auto-convert (and, for unknown-but-fetchable slugs, kick off the
			// async lookup + schedule a re-scan) the block holding the caret.
			convertBlock(ctx, [...sel.head.path]);
		},
	}));
}
