import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
  }
);
