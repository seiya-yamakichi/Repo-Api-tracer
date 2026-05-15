/**
 * export 関連の処理を統合するエントリーポイント
 */

exports.tracker = require('./tracker');
exports.esmResolver = require('./esm-resolver');
exports.commonjsResolver = require('./commonjs-resolver');
exports.processor = require('./export-processor');

/**
 * 便利な統合関数: AST から全ての export 情報を抽出
 * @param {object} ast - パースされたAST
 * @param {object} options - オプション設定
 * @returns {object} { explicitlyExportedNames, exportedObjects, exportedConstructors }
 */
exports.collectAllExports = (ast, options = {}) => {
  const { tracker } = exports;
  return tracker.collectExports(ast);
};
