const t = require('@babel/types');

/**
 * CommonJS の export 処理を行う traverse ハンドラ群
 * @param {object} options
 * @param {Set} options.exportedFunctions - エクスポート済み関数
 * @param {Set} options.exportAliases - module.exports / exports のエイリアス
 * @param {Set} options.explicitlyExportedNames - 明示的にエクスポートされた名前
 * @param {Set} options.exportedConstructors - エクスポートされたコンストラクタ
 * @param {Set} options.exportedObjects - エクスポートされたオブジェクト
 * @param {Map} options.prototypeAliases - プロトタイプエイリアス
 * @param {Map} options.objectDefs - ObjectExpression の定義
 * @param {Array} options.resultArray - 関数情報配列
 * @param {Function} options.serializeFunction - 関数をシリアライズ
 * @param {Function} options.getParams - パラメータを抽出
 * @param {Function} options.getReturnExpressionsFromFunctionNode - return式を抽出
 * @param {Function} options.extractFunctionReferences - オブジェクトプロパティから関数参照を抽出
 * @param {string} options.filePath - ファイルパス
 */
exports.createCommonJSHandlers = (options) => {
  const {
    exportedFunctions,
    exportAliases,
    explicitlyExportedNames,
    exportedConstructors,
    exportedObjects,
    prototypeAliases,
    objectDefs,
    resultArray,
    serializeFunction,
    getParams,
    getReturnExpressionsFromFunctionNode,
    extractFunctionReferences,
    filePath,
  } = options;

  /**
   * MemberExpressionのルートが exports または module.exports かを再帰的にチェック
   */
  const isExportRoot = (node) => {
    if (t.isIdentifier(node) && exportAliases.has(node.name)) {
      return true;
    }
    if (t.isIdentifier(node, { name: 'exports' })) {
      return true;
    }
    if (t.isMemberExpression(node)) {
      if (t.isIdentifier(node.object, { name: 'module' }) &&
          t.isIdentifier(node.property, { name: 'exports' })) {
        return true;
      }
      return isExportRoot(node.object);
    }
    return false;
  };

  /**
   * CallExpression の中から関数を探す
   */
  const extractFunctionFromCall = (callNode) => {
    if (!t.isCallExpression(callNode)) return null;
    for (const arg of callNode.arguments) {
      if (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)) {
        return arg;
      }
    }
    return null;
  };

  return {
    /**
     * VariableDeclarator: 変数宣言内のエイリアス・オブジェクト初期化
     */
    VariableDeclarator(path) {
      // module.exports / exports のエイリアス処理
      if (t.isIdentifier(path.node.id) && path.node.init) {
        const aliasName = path.node.id.name;
        const init = path.node.init;
        const isModuleExports = t.isMemberExpression(init) && 
                                t.isIdentifier(init.object, { name: 'module' }) && 
                                t.isIdentifier(init.property, { name: 'exports' });
        const isExports = t.isIdentifier(init, { name: 'exports' });
        
        if (isModuleExports || isExports) {
          exportAliases.add(aliasName);
          exportedObjects.add(aliasName);
          explicitlyExportedNames.add(aliasName);
        }
      }

      // ObjectExpression の初期化を記録
      if (t.isIdentifier(path.node.id) && t.isObjectExpression(path.node.init)) {
        objectDefs.set(path.node.id.name, path.node.init);
        prototypeAliases.set(path.node.id.name, path.node.id.name);
      }

      // プロトタイプエイリアスを追跡 (P -> Big.prototype)
      if (t.isMemberExpression(path.node.init) &&
          t.isIdentifier(path.node.init.object) &&
          t.isIdentifier(path.node.init.property) &&
          path.node.init.property.name === 'prototype' &&
          t.isIdentifier(path.node.id)) {
        const constructorName = path.node.init.object.name;
        const aliasName = path.node.id.name;
        prototypeAliases.set(aliasName, constructorName + '.prototype');
      }
    },

    /**
     * AssignmentExpression: 代入式での export 処理（非常に複雑）
     */
    AssignmentExpression(path) {
      // module.exports = ... が変数宣言内でエイリアス化されるケース
      if (t.isMemberExpression(path.node.left) && 
          t.isIdentifier(path.node.left.object, { name: 'module' }) &&
          t.isIdentifier(path.node.left.property, { name: 'exports' })) {
        if (t.isVariableDeclarator(path.parentPath?.node) && 
            t.isIdentifier(path.parentPath.node.id)) {
          const alias = path.parentPath.node.id.name;
          exportAliases.add(alias);
          exportedObjects.add(alias);
          explicitlyExportedNames.add(alias);
        }
      }

      // 代入式でのエイリアス登録 (例: cs = module.exports;)
      if (t.isIdentifier(path.node.left)) {
        const alias = path.node.left.name;
        const right = path.node.right;
        const isModuleExports = t.isMemberExpression(right) && 
                                t.isIdentifier(right.object, { name: 'module' }) && 
                                t.isIdentifier(right.property, { name: 'exports' });
        const isExports = t.isIdentifier(right, { name: 'exports' });
        if (isModuleExports || isExports) {
          exportAliases.add(alias);
          exportedObjects.add(alias);
          explicitlyExportedNames.add(alias);
        }
      }

      // 右辺がオブジェクトリテラルの場合
      if (t.isObjectExpression(path.node.right)) {
        let isExportPattern = false;

        if (t.isMemberExpression(path.node.left)) {
          const object = path.node.left.object;
          const property = path.node.left.property;
          const isModuleExports = t.isIdentifier(object, { name: 'module' }) &&
                                  t.isIdentifier(property, { name: 'exports' });
          const isExportsProperty = t.isIdentifier(object, { name: 'exports' }) &&
                                    t.isIdentifier(property);

          if (isModuleExports) {
            isExportPattern = true;
            extractFunctionReferences(path.node.right, '', true);

            if (t.isVariableDeclarator(path.parentPath?.node) && 
                t.isIdentifier(path.parentPath.node.id)) {
              const alias = path.parentPath.node.id.name;
              exportAliases.add(alias);
              exportedObjects.add(alias);
              explicitlyExportedNames.add(alias);
            }

            path.node.right.properties.forEach((prop) => {
              if (t.isObjectProperty(prop)) {
                if (t.isIdentifier(prop.value)) {
                  exportedConstructors.add(prop.value.name);
                } else if (t.isMemberExpression(prop.value) && 
                           t.isIdentifier(prop.value.property)) {
                  exportedConstructors.add(prop.value.property.name);
                }
              }
            });
          } else if (isExportsProperty) {
            isExportPattern = true;
            extractFunctionReferences(path.node.right, '', true);
          }
        } else if (t.isIdentifier(path.node.left, { name: 'exports' })) {
          isExportPattern = true;
          extractFunctionReferences(path.node.right, '', true);
        }

        if (isExportPattern) return;
      }

      // 右辺がコンストラクタ参照の場合 (module.exports = Constructor)
      if (t.isIdentifier(path.node.right)) {
        const isModuleExports = 
          t.isMemberExpression(path.node.left) && 
          t.isIdentifier(path.node.left.object, { name: 'module' }) && 
          t.isIdentifier(path.node.left.property, { name: 'exports' });

        if (isModuleExports) {
          const exportedName = path.node.right.name;
          exportedConstructors.add(exportedName);
          exportedObjects.add(exportedName);
          explicitlyExportedNames.add(exportedName);

          const existingFunc = resultArray.find(f => f.name === exportedName);
          if (existingFunc) {
            existingFunc.isExported = true;
          }
        }

        // module.exports = varName で varName が ObjectExpression の場合
        if (t.isMemberExpression(path.node.left) && !path.node.left.computed) {
          const object = path.node.left.object;
          const property = path.node.left.property;
          const isModuleExportsAssign = t.isIdentifier(object, { name: 'module' }) && 
                                        t.isIdentifier(property, { name: 'exports' });
          const isExportsPropertyAssign = t.isIdentifier(object, { name: 'exports' }) && 
                                          t.isIdentifier(property);
          const refName = path.node.right.name;
          
          if ((isModuleExportsAssign || isExportsPropertyAssign) && 
              objectDefs.has(refName)) {
            const objNode = objectDefs.get(refName);
            extractFunctionReferences(objNode, '', true);
          }
        } else if (t.isIdentifier(path.node.left, { name: 'exports' })) {
          const refName = path.node.right.name;
          if (objectDefs.has(refName)) {
            const objNode = objectDefs.get(refName);
            extractFunctionReferences(objNode, '', true);
          }
        }
      }

      // 右辺が関数式の場合
      let functionNode = null;
      if (t.isFunctionExpression(path.node.right) || 
          t.isArrowFunctionExpression(path.node.right)) {
        functionNode = path.node.right;
      } else if (t.isCallExpression(path.node.right)) {
        functionNode = extractFunctionFromCall(path.node.right);
      }

      if (functionNode) {
        let name;
        const params = getParams(functionNode.params);
        let isExported = false;

        if (t.isMemberExpression(path.node.left) && !path.node.left.computed) {
          const left = path.node.left;
          const object = left.object;
          const property = left.property;

          const isModuleExportsDefault = t.isIdentifier(object, { name: 'module' }) && 
                                         t.isIdentifier(property, { name: 'exports' });

          if (isModuleExportsDefault) {
            name = functionNode.id && functionNode.id.name ? 
                   functionNode.id.name : 'module.exports';
            isExported = true;
            exportedFunctions.add(JSON.stringify(serializeFunction(name, params)));
          } else if (isExportRoot(object) && t.isIdentifier(property)) {
            name = functionNode.id && functionNode.id.name ? 
                   functionNode.id.name : property.name;
            isExported = true;
            exportedFunctions.add(JSON.stringify(serializeFunction(name, params)));
          } else {
            const propName = t.isIdentifier(property) ? property.name : null;
            const objName = t.isIdentifier(object) ? object.name : null;
            if (objName && propName) {
              name = `${objName}.${propName}`;
              isExported = exportedObjects.has(objName) || 
                          explicitlyExportedNames.has(objName);
            } else if (propName) {
              name = propName;
            } else if (functionNode.id && functionNode.id.name) {
              name = functionNode.id.name;
            }
          }
        } else if (t.isIdentifier(path.node.left)) {
          name = path.node.left.name;
        }

        if (name) {
          const serialized = serializeFunction(name, params);
          if (!resultArray.some((f) => f.name === name)) {
            resultArray.push({
              name,
              isExported: isExported || 
                         exportedFunctions.has(JSON.stringify(serialized)) || 
                         false,
              arg: params,
              returnExprs: getReturnExpressionsFromFunctionNode(functionNode),
              filePath,
              start: functionNode.start,
              end: functionNode.end,
            });
          }
        }
      } else if (t.isIdentifier(path.node.right)) {
        // uid.uidSync = uidSync; のようなエイリアス代入
        const referencedName = path.node.right.name;
        if (t.isMemberExpression(path.node.left) && !path.node.left.computed) {
          const object = path.node.left.object;
          const property = path.node.left.property;

          if (t.isIdentifier(object) && t.isIdentifier(property)) {
            const apiName = `${object.name}.${property.name}`;
            const isExported = exportedObjects.has(object.name) ||
                              explicitlyExportedNames.has(object.name);

            if (isExported) {
              const referencedFunc = resultArray.find((f) => f.name === referencedName);
              if (referencedFunc && !resultArray.some((f) => f.name === apiName)) {
                resultArray.push({
                  name: apiName,
                  isExported: true,
                  arg: referencedFunc.arg || [],
                  returnExprs: referencedFunc.returnExprs || [],
                  filePath,
                  start: referencedFunc.start,
                  end: referencedFunc.end,
                  isPropertyFunction: true,
                  propertyPath: apiName,
                });
              }
            }
          }
        }
      } else if (t.isCallExpression(path.node.right)) {
        // exports.foo = anotherWrapper(func); パターン
        if (t.isMemberExpression(path.node.left) && !path.node.left.computed) {
          const object = path.node.left.object;
          const property = path.node.left.property;

          const isExportsProperty = t.isIdentifier(object) &&
                                    object.name === 'exports' &&
                                    t.isIdentifier(property);

          if (isExportsProperty) {
            const exportName = property.name;
            const params = [];
            const serialized = serializeFunction(exportName, params);
            if (!resultArray.some((f) => f.name === exportName)) {
              resultArray.push({
                name: exportName,
                isExported: true,
                arg: params,
                returnExprs: [],
                filePath,
                start: path.node.right.start,
                end: path.node.right.end,
              });
            }
          }
        }
      }
    },
  };
};
