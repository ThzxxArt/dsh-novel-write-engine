import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'coverage/**', 'node_modules/**', 'tests/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='process'][callee.property.name='env']",
          message: 'Do not read process.env in engine code; configuration comes from Config.',
        },
      ],
    },
  },
)
