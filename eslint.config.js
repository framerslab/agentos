import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** What an import of gray-matter outside the front-matter module is told. */
const FRONT_MATTER_MODULE =
  'Read and write front matter with readFrontMatter and writeFrontMatter from src/core/utils/frontMatter.ts.';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.spec.ts', '**/*.test.ts', '**/tests/**'],
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
      // These three entered js.configs.recommended in ESLint 10. They report
      // at warning level, like no-unused-vars above, until the code they flag
      // is cleaned up in a sweep of its own.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'no-unassigned-vars': 'warn',
    },
  },
  {
    // gray-matter's own engines evaluate a front-matter block marked as
    // JavaScript, so one module reads and writes front matter for the rest.
    // The pattern covers the files inside the package (gray-matter/index.js,
    // gray-matter/lib/engines.js), which reach the same engines.
    files: ['src/**/*.ts'],
    ignores: ['src/core/utils/frontMatter.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'gray-matter',
          message: FRONT_MATTER_MODULE,
        }],
        patterns: [{
          regex: '^gray-matter/',
          message: FRONT_MATTER_MODULE,
        }],
      }],
    },
  }
);
