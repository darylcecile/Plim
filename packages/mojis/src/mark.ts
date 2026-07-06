// ──────────────────────────────────────────────────────────────────────────
// The moji mark — an inline mark that renders a custom emoji as *plain text*.
// ──────────────────────────────────────────────────────────────────────────
//
// A moji is modelled as a marked text span (mirroring the bundled
// `mentionMark`) that behaves like an ordinary run of text: the caret can rest
// before and after it, and it highlights natively when part of a selection.
//   • Native glyph: text is the emoji itself (e.g. "🌑"), attrs { slug }. The
//     glyph is a real, selectable, highlightable text node.
//   • Image moji:   text is a single U+2003 EM SPACE — one code unit — so the
//     caret can only land before/after it (never "inside") and a single
//     Backspace removes it cleanly. attrs { slug, src }; the image is painted
//     by CSS as a *foreground* `::before` overlay (via the `--plim-moji-src`
//     custom property set here), sitting above the text-selection layer, while
//     the EM SPACE — which has a real ~1em advance — provides the highlightable
//     cell behind it. That is why an image moji shows the selection colour like
//     ordinary text: a zero-width placeholder (e.g. U+FFFC) would leave nothing
//     for `::selection` to paint. Copy/export read the slug from `attrs`, not
//     the text, so the placeholder never leaks (see `toMarkdown`).
//
// `toDOM` returns an (initially empty) wrapper; the editor appends the span's
// text node as a direct child. The wrapper is deliberately NOT `data-atomic`,
// so mojis get no focus ring and are not treated as a selectable atom — they
// flow, select and delete like text. Correct whole-emoji deletion is handled
// by the extension's grapheme-aware Backspace/Delete (native emoji are
// surrogate pairs, which the editor's default code-unit delete would split).

import { defineMark, type MarkPayload, type TextSpan } from '@plim/core';
import type { MojiDefinition } from './resolver.js';

/** The mark name used for moji spans. */
export const MOJI_MARK_NAME = 'moji';

/**
 * Placeholder text for image mojis: a single U+2003 EM SPACE. Using exactly one
 * code unit keeps the caret from landing inside the moji and makes deletion a
 * clean single-unit operation. EM SPACE is chosen deliberately over U+FFFC (the
 * OBJECT REPLACEMENT CHARACTER) because EM SPACE has a reliable ~1em advance in
 * every font, so it renders a real, highlightable text cell — the moji shows
 * the selection colour behind the image, just like ordinary text. U+FFFC has a
 * zero advance in many fonts, leaving nothing for `::selection` to paint. The
 * space is invisible (whitespace, and non-collapsing) and the image is drawn on
 * top by CSS (see mojis.css).
 */
export const MOJI_IMAGE_PLACEHOLDER = '\u2003';

export const mojiMark = defineMark({
	name: MOJI_MARK_NAME,
	// Round-trips a moji back to its shortcode when copying / exporting to
	// markdown, so `Hello 🌑` copies as `Hello :moon:`. Reads the slug from
	// `attrs` (never the text) so image mojis — whose text is a placeholder —
	// serialize correctly too. See MarkDescriptor.
	toMarkdown: (p: MarkPayload): string => `:${String(p.attrs?.slug ?? '')}:`,
	toDOM: (p: MarkPayload): HTMLElement => {
		const slug = String(p.attrs?.slug ?? '');
		const src = p.attrs?.src ? String(p.attrs.src) : '';
		const el = document.createElement('span');
		el.className = src ? 'plim-moji plim-moji--image' : 'plim-moji';
		el.setAttribute('data-moji-slug', slug);
		el.setAttribute('title', `:${slug}:`);
		// Announce the shortcode for assistive tech (image mojis have no
		// readable text; native glyphs read as their emoji otherwise).
		el.setAttribute('role', 'img');
		el.setAttribute('aria-label', `:${slug}:`);
		if (src) {
			// Painted as a foreground `::before` overlay (see mojis.css) so it
			// sits *above* the placeholder's selection highlight. The resolver's
			// URL is application-trusted; still escape it so a stray
			// quote/backslash can't break out of the CSS url() string.
			el.style.setProperty('--plim-moji-src', `url("${escapeCssUrl(src)}")`);
		}
		return el;
	},
});

/**
 * Build the text span for a resolved moji. Native mojis use the glyph as their
 * text (so it selects/highlights like text); image mojis use a single
 * placeholder code unit (the image is painted by CSS) so the caret can only sit
 * before/after it and deletion stays clean.
 */
export function mojiSpan(def: MojiDefinition): TextSpan {
	const attrs: Record<string, unknown> = { slug: def.slug };
	if (def.src) attrs.src = def.src;
	const text = def.src ? MOJI_IMAGE_PLACEHOLDER : (def.char ?? `:${def.slug}:`);
	return { text, marks: [{ type: MOJI_MARK_NAME, attrs }] };
}

// Escape a URL for safe inclusion inside a CSS `url("…")` token. Encodes the
// characters that would otherwise terminate the string or the declaration.
function escapeCssUrl(url: string): string {
	return String(url).replace(/["\\\n\r\f]/g, (c) => `\\${(c.codePointAt(0) ?? 0).toString(16)} `);
}
