// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dev-dist/**', '**/.wrangler/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-run build scripts and config files (plain JS) need Node globals.
    files: ['**/*.mjs', '**/scripts/**', '**/*.config.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // The spine deliberately stores plugin/block content opaquely; `unknown` is the
      // contract, never `any`. Forbid the escape hatch so it can't creep in at a boundary.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // `_`-prefixed names are intentionally-unused seam params (e.g. a stub implementing a
      // typed signature whose arguments arrive in a later phase).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
