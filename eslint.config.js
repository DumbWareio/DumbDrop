const js = require('@eslint/js');
const prettierConfig = require('eslint-config-prettier');
const nodePlugin = require('eslint-plugin-n');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'uploads/**',
      'local_uploads/**',
      'dist/**',
      'build/**',
      '.metadata/**',
      'test/**',
    ],
  },
  js.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.js'],
    ignores: ['public/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: {
      n: nodePlugin,
    },
    rules: {
      ...nodePlugin.configs.recommended.rules,
      'n/exports-style': ['error', 'module.exports'],
      'n/file-extension-in-import': ['error', 'always'],
      'n/prefer-global/buffer': ['error', 'always'],
      'n/prefer-global/console': ['error', 'always'],
      'n/prefer-global/process': ['error', 'always'],
      'n/prefer-global/url-search-params': ['error', 'always'],
      'n/prefer-global/url': ['error', 'always'],
      'n/prefer-promises/dns': 'error',
      'n/prefer-promises/fs': 'error',
      'n/no-extraneous-require': 'off',
      'n/no-unpublished-require': 'off',
    },
  },
  {
    files: ['public/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];

