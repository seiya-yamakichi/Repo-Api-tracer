const parser = require('@babel/parser');

exports.parseFile = (filePath, fileContent) => {
  const isTS = /\.tsx?$/i.test(filePath);
  const isJS = /\.jsx?$/.test(filePath);

  // Base plugins for modern syntax
  const basePlugins = [
    'classProperties',
    'classPrivateProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport',
    'decorators-legacy'
  ];

  const plugins = [];

  if (isTS) {
    plugins.push('typescript');
    // only enable JSX for .tsx files (avoid confusing generics in .ts)
    if (/\.tsx$/i.test(filePath)) plugins.push('jsx');
  } else if (isJS) {
    // For JS files, detect JSX usage conservatively: enable JSX only
    // when React-related tokens or a JSX-like return are present.
    const looksLikeReact = /from\s+['"]react['"]|React\.|createElement\(|return\s*<\w|\/\*\s*@jsx/.test(fileContent);
    if (/\.jsx$/i.test(filePath) || looksLikeReact) plugins.push('jsx');

    // enable Flow when a @flow pragma is present
    if (/\/\*\s*@flow|@flow\b/.test(fileContent)) plugins.push('flow');
  }

  plugins.push(...basePlugins);

  return parser.parse(fileContent, {
    sourceType: 'unambiguous',
    plugins,
    errorRecovery: true,
  });
};
