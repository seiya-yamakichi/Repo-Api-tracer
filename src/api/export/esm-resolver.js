const t = require('@babel/types');

/**
 * ES Module の export 宣言を処理する traverse ハンドラ群
 * @param {object} options
 * @param {Set} options.exportedFunctions - エクスポート済み関数の集合
 * @param {Set} options.explicitlyExportedNames - 明示的にエクスポートされた名前
 * @param {Set} options.exportedConstructors - エクスポートされたコンストラクタ
 * @param {Array} options.resultArray - 関数情報の配列
 * @param {Function} options.serializeFunction - 関数を シリアライズ
 * @param {Function} options.getParams - パラメータを抽出
 * @param {Function} options.getReturnExpressionsFromFunctionNode - return 式を抽出
 * @param {Function} options.extractFunctionReferences - オブジェクトプロパティから関数参照を抽出
 * @param {string} options.filePath - ファイルパス
 */
exports.createESMHandlers = (options) => {
  const {
    exportedFunctions,
    explicitlyExportedNames,
    exportedConstructors,
    resultArray,
    serializeFunction,
    getParams,
    getReturnExpressionsFromFunctionNode,
    extractFunctionReferences,
    filePath,
  } = options;

  return {
    /**
     * 名前付き export (export function foo() / export const x = ...)
     */
    ExportNamedDeclaration(path) {
      if (path.node.declaration) {
        if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
          const name = path.node.declaration.id.name;
          const params = getParams(path.node.declaration.params);
          exportedFunctions.add(JSON.stringify(serializeFunction(name, params)));

          if (!resultArray.some((f) => f.name === name)) {
            resultArray.push({
              name,
              isExported: true,
              arg: params,
              returnExprs: getReturnExpressionsFromFunctionNode(path.node.declaration),
              filePath,
              start: path.node.declaration.start,
              end: path.node.declaration.end,
            });
          }
        } else if (t.isVariableDeclaration(path.node.declaration)) {
          for (const declarator of path.node.declaration.declarations) {
            if (
              t.isVariableDeclarator(declarator) &&
              t.isIdentifier(declarator.id) &&
              declarator.init &&
              (t.isFunctionExpression(declarator.init) || t.isArrowFunctionExpression(declarator.init))
            ) {
              const name = declarator.id.name;
              const params = getParams(declarator.init.params);
              exportedFunctions.add(JSON.stringify(serializeFunction(name, params)));

              if (!resultArray.some((f) => f.name === name)) {
                resultArray.push({
                  name,
                  isExported: true,
                  arg: params,
                  returnExprs: getReturnExpressionsFromFunctionNode(declarator.init),
                  filePath,
                  start: declarator.init.start,
                  end: declarator.init.end,
                });
              }
            } else if (
              t.isVariableDeclarator(declarator) &&
              t.isIdentifier(declarator.id) &&
              declarator.init &&
              t.isCallExpression(declarator.init)
            ) {
              const name = declarator.id.name;
              if (!resultArray.some((f) => f.name === name)) {
                resultArray.push({
                  name,
                  isExported: true,
                  arg: [],
                  returnExprs: [],
                  filePath,
                  start: declarator.init.start,
                  end: declarator.init.end,
                });
              }
            } else if (
              t.isVariableDeclarator(declarator) &&
              t.isIdentifier(declarator.id) &&
              t.isObjectExpression(declarator.init)
            ) {
              const varName = declarator.id.name;
              extractFunctionReferences(declarator.init, varName, true);
            }
          }
        }
      }

      if (path.node.specifiers && path.node.specifiers.length > 0) {
        path.node.specifiers.forEach((spec) => {
          if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local)) {
            explicitlyExportedNames.add(spec.local.name);
            if (t.isIdentifier(spec.exported)) {
              exportedConstructors.add(spec.exported.name);
            }
          }
        });
      }
    },

    /**
     * default export (export default foo / export default { ... })
     */
    ExportDefaultDeclaration(path) {
      if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
        const name = path.node.declaration.id.name;
        const params = getParams(path.node.declaration.params);
        exportedFunctions.add(JSON.stringify(serializeFunction(name, params)));

        if (!resultArray.some((f) => f.name === name)) {
          resultArray.push({
            name,
            isExported: true,
            arg: params,
            returnExprs: getReturnExpressionsFromFunctionNode(path.node.declaration),
            filePath,
            start: path.node.declaration.start,
            end: path.node.declaration.end,
          });
        }
      } else if (t.isIdentifier(path.node.declaration)) {
        explicitlyExportedNames.add(path.node.declaration.name);
        exportedConstructors.add(path.node.declaration.name);
      } else if (t.isObjectExpression(path.node.declaration)) {
        extractFunctionReferences(path.node.declaration, '', true);
      }
    },
  };
};
