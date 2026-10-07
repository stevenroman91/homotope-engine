import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Globals that both a Web Worker and Node provide: the only browser globals the engine may use.
const ENGINE_GLOBALS = new Set([
  'console',
  'performance',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'TextEncoder',
  'TextDecoder',
]);

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.eval-out/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The engine is PURE: no DOM. It runs in a Web Worker and in Node.
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...Object.keys(globals.browser)
          .filter((name) => !ENGINE_GLOBALS.has(name))
          .map((name) => ({ name, message: 'Pure engine: no browser global.' })),
      ],
    },
  },
  {
    // Node codecs (pngjs, jpeg-js) are only reachable through `@homotope/engine/node`.
    files: ['src/**/*.ts'],
    ignores: ['src/engine/image/codec-node.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/codec-node', '**/codec-node.ts', 'pngjs', 'jpeg-js'],
              message: 'Node-only codec: import it from tests, scripts or the ./node entry only.',
            },
          ],
        },
      ],
    },
  },
);
