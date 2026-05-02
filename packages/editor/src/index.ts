export * from '@plim/model';
export * from './editor.js';
export * from './errors.js';
export * from './events.js';
export * from './persistence.js';
export * from './registries.js';
export * from './render.js';
export * from './state.js';
export * from './types.js';

export const packageMetadata = {
  name: '@plim/editor',
  status: 'implemented',
  implementsRuntime: true,
  dependsOn: ['@plim/model']
} as const;
