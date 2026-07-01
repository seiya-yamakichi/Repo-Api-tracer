const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

/**
 * export フラグを付与する処理
 * @param {object} options
 * @param {Array} options.resultArray - 関数情報配列
 * @param {Set} options.explicitlyExportedNames - 明示的にエクスポートされた名前
 * @param {Set} options.exportedConstructors - エクスポートされたコンストラクタ
 * @param {Set} options.exportedObjects - module.exports / exports のオブジェクト名やエイリアス
 * @param {object} options.ast - パースされたAST
 */
exports.processExportFlags = (options) => {
  const {
    resultArray,
    explicitlyExportedNames,
    exportedConstructors,
    exportedObjects,
    ast,
  } = options;

  /**
   * isInstanceMethod フラグを持つ関数の isExported を更新
   */
  resultArray.forEach((func) => {
    if (func.isInstanceMethod && func.prototypeObj) {
      const ctorName = func.prototypeObj.replace(/\.prototype$/, '');
      if (exportedConstructors.has(ctorName)) {
        func.isExported = true;
      }
    }
  });

  /**
   * explicitlyExportedNames に基づいて isExported フラグを更新
   */
  resultArray.forEach((func) => {
    if (explicitlyExportedNames.has(func.name)) {
      func.isExported = true;
    }
  });

  /**
   * エクスポートされたクラスのメソッド/プロパティを export 扱いにする。
   * 例: class Big { plus(){} }; module.exports = Big;
   */
  resultArray.forEach((func) => {
    if (func.className && (
      exportedConstructors.has(func.className)
      || explicitlyExportedNames.has(func.className)
      || (exportedObjects && exportedObjects.has(func.className))
    )) {
      func.isExported = true;
    }
  });

  // module.exports のエイリアス配下にぶら下がる関数（例: cs.get, cs.to.hex）を export 扱いにする
  resultArray.forEach((func) => {
    if (!func || !func.name) return;
    for (const objName of (exportedObjects || [])) {
      if (func.name === objName || func.name.startsWith(objName + '.')) {
        func.isExported = true;
        break;
      }
    }
  });

  /**
   * module.exports = function(){ ... } の内部関数をエクスポート対象にする
   * デフォルトエクスポート（module.exports）が関数で、その関数内で定義されている関数が
   * プロパティ代入で参照されている場合、それらをエクスポート対象にする
   */
  const exportedFunctionsByRef = new Set();
  traverse(ast, {
    AssignmentExpression(path) {
      // output.add = add のようなパターンを検出
      if (t.isMemberExpression(path.node.left) && 
          t.isIdentifier(path.node.left.property) &&
          t.isIdentifier(path.node.right)) {
        const refName = path.node.right.name;
        exportedFunctionsByRef.add(refName);
      }
    }
  });

  // 参照されている関数を isExported = true に更新
  resultArray.forEach((func) => {
    if (exportedFunctionsByRef.has(func.name)) {
      func.isExported = true;
    }
  });
};

/**
 * 複数代入パターンなど複雑なケースでの duplicate 処理
 * @param {Array} resultArray - 関数情報配列
 */
exports.deduplicateResults = (resultArray) => {
  const positionMap = new Map();
  const resultByName = new Map();

  for (const func of resultArray) {
    const key = `${func.start},${func.end}`;

    if (!resultByName.has(func.name)) {
      resultByName.set(func.name, func);
    }

    if (!positionMap.has(key)) {
      positionMap.set(key, func);
    } else {
      const existing = positionMap.get(key);

      // isExported フラグを統合
      const mergedFlags = {
        isExported: !!(existing.isExported || func.isExported),
        isInstanceMethod: !!(existing.isInstanceMethod || func.isInstanceMethod),
      };

      func.isExported = mergedFlags.isExported;
      func.isInstanceMethod = mergedFlags.isInstanceMethod;

      existing.isExported = mergedFlags.isExported;
      existing.isInstanceMethod = mergedFlags.isInstanceMethod;

      resultByName.set(func.name, func);
      resultByName.set(existing.name, existing);
    }
  }

  return Array.from(resultByName.values());
};
