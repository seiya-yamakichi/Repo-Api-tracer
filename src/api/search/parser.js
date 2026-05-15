const parser = require('@babel/parser');

exports.parseFile = (filePath, fileContent) => {
  const plugins = ['typescript', 'decorators-legacy'];
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || /<[A-Za-z]/.test(fileContent)) {
    plugins.push('jsx');
  }

  return parser.parse(fileContent, {
    sourceType: 'unambiguous',
    plugins,
    errorRecovery: true,
  });
};
