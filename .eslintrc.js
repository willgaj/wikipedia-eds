module.exports = {
  root: true,
  extends: 'airbnb-base',
  env: {
    browser: true,
  },
  parser: '@babel/eslint-parser',
  parserOptions: {
    allowImportExportEverywhere: true,
    sourceType: 'module',
    requireConfigFile: false,
  },
  rules: {
    'import/extensions': ['error', { js: 'always' }], // require js file extensions in imports
    'linebreak-style': ['error', 'unix'], // enforce unix linebreaks
    'no-param-reassign': [2, { props: false }], // allow modifying properties of param
  },
  overrides: [{
    // Node dev tooling (import pipeline, admin, browser checks); never served (.hlxignore)
    files: ['tools/**/*.js', 'tools/**/*.mjs'],
    env: { node: true, es2020: true },
    rules: {
      'import/extensions': ['error', { js: 'always', mjs: 'always' }],
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'no-console': 'off',
      'no-await-in-loop': 'off', // sequential admin calls are intentional
      'no-restricted-syntax': ['error', 'ForInStatement', 'LabeledStatement', 'WithStatement'],
    },
  }],
};
