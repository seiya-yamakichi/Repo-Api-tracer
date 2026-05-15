const fs = require('fs').promises;
const path = require('path');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { parseFile } = require('./parser');
const { resolvePrototypeAliases } = require('./prototypeResolver');
const { isObfuscated, getParams: utilGetParams, getReturnExpressionsFromFunctionNode: utilGetReturnExpressionsFromFunctionNode } = require('./utils');

// このモジュールは関数抽出に専念します（export 判定は別モジュールで行う）
const getFunction = async (filePath, mode = 0) => {
  const resultArray = []; // 結果格納用配列
  const prototypeAliases = new Map(); // プロトタイプエイリアス（getInstanceMethod の処理を統合）
  const objectDefs = new Map(); // 変数に束縛された ObjectExpression を記録

  try {
    if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

    const fileContent = await fs.readFile(filePath, 'utf8');

    // 難読化・圧縮されたコードを除外
    if (isObfuscated(fileContent)) {
      return [];
    }

    const parsed = parseFile(filePath, fileContent);
    if (!parsed) return [];

    // この関数は export 判定を行わず、関数抽出と補助データの収集に専念する

    // ヘルパー：関数の「名前」と「引数配列」をまとめた小さなオブジェクトを返す
    const serializeFunction = (name, args) => ({ name, args });

    // ヘルパー：関数の引数 AST ノードを文字列の配列に変換（utils.jsから利用）
    const getParams = (params) => utilGetParams(params, fileContent);

    // ヘルパー：return 式のソース文字列を取得（utils.jsから利用）
    const getReturnExpressionsFromFunctionNode = (funcNode) => utilGetReturnExpressionsFromFunctionNode(funcNode, fileContent);

    // ヘルパー：オブジェクトプロパティから関数を再帰的に抽出（getFunctionProperty の処理を統合）
    const extractFunctionReferences = (objNode, pathPrefix = '', isExported = false) => {
      if (!t.isObjectExpression(objNode)) return;

      objNode.properties.forEach((prop) => {
        if (t.isObjectProperty(prop) || t.isObjectMethod(prop)) {
          let key;
          
          if (t.isIdentifier(prop.key)) {
            key = prop.key.name;
          } else if (t.isStringLiteral(prop.key)) {
            key = prop.key.value;
          } else {
            return;
          }

          const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;

          if (t.isObjectProperty(prop)) {
            // 値が関数参照（識別子）の場合
            if (t.isIdentifier(prop.value)) {
              explicitlyExportedNames.add(prop.value.name);
            } 
            // 値がネストされたオブジェクトの場合
            else if (t.isObjectExpression(prop.value)) {
              extractFunctionReferences(prop.value, fullPath, isExported);
            } 
            // 値がインライン関数の場合
            else if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
              const funcNode = prop.value;
              const params = getParams(funcNode.params);
              const internalName = funcNode.id?.name;
              
              // 同じ位置の関数が既に登録されているかチェック
              const existingIdx = resultArray.findIndex((f) => 
                f.start === funcNode.start && f.end === funcNode.end
              );
              
              if (existingIdx >= 0) {
                // 既存関数に isExported フラグを伝播
                resultArray[existingIdx].isExported = isExported || resultArray[existingIdx].isExported;
              } else {
                // 新規登録（内部関数名を優先、なければプロパティパス）
                resultArray.push({
                  name: internalName || fullPath,
                  isExported,
                  isPropertyFunction: true,
                  propertyPath: fullPath,
                  arg: params,
                  returnExprs: getReturnExpressionsFromFunctionNode(funcNode),
                  filePath,
                  start: funcNode.start,
                  end: funcNode.end,
                });
              }
            }
          } 
          // ObjectMethod の場合（例: { add(a, b) {} }）
          else if (t.isObjectMethod(prop)) {
            const params = getParams(prop.params);
            
            if (!resultArray.some((f) => f.start === prop.start && f.end === prop.end)) {
              resultArray.push({
                name: fullPath,
                isExported,
                isPropertyFunction: true,
                propertyPath: fullPath,
                arg: params,
                returnExprs: getReturnExpressionsFromFunctionNode(prop),
                filePath,
                start: prop.start,
                end: prop.end,
              });
            }
          }
        } else if (t.isSpreadElement(prop)) {
          // スプレッド構文は無視（追跡が複雑なため）
        }
      });
    };

    // ✅ 第2パス: 関数抽出（トラバースして関数ノードを収集）
    traverse(parsed, {
      // 通常の関数宣言(名前付き関数宣言)を取得
      FunctionDeclaration(path) {
        if (!path.node.id) return;
        const name = path.node.id.name;
        const params = getParams(path.node.params);
        const serialized = serializeFunction(name, params);

        if (!resultArray.some((f) => f.name === name)) {
          resultArray.push({
            name,
            isExported: false,
            arg: params,
            returnExprs: getReturnExpressionsFromFunctionNode(path.node),
            filePath,
            start: path.node.start,
            end: path.node.end,
          });
        }
      },

      // 変数宣言で関数が代入されている場合を検出
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id) && path.node.init && (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init))) {
          const name = path.node.id.name;
          const params = getParams(path.node.init.params);
          const serialized = serializeFunction(name, params);

          if (!resultArray.some((f) => f.name === name)) {
            resultArray.push({
              name,
              isExported: false,
              arg: params,
              returnExprs: getReturnExpressionsFromFunctionNode(path.node.init),
              filePath,
              start: path.node.init.start,
              end: path.node.init.end,
            });
          }
        }
        // 変数がオブジェクト初期化なら補助データとして記録
        if (t.isIdentifier(path.node.id) && t.isObjectExpression(path.node.init)) {
          objectDefs.set(path.node.id.name, path.node.init);
          prototypeAliases.set(path.node.id.name, path.node.id.name);
        }
      },

      // AssignmentExpression は主にプロトタイプ関連の検出に使う
      AssignmentExpression(path) {
        // ヘルパー：連鎖代入から最終的な関数式と左辺のメンバ式リストを取得
        const extractAliasesFromChain = (node, aliases = []) => {
          if (t.isAssignmentExpression(node)) {
            if (t.isMemberExpression(node.left)) {
              aliases.push(node.left);
            }
            return extractAliasesFromChain(node.right, aliases);
          }
          return { aliases, func: node };
        };

        // パターン 1: Constructor.prototype.method = function() { ... }
        if (t.isMemberExpression(path.node.left) &&
            t.isMemberExpression(path.node.left.object) &&
            t.isIdentifier(path.node.left.object.object) &&
            t.isIdentifier(path.node.left.object.property, { name: 'prototype' }) &&
            (t.isFunctionExpression(path.node.right) || t.isArrowFunctionExpression(path.node.right))) {
          const constructorName = path.node.left.object.object.name;
          const methodName = t.isIdentifier(path.node.left.property) ? path.node.left.property.name : null;
          if (constructorName && methodName) {
            const fullName = `${constructorName}.prototype.${methodName}`;
            const params = getParams(path.node.right.params);
            if (!resultArray.some((f) => f.name === fullName)) {
              resultArray.push({
                name: fullName,
                isExported: false,
                arg: params,
                returnExprs: getReturnExpressionsFromFunctionNode(path.node.right),
                filePath,
                start: path.node.right.start,
                end: path.node.right.end,
              });
            }
          }
        }

        // パターン 2: Alias.method = [Alias.method2 = ...] function() { ... } (連鎖代入対応)
        // 例: P.sub = P.minus = function() { ... }
        const { aliases, func } = extractAliasesFromChain(path.node);
        if ((t.isFunctionExpression(func) || t.isArrowFunctionExpression(func)) && aliases.length > 0) {
          const params = getParams(func.params);
          aliases.forEach((aliasExpr) => {
            if (t.isMemberExpression(aliasExpr) && t.isIdentifier(aliasExpr.object)) {
              const aliasName = aliasExpr.object.name;
              const methodName = t.isIdentifier(aliasExpr.property) 
                ? aliasExpr.property.name 
                : (t.isStringLiteral(aliasExpr.property) ? aliasExpr.property.value : null);
              
              if (methodName && (objectDefs.has(aliasName) || !prototypeAliases.has(aliasName))) {
                const fullName = `${aliasName}.${methodName}`;
                if (!resultArray.some((f) => f.name === fullName)) {
                  resultArray.push({
                    name: fullName,
                    isExported: false,
                    arg: params,
                    returnExprs: getReturnExpressionsFromFunctionNode(func),
                    filePath,
                    start: func.start,
                    end: func.end,
                  });
                }
              }
            }
          });
        }

        // パターン 3: プロトタイプエイリアスを追跡 (Big.prototype = P)
        if (t.isMemberExpression(path.node.left) &&
            t.isIdentifier(path.node.left.object) &&
            t.isIdentifier(path.node.left.property, { name: 'prototype' }) &&
            t.isIdentifier(path.node.right)) {
          const ctor = path.node.left.object.name;
          const alias = path.node.right.name;
          prototypeAliases.set(alias, `${ctor}.prototype`);
        }
      },

      // クラスメソッドを検出(クラス内のメソッド)
      ClassMethod(path) {
        if (!t.isIdentifier(path.node.key)) return; // メソッド名が識別子でない場合は無視
        const name = path.node.key.name;
        const params = getParams(path.node.params);
        const parentClass = path.findParent((p) => p.isClassDeclaration()); // 親クラスを探す
        let isExported = false;
        // 親クラスがエクスポートされているか確認
        if (parentClass) {
          if (t.isExportNamedDeclaration(parentClass.parent) || t.isExportDefaultDeclaration(parentClass.parent)) {
            isExported = true;
          }
        }

        if (!resultArray.some((f) => f.name === name)) {
          resultArray.push({
            name,
            isExported: false,
            arg: params,
            returnExprs: getReturnExpressionsFromFunctionNode(path.node),
            filePath,
            start: path.node.start,
            end: path.node.end,
          });
        }
      },

      // クラスプロパティで関数が代入されている場合を検出(クラス内のフィールドで関数式やアロー関数が代入されている場合)
      ClassProperty(path) {
        if (!t.isIdentifier(path.node.key) || !path.node.value) return; // プロパティ名が識別子でない、または値がない場合は無視
        if (!(t.isArrowFunctionExpression(path.node.value) || t.isFunctionExpression(path.node.value))) return; // 値が関数式またはアロー関数でない場合は無視
        const name = path.node.key.name;
        const params = getParams(path.node.value.params);
        const parentClass = path.findParent((p) => p.isClassDeclaration());
        let isExported = false;
        if (parentClass) {
          if (t.isExportNamedDeclaration(parentClass.parent) || t.isExportDefaultDeclaration(parentClass.parent)) {
            isExported = true;
          }
        }

        if (!resultArray.some((f) => f.name === name)) {
          resultArray.push({
            name,
            isExported: false,
            arg: params,
            returnExprs: getReturnExpressionsFromFunctionNode(path.node.value),
            filePath,
            start: path.node.value.start,
            end: path.node.value.end,
          });
        }
      },
    });
    // 注意: プロトタイプの最終解決や export フラグ付与は別モジュールで行う
    // この関数は生の関数情報配列と補助データを返す
    return {
      functions: resultArray,
      prototypeAliases,
      objectDefs,
    };

  } catch (error) {
    console.error(`getFunc Failed to process file: ${filePath}`, error);
    return { functions: [], prototypeAliases, objectDefs };
  }

}
function toExportedFunctionInfo(data) {
  // 重複を除外 (同じ名前の関数が複数ある場合は最初の1つだけを保持)
  const seen = new Set();
  const uniqueData = [];
  
  for (const func of data) {
    if (func.isExported && !seen.has(func.name)) {
      seen.add(func.name);
      uniqueData.push(func);
    }
  }
  
  // 統一フォーマット: { name, arg, returnExprs, isExported, filePath, start, end }
  return uniqueData.map((func) => ({
    name: func.name,
    arg: func.arg || [],
    returnExprs: func.returnExprs || [],
    isExported: func.isExported,
    filePath: func.filePath,
    start: func.start,
    end: func.end,
  }));
}

// 外部から呼び出せるようにexport
exports.getFunction = getFunction;

// 直接実行用のコード
if (require.main === module) {
  (async () => {
    try {
      // ✅ コマンドライン引数からファイルパスを取得
      const target = process.argv[2] || path.join(__dirname, 'data1.js');
      const result = await getFunction(target, 0);
      // When run directly, print JSON to stdout for convenience.
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(e);
    }
  })();
}
