import { describe, expect, it } from 'vitest';
import type { DocumentNode, TextSpan, ValidationContext } from '@plim/core';
import {
	blockAtPath,
	charHasMojiAt,
	flatText,
	followedByMoji,
	nextGraphemeEnd,
	pathsEqual,
	precededByMoji,
	previousGraphemeStart,
} from '@plim/mojis';

const moji = (text: string, slug: string): TextSpan => ({ text, marks: [{ type: 'moji', attrs: { slug } }] });

// "Hi " (3) + 🌑 (2, surrogate pair) → moon glyph at [3, 5).
const HI_MOON: TextSpan[] = [{ text: 'Hi ' }, moji('🌑', 'moon')];

describe('flatText / pathsEqual / blockAtPath', () => {
	it('flatText joins span text', () => {
		expect(flatText(HI_MOON)).toBe('Hi 🌑');
	});

	it('pathsEqual compares structurally', () => {
		expect(pathsEqual([0, 1], [0, 1])).toBe(true);
		expect(pathsEqual([0], [0, 1])).toBe(false);
		expect(pathsEqual([0, 1], [0, 2])).toBe(false);
	});

	it('blockAtPath resolves nested blocks and rejects bad paths', () => {
		const doc: DocumentNode = {
			type: 'doc',
			children: [{ id: 'a', type: 'paragraph', text: [{ text: 'x' }], children: [{ id: 'b', type: 'paragraph' }] }],
		};
		expect(blockAtPath(doc, [0])?.id).toBe('a');
		expect(blockAtPath(doc, [0, 0])?.id).toBe('b');
		expect(blockAtPath(doc, [1])).toBeNull();
		expect(blockAtPath(doc, [0, 5])).toBeNull();
	});
});

describe('charHasMojiAt', () => {
	it('reports whether the code unit at an index is moji-marked', () => {
		// "Hi " occupies [0,3); the moon glyph occupies [3,5).
		expect(charHasMojiAt(HI_MOON, 0)).toBe(false);
		expect(charHasMojiAt(HI_MOON, 2)).toBe(false);
		expect(charHasMojiAt(HI_MOON, 3)).toBe(true);
		expect(charHasMojiAt(HI_MOON, 4)).toBe(true); // low surrogate half
		expect(charHasMojiAt(HI_MOON, 5)).toBe(false); // past the end
		expect(charHasMojiAt(HI_MOON, -1)).toBe(false);
	});
});

describe('precededByMoji / followedByMoji', () => {
	function ctx(offset: number, headOffset = offset): ValidationContext {
		const doc: DocumentNode = { type: 'doc', children: [{ id: 'b', type: 'paragraph', text: HI_MOON }] };
		return {
			state: { doc, selection: { anchor: { path: [0], offset }, head: { path: [0], offset: headOffset } } },
		} as ValidationContext;
	}

	it('precededByMoji is true only when the caret sits just after a moji', () => {
		expect(precededByMoji(ctx(5))).toBe(true); // trailing edge of the moon
		expect(precededByMoji(ctx(4))).toBe(true); // mid-glyph counts (moji code unit precedes)
		expect(precededByMoji(ctx(3))).toBe(false); // leading edge — "Hi " precedes
		expect(precededByMoji(ctx(2))).toBe(false);
		expect(precededByMoji(ctx(0))).toBe(false);
	});

	it('followedByMoji is true only when the caret sits just before a moji', () => {
		expect(followedByMoji(ctx(3))).toBe(true); // moon starts here
		expect(followedByMoji(ctx(4))).toBe(true); // still inside the moon glyph
		expect(followedByMoji(ctx(5))).toBe(false); // end of block
		expect(followedByMoji(ctx(2))).toBe(false);
	});

	it('both are false for a non-collapsed selection', () => {
		expect(precededByMoji(ctx(3, 5))).toBe(false);
		expect(followedByMoji(ctx(3, 5))).toBe(false);
	});
});

describe('previousGraphemeStart / nextGraphemeEnd', () => {
	it('treats a surrogate-pair emoji as one grapheme (Backspace)', () => {
		// "Hi 🌑": deleting back from the end removes the whole moon (→ 3).
		expect(previousGraphemeStart('Hi 🌑', 5)).toBe(3);
		// From offset 3 the previous grapheme is the space at [2,3).
		expect(previousGraphemeStart('Hi 🌑', 3)).toBe(2);
		expect(previousGraphemeStart('Hi 🌑', 0)).toBe(0);
	});

	it('treats a surrogate-pair emoji as one grapheme (Delete)', () => {
		// Forward-delete from before the moon removes the whole glyph (→ 5).
		expect(nextGraphemeEnd('Hi 🌑', 3)).toBe(5);
		expect(nextGraphemeEnd('Hi 🌑', 0)).toBe(1);
		expect(nextGraphemeEnd('Hi 🌑', 5)).toBe(5);
	});

	it('deletes one moji at a time from a merged same-slug run', () => {
		// Two moons render as a single 4-unit span but delete one glyph each.
		expect(previousGraphemeStart('🌑🌑', 4)).toBe(2);
		expect(previousGraphemeStart('🌑🌑', 2)).toBe(0);
		expect(nextGraphemeEnd('🌑🌑', 0)).toBe(2);
		expect(nextGraphemeEnd('🌑🌑', 2)).toBe(4);
	});

	it('handles a single placeholder code unit (image moji)', () => {
		expect(previousGraphemeStart('\uFFFC', 1)).toBe(0);
		expect(nextGraphemeEnd('\uFFFC', 0)).toBe(1);
	});
});
