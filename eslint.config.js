import js from '@eslint/js';

const sharedGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Response: 'readonly',
  ReadableStream: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  DOMException: 'readonly',
  CSS: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'artifacts/**', 'web-ext-artifacts/**', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: sharedGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      globals: {
        ...sharedGlobals,
        browser: 'readonly',
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...sharedGlobals,
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
  },
];
