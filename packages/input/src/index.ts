export * from './types.js';
export * from './commands.js';
export * from './shortcuts.js';
export * from './slash.js';
export * from './markdown.js';
export * from './autocomplete.js';
export * from './clipboard.js';
export * from './events.js';

export const packageMetadata = {
  name: '@plim/input',
  status: 'implemented',
  implementsRuntime: true,
  dependsOn: ['@plim/model'],
  features: [
    'command-registry',
    'keyboard-shortcuts',
    'slash-commands',
    'markdown-input-rules',
    'inline-autocomplete',
    'clipboard-parsing',
    'ime-beforeinput-guards'
  ]
} as const;
