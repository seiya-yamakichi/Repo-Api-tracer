const fs = require('fs').promises;
const path = require('path');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { parseFile } = require('./search/parser');
const { resolvePrototypeAliases } = require('./search/prototypeResolver');
const { isObfuscated, getParams: utilGetParams, getReturnExpressionsFromFunctionNode: utilGetReturnExpressionsFromFunctionNode } = require('./search/utils');

const { collectExports } = require('./export/tracker');
const { processExportFlags, deduplicateResults } = require('./export/export-processor');
const { getFunction } = require('./search/getFunction');

/**
 * function-analysis は関数に `isExported` ラベルを付与する役割に専念します。
 * - `getFunction` から関数リストを取得
 * - AST を解析して export に関するメタデータを収集
 * - prototype 解決・フラグ付与を行う
 */
exports.analyzeFile = async (filePath, mode = 0) => {
  try {
    if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

    const fileContent = await fs.readFile(filePath, 'utf8');
    if (isObfuscated(fileContent)) return [];

    const parsed = parseFile(filePath, fileContent);
    if (!parsed) return [];

    // まずは関数抽出を外部モジュールに委譲
    const { functions: rawFunctions, prototypeAliases: pfFromGetter, objectDefs: odFromGetter } = await getFunction(filePath, 1);

    // export の基本情報を収集
    const { explicitlyExportedNames, exportedObjects, exportedConstructors } = collectExports(parsed);

    // 補助データ
    const exportAliases = new Set(['exports']);
    const prototypeAliases = new Map(pfFromGetter); // マージ可能な初期値
    const objectDefs = new Map(odFromGetter);

    // AST を走査して CommonJS の alias / objectDefs / prototypeAliases を強化
    traverse(parsed, {
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id) && path.node.init) {
          const aliasName = path.node.id.name;
          const init = path.node.init;
          const isModuleExports = t.isMemberExpression(init) && t.isIdentifier(init.object, { name: 'module' }) && t.isIdentifier(init.property, { name: 'exports' });
          const isExports = t.isIdentifier(init, { name: 'exports' });
          if (isModuleExports || isExports) {
            exportAliases.add(aliasName);
            exportedObjects.add(aliasName);
            explicitlyExportedNames.add(aliasName);
          }
        }

        if (t.isIdentifier(path.node.id) && t.isObjectExpression(path.node.init)) {
          objectDefs.set(path.node.id.name, path.node.init);
          prototypeAliases.set(path.node.id.name, path.node.id.name);
        }

        if (t.isMemberExpression(path.node.init) && t.isIdentifier(path.node.init.object) && t.isIdentifier(path.node.init.property) && path.node.init.property.name === 'prototype' && t.isIdentifier(path.node.id)) {
          const constructorName = path.node.init.object.name;
          const aliasName = path.node.id.name;
          prototypeAliases.set(aliasName, constructorName + '.prototype');
        }
      },

      AssignmentExpression(path) {
        // module.exports = { ... } や module.exports = Constructor の検出
        if (t.isMemberExpression(path.node.left) && t.isIdentifier(path.node.left.object, { name: 'module' }) && t.isIdentifier(path.node.left.property, { name: 'exports' })) {
          const right = path.node.right;
          if (t.isObjectExpression(right)) {
            // module.exports = { ... }
            right.properties.forEach((prop) => {
              if (t.isObjectProperty(prop)) {
                if (t.isIdentifier(prop.value)) exportedConstructors.add(prop.value.name);
                else if (t.isMemberExpression(prop.value) && t.isIdentifier(prop.value.property)) exportedConstructors.add(prop.value.property.name);
              }
            });
            // var cs = module.exports = { ... } のような alias
            if (t.isVariableDeclarator(path.parentPath?.node) && t.isIdentifier(path.parentPath.node.id)) {
              const alias = path.parentPath.node.id.name;
              exportAliases.add(alias);
              exportedObjects.add(alias);
              explicitlyExportedNames.add(alias);
            }
          } else if (t.isIdentifier(right)) {
            exportedConstructors.add(right.name);
            exportedObjects.add(right.name);
            explicitlyExportedNames.add(right.name);
          }
        }

        // プロトタイプ代入の簡易追跡: P = Big.prototype など
        if (t.isMemberExpression(path.node.left) && t.isIdentifier(path.node.left.property, { name: 'prototype' }) && t.isIdentifier(path.node.right)) {
          const ctor = path.node.left.object.name;
          const alias = path.node.right.name;
          if (prototypeAliases.has(alias)) prototypeAliases.set(alias, `${ctor}.prototype`);
        }
      }
    });

    // 関数配列をそのまま使い、プロトタイプ解決と export フラグ付与を行う
    const resultArray = rawFunctions.slice();

    // prototype aliases の解決（必要に応じて名前や isExported を更新）
    resolvePrototypeAliases({ ast: parsed, prototypeAliases, exportedConstructors, resultArray });

    // export によるフラグ付与
    processExportFlags({ resultArray, explicitlyExportedNames, exportedConstructors, exportedObjects, ast: parsed });

    // 重複等の後処理
    const deduped = deduplicateResults(resultArray);

    // 結果の整形
    let final = deduped.map((func) => ({
      name: func.name,
      arg: func.arg || [],
      returnExprs: func.returnExprs || [],
      isExported: !!func.isExported,
      filePath: func.filePath,
      start: func.start,
      end: func.end,
      // Include the signature by starting slice from `func.start` when available.
      bodyStart: typeof func.start === 'number' ? func.start : (typeof func.bodyStart === 'number' ? func.bodyStart : null),
      bodyEnd: typeof func.bodyEnd === 'number' ? func.bodyEnd : null,
      body: (typeof func.start === 'number' && typeof func.bodyEnd === 'number') ? fileContent.slice(func.start, func.bodyEnd) : ((typeof func.bodyStart === 'number' && typeof func.bodyEnd === 'number') ? fileContent.slice(func.bodyStart, func.bodyEnd) : null),
    }));

    // mode: 0 = exported only, 1 = all
    if (mode === 0) {
      final = final.filter((f) => f.isExported);
    }

    return final;
  } catch (e) {
    console.error('function-analysis failed', e);
    return [];
  }
};
