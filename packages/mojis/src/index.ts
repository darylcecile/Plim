// @plim/mojis — Slackmoji-style custom inline emoji for the Plim editor.
//
// Quick start:
//   import { mojiExtension } from '@plim/mojis';
//   import '@plim/mojis/mojis.css';
//
//   const driver = new PlimDriver({
//     extensions: [mojiExtension()],
//     // …register `mojiMark` too if you configure marks explicitly.
//   });
//
// Register your own mojis (native glyph or image URL):
//   mojiExtension({
//     mojis: {
//       partyparrot: { src: 'https://…/partyparrot.gif' },
//       shipit: '🚀',
//     },
//   });

export { MOJI_IMAGE_PLACEHOLDER, MOJI_MARK_NAME, mojiMark, mojiSpan } from './mark.js';
export {
	DEFAULT_MOJIS,
	createMojiCache,
	createMojiResolver,
	normalizeMojis,
	type AsyncMojiResolver,
	type CreateResolverOptions,
	type MojiCache,
	type MojiDefinition,
	type MojiResolver,
} from './resolver.js';
export { mojiExtension, type MojiExtensionOptions } from './extension.js';
export {
	blockAtPath,
	charHasMojiAt,
	flatText,
	followedByMoji,
	nextGraphemeEnd,
	pathsEqual,
	precededByMoji,
	previousGraphemeStart,
} from './helpers.js';
