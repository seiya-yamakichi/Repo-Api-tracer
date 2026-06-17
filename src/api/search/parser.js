const parser = require('@babel/parser');

const BASE_PLUGINS = new Set([
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'optionalChaining',
  'nullishCoalescingOperator',
  'dynamicImport',
  'decorators-legacy',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'optionalCatchBinding',
  'importMeta',
  'topLevelAwait',
  'throwExpressions'
]);

const RETRYABLE_SYNTAX_ERRORS = new Set([
  'MissingPlugin',
  'MissingOneOfPlugins',
  'UnexpectedToken',
  'UnterminatedRegExp'
]);

function buildInitialPlugins(filePath, fileContent) {
  const isTS = /\.tsx?$/i.test(filePath);
  const isJS = /\.jsx?$/.test(filePath);
  const plugins = new Set();

  if (isTS) {
    plugins.add('typescript');
    if (/\.tsx$/i.test(filePath)) {
      plugins.add('jsx');
    }
  } else if (isJS) {
    const looksLikeReact = /from\s+['"]react['"]|React\.|createElement\(|return\s*<\w|\/\*\s*@jsx/.test(fileContent);
    if (/\.jsx$/i.test(filePath) || looksLikeReact) {
      plugins.add('jsx');
    }

    if (/\/\*\s*@flow|@flow\b/.test(fileContent)) {
      plugins.add('flow');
    }
  }

  for (const plugin of BASE_PLUGINS) {
    plugins.add(plugin);
  }

  return plugins;
}

function parseWithPlugins(fileContent, plugins) {
  return parser.parse(fileContent, {
    sourceType: 'unambiguous',
    plugins: Array.from(plugins),
    errorRecovery: true,
  });
}

exports.parseFile = (filePath, fileContent) => {
  const plugins = buildInitialPlugins(filePath, fileContent);
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return parseWithPlugins(fileContent, plugins);
    } catch (error) {
      lastError = error;

      const missingPlugins = Array.isArray(error && error.missingPlugin)
        ? error.missingPlugin
        : [];

      let addedPlugin = false;
      for (const missingPlugin of missingPlugins) {
        if (!plugins.has(missingPlugin)) {
          plugins.add(missingPlugin);
          addedPlugin = true;
        }
      }

      if (!addedPlugin) {
        const isJS = /\.jsx?$/.test(filePath);
        const hasJsxCandidate = isJS && !plugins.has('jsx') && /<[A-Za-z][\w:-]*(\s|>|\/)/.test(fileContent);

        if (hasJsxCandidate && RETRYABLE_SYNTAX_ERRORS.has(error && error.reasonCode)) {
          plugins.add('jsx');
          addedPlugin = true;
        }
      }

      if (!addedPlugin || !RETRYABLE_SYNTAX_ERRORS.has(error && error.reasonCode)) {
        return null;
      }
    }
  }

  return null;
};
