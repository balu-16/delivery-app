module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist', 'dev-dist', 'node_modules', 'stats.html'],
  rules: {
    'no-undef': 'off', // TypeScript checks undefined symbols.
    'no-unused-vars': 'off',
  },
}
