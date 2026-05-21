const parser = require('@babel/parser');

exports.parseFile = (filePath, fileContent) => {
  // Enable TypeScript support by default. Only enable JSX when
  // the file extension explicitly indicates TSX/JSX to avoid
  // confusing TypeScript generics like `foo<T>` with JSX.
  const plugins = [
    'typescript',
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport'
  ];

  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
    plugins.push('jsx');
  }

  return parser.parse(fileContent, {
    sourceType: 'unambiguous',
    plugins,
    errorRecovery: true,
  });
};
