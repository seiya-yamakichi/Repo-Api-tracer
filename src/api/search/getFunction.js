const fs = require('fs').promises;
const path = require('path');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { parseFile } = require('./parser');
const { isObfuscated, getParams: utilGetParams, getReturnExpressionsFromFunctionNode: utilGetReturnExpressionsFromFunctionNode } = require('./utils');

// このモジュールは関数抽出に専念します（export 判定は別モジュールで行う）
const getFunction = async (filePath, mode = 0) => {
  const resultArray = [];
  const prototypeAliases = new Map();
  const objectDefs = new Map();

  try {
    if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

    const fileContent = await fs.readFile(filePath, 'utf8');

    if (isObfuscated(fileContent)) {
      return [];
    }

    const parsed = parseFile(filePath, fileContent);
    if (!parsed) return [];

    const getParams = (params) => utilGetParams(params, fileContent);
    const getReturnExpressionsFromFunctionNode = (funcNode) => utilGetReturnExpressionsFromFunctionNode(funcNode, fileContent);

    const addFunctionEntry = (entry) => {
      const name = entry?.name;
      const start = entry?.start;
      const end = entry?.end;
      if (!name || typeof start !== 'number' || typeof end !== 'number') return;
      // If adding a non-module.exports entry that corresponds to the same
      // function range as an existing 'module.exports' placeholder, prefer
      // the named/default entry and remove the placeholder.
      if (name !== 'module.exports') {
        const idx = resultArray.findIndex((f) => f.name === 'module.exports' && f.start === start && f.end === end);
        if (idx >= 0) resultArray.splice(idx, 1);
      }

      const sameName = resultArray.find((f) => f.name === name);
      if (sameName) {
        if (typeof sameName.bodyStart !== 'number') sameName.bodyStart = entry.bodyStart;
        if (typeof sameName.bodyEnd !== 'number') sameName.bodyEnd = entry.bodyEnd;
        return;
      }

      // Ensure exportKind exists for clarity about how the function is exported
      if (!entry.exportKind) entry.exportKind = 'none';

      resultArray.push(entry);
    };

    const memberExpressionToPath = (node) => {
      if (t.isIdentifier(node)) return node.name;
      if (t.isThisExpression(node)) return 'this';
      if (t.isMemberExpression(node)) {
        const obj = memberExpressionToPath(node.object);
        let prop = null;
        if (t.isIdentifier(node.property)) prop = node.property.name;
        else if (t.isStringLiteral(node.property)) prop = node.property.value;
        if (!obj || !prop) return null;
        return `${obj}.${prop}`;
      }
      return null;
    };

    const deriveAssignedName = (leftNode, functionNode) => {
      if (t.isIdentifier(leftNode)) {
        return leftNode.name;
      }
      if (t.isMemberExpression(leftNode)) {
        const fullPath = memberExpressionToPath(leftNode);
        if (fullPath) return fullPath;
      }
      if (functionNode?.id?.name) return functionNode.id.name;
      return null;
    };

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
            if (t.isObjectExpression(prop.value)) {
              extractFunctionReferences(prop.value, fullPath, isExported);
            } else if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
              const funcNode = prop.value;
              const params = getParams(funcNode.params);
              const internalName = funcNode.id?.name;

              const existingIdx = resultArray.findIndex((f) =>
                f.start === funcNode.start && f.end === funcNode.end
              );

              if (existingIdx >= 0) {
                resultArray[existingIdx].isExported = isExported || resultArray[existingIdx].isExported;
              } else {
                addFunctionEntry({
                  name: internalName || fullPath,
                  isExported,
                  isPropertyFunction: true,
                  propertyPath: fullPath,
                  arg: params,
                  returnExprs: getReturnExpressionsFromFunctionNode(funcNode),
                  filePath,
                  start: funcNode.start,
                  end: funcNode.end,
                  bodyStart: funcNode.body?.start || funcNode.start,
                  bodyEnd: funcNode.body?.end || funcNode.end,
                });
              }
            }
          } else if (t.isObjectMethod(prop)) {
            const params = getParams(prop.params);

            addFunctionEntry({
              name: fullPath,
              isExported,
              isPropertyFunction: true,
              propertyPath: fullPath,
              arg: params,
              returnExprs: getReturnExpressionsFromFunctionNode(prop),
              filePath,
              start: prop.start,
              end: prop.end,
              bodyStart: prop.body?.start || prop.start,
              bodyEnd: prop.body?.end || prop.end,
            });
          }
        }
      });
    };

    traverse(parsed, {
      FunctionDeclaration(path) {
        if (!path.node.id) return;
        const name = path.node.id.name;
        const params = getParams(path.node.params);

        addFunctionEntry({
          name,
          isExported: false,
          arg: params,
          returnExprs: getReturnExpressionsFromFunctionNode(path.node),
          filePath,
          start: path.node.start,
          end: path.node.end,
          bodyStart: path.node.body?.start || path.node.start,
          bodyEnd: path.node.body?.end || path.node.end,
        });
      },

      ExportNamedDeclaration(path) {
        const decl = path.node.declaration;
        if (!decl) return;

        if (t.isFunctionDeclaration(decl) && decl.id) {
          addFunctionEntry({
            name: decl.id.name,
            isExported: true,
            exportKind: 'named',
            arg: getParams(decl.params),
            returnExprs: getReturnExpressionsFromFunctionNode(decl),
            filePath,
            start: decl.start,
            end: decl.end,
            bodyStart: decl.body?.start || decl.start,
            bodyEnd: decl.body?.end || decl.end,
          });
          return;
        }

        if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) {
            if (!t.isIdentifier(d.id) || !d.init) continue;

            if (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)) {
              addFunctionEntry({
                name: d.id.name,
                isExported: true,
                exportKind: 'named',
                arg: getParams(d.init.params),
                returnExprs: getReturnExpressionsFromFunctionNode(d.init),
                filePath,
                start: d.init.start,
                end: d.init.end,
                bodyStart: d.init.body?.start || d.init.start,
                bodyEnd: d.init.body?.end || d.init.end,
              });
            } else if (t.isCallExpression(d.init)) {
              const nestedFunc = d.init.arguments.find((arg) => t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg));
              if (nestedFunc) {
                addFunctionEntry({
                  name: d.id.name,
                  isExported: true,
                  exportKind: 'named',
                  arg: getParams(nestedFunc.params),
                  returnExprs: getReturnExpressionsFromFunctionNode(nestedFunc),
                  filePath,
                  start: nestedFunc.start,
                  end: nestedFunc.end,
                  bodyStart: nestedFunc.body?.start || nestedFunc.start,
                  bodyEnd: nestedFunc.body?.end || nestedFunc.end,
                });
              }
            } else if (t.isObjectExpression(d.init)) {
                extractFunctionReferences(d.init, d.id.name, true);
            }
          }
        }
      },

      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;
        if (t.isFunctionDeclaration(decl) && decl.id) {
          addFunctionEntry({
            name: decl.id.name,
            isExported: true,
            exportKind: 'default',
            arg: getParams(decl.params),
            returnExprs: getReturnExpressionsFromFunctionNode(decl),
            filePath,
            start: decl.start,
            end: decl.end,
            bodyStart: decl.body?.start || decl.start,
            bodyEnd: decl.body?.end || decl.end,
          });
        } else if (t.isObjectExpression(decl)) {
            extractFunctionReferences(decl, '', true);
        }
      },

      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id) && path.node.init && (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init))) {
          const name = path.node.id.name;
          const params = getParams(path.node.init.params);

          addFunctionEntry({
            name,
            isExported: false,
            arg: params,
            returnExprs: getReturnExpressionsFromFunctionNode(path.node.init),
            filePath,
            start: path.node.init.start,
            end: path.node.init.end,
            bodyStart: path.node.init.body?.start || path.node.init.start,
            bodyEnd: path.node.init.body?.end || path.node.init.end,
          });
        }

        if (t.isIdentifier(path.node.id) && t.isObjectExpression(path.node.init)) {
          objectDefs.set(path.node.id.name, path.node.init);
          prototypeAliases.set(path.node.id.name, path.node.id.name);
          extractFunctionReferences(path.node.init, path.node.id.name, false);
        }
      },

      AssignmentExpression(path) {
        const extractAliasesFromChain = (node, aliases = []) => {
          if (t.isAssignmentExpression(node)) {
            if (t.isMemberExpression(node.left)) {
              aliases.push(node.left);
            }
            return extractAliasesFromChain(node.right, aliases);
          }
          return { aliases, func: node };
        };

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
            addFunctionEntry({
              name: fullName,
              isExported: false,
              arg: params,
              returnExprs: getReturnExpressionsFromFunctionNode(path.node.right),
              filePath,
              start: path.node.right.start,
              end: path.node.right.end,
              bodyStart: path.node.right.body?.start || path.node.right.start,
              bodyEnd: path.node.right.body?.end || path.node.right.end,
            });
          }
        }

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
                addFunctionEntry({
                  name: fullName,
                  isExported: false,
                  arg: params,
                  returnExprs: getReturnExpressionsFromFunctionNode(func),
                  filePath,
                  start: func.start,
                  end: func.end,
                  bodyStart: func.body?.start || func.start,
                  bodyEnd: func.body?.end || func.end,
                });
              }
            }
          });
        }

        if (t.isFunctionExpression(path.node.right) || t.isArrowFunctionExpression(path.node.right)) {
          const functionNode = path.node.right;
          const assignedName = deriveAssignedName(path.node.left, functionNode);
          if (assignedName) {
            // If assigned directly to module.exports, treat as default export.
            if (assignedName === 'module.exports') {
              const fileBase = require('path').basename(filePath, require('path').extname(filePath));
              addFunctionEntry({
                name: fileBase || 'default',
                isExported: true,
                exportKind: 'default-assignment',
                exportSource: 'module.exports',
                arg: getParams(functionNode.params),
                returnExprs: getReturnExpressionsFromFunctionNode(functionNode),
                filePath,
                start: functionNode.start,
                end: functionNode.end,
                bodyStart: functionNode.body?.start || functionNode.start,
                bodyEnd: functionNode.body?.end || functionNode.end,
              });
            } else if (assignedName.startsWith('module.exports.') || assignedName.startsWith('exports.')) {
              // assignment to module.exports.foo or exports.foo -> property export
              addFunctionEntry({
                name: assignedName,
                isExported: true,
                exportKind: 'property',
                exportSource: assignedName.split('.')[0],
                arg: getParams(functionNode.params),
                returnExprs: getReturnExpressionsFromFunctionNode(functionNode),
                filePath,
                start: functionNode.start,
                end: functionNode.end,
                bodyStart: functionNode.body?.start || functionNode.start,
                bodyEnd: functionNode.body?.end || functionNode.end,
              });
            } else {
              addFunctionEntry({
                name: assignedName,
                isExported: false,
                arg: getParams(functionNode.params),
                returnExprs: getReturnExpressionsFromFunctionNode(functionNode),
                filePath,
                start: functionNode.start,
                end: functionNode.end,
                bodyStart: functionNode.body?.start || functionNode.start,
                bodyEnd: functionNode.body?.end || functionNode.end,
              });
            }
          }
        }

        if (t.isCallExpression(path.node.right)) {
          const nestedFunc = path.node.right.arguments.find((arg) =>
            t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)
          );
          if (nestedFunc) {
            const assignedName = deriveAssignedName(path.node.left, nestedFunc);
            if (assignedName) {
              if (assignedName === 'module.exports') {
                const fileBase = require('path').basename(filePath, require('path').extname(filePath));
                addFunctionEntry({
                  name: fileBase || 'default',
                  isExported: true,
                  exportKind: 'default-assignment',
                  exportSource: 'module.exports',
                  arg: getParams(nestedFunc.params),
                  returnExprs: getReturnExpressionsFromFunctionNode(nestedFunc),
                  filePath,
                  start: nestedFunc.start,
                  end: nestedFunc.end,
                  bodyStart: nestedFunc.body?.start || nestedFunc.start,
                  bodyEnd: nestedFunc.body?.end || nestedFunc.end,
                });
              } else if (assignedName.startsWith('module.exports.') || assignedName.startsWith('exports.')) {
                addFunctionEntry({
                  name: assignedName,
                  isExported: true,
                  exportKind: 'property',
                  exportSource: assignedName.split('.')[0],
                  arg: getParams(nestedFunc.params),
                  returnExprs: getReturnExpressionsFromFunctionNode(nestedFunc),
                  filePath,
                  start: nestedFunc.start,
                  end: nestedFunc.end,
                  bodyStart: nestedFunc.body?.start || nestedFunc.start,
                  bodyEnd: nestedFunc.body?.end || nestedFunc.end,
                });
              } else {
                addFunctionEntry({
                  name: assignedName,
                  isExported: false,
                  arg: getParams(nestedFunc.params),
                  returnExprs: getReturnExpressionsFromFunctionNode(nestedFunc),
                  filePath,
                  start: nestedFunc.start,
                  end: nestedFunc.end,
                  bodyStart: nestedFunc.body?.start || nestedFunc.start,
                  bodyEnd: nestedFunc.body?.end || nestedFunc.end,
                });
              }
            }
          } else {
            // 関数式を引数に取らない呼び出し（例: exports.foo = bar.bind(null, ...)）。
            // 引数・返り値は静的に解決できないため空で登録するが、公開APIとしては取りこぼさない。
            const assignedName = deriveAssignedName(path.node.left, null);
            const callNode = path.node.right;
            if (assignedName === 'module.exports') {
              const fileBase = require('path').basename(filePath, require('path').extname(filePath));
              addFunctionEntry({
                name: fileBase || 'default',
                isExported: true,
                exportKind: 'default-assignment',
                exportSource: 'module.exports',
                arg: [],
                returnExprs: [],
                filePath,
                start: callNode.start,
                end: callNode.end,
                bodyStart: callNode.start,
                bodyEnd: callNode.end,
              });
            } else if (assignedName && (assignedName.startsWith('module.exports.') || assignedName.startsWith('exports.'))) {
              addFunctionEntry({
                name: assignedName,
                isExported: true,
                exportKind: 'property',
                exportSource: assignedName.split('.')[0],
                arg: [],
                returnExprs: [],
                filePath,
                start: callNode.start,
                end: callNode.end,
                bodyStart: callNode.start,
                bodyEnd: callNode.end,
              });
            }
          }
        }

        if (t.isObjectExpression(path.node.right)) {
          let prefix = '';
          if (t.isIdentifier(path.node.left)) {
            prefix = path.node.left.name;
          } else if (t.isMemberExpression(path.node.left)) {
            prefix = memberExpressionToPath(path.node.left) || '';
          }
          const isExp = prefix === 'module.exports' || prefix.startsWith('module.exports.') || prefix.startsWith('exports.');
          extractFunctionReferences(path.node.right, prefix, !!isExp);
        }

        if (t.isIdentifier(path.node.right)) {
          const aliasTarget = path.node.right.name;
          const referencedFuncs = resultArray.filter((f) => f.name === aliasTarget);
          const aliasName = deriveAssignedName(path.node.left, null);
          if (referencedFuncs.length > 0 && aliasName) {
            // module.exports への別名代入なら参照先を exported にする
            if (aliasName === 'module.exports') {
              referencedFuncs.forEach((rf) => {
                rf.isExported = true;
                if (!rf.exportKind) rf.exportKind = 'default-assignment';
                rf.exportSource = rf.exportSource || 'module.exports';
              });
            } else if (aliasName.startsWith('module.exports.') || aliasName.startsWith('exports.')) {
              referencedFuncs.forEach((rf) => {
                rf.isExported = true;
                if (!rf.exportKind) rf.exportKind = 'property';
                rf.exportSource = rf.exportSource || aliasName.split('.')[0];
              });
            } else {
              // それ以外は通常どおり alias として登録
              referencedFuncs.forEach((referenced) => {
                addFunctionEntry({
                  name: aliasName,
                  isExported: false,
                  arg: referenced.arg || [],
                  returnExprs: referenced.returnExprs || [],
                  filePath,
                  start: referenced.start,
                  end: referenced.end,
                  bodyStart: referenced.bodyStart,
                  bodyEnd: referenced.bodyEnd,
                });
              });
            }
          }
        }

        if (t.isMemberExpression(path.node.left) &&
            t.isIdentifier(path.node.left.object) &&
            t.isIdentifier(path.node.left.property, { name: 'prototype' }) &&
            t.isIdentifier(path.node.right)) {
          const ctor = path.node.left.object.name;
          const alias = path.node.right.name;
          prototypeAliases.set(alias, `${ctor}.prototype`);
        }
      },

      ClassMethod(path) {
        if (!t.isIdentifier(path.node.key)) return;
        const name = path.node.key.name;
        const params = getParams(path.node.params);

        addFunctionEntry({
          name,
          isExported: false,
          arg: params,
          returnExprs: getReturnExpressionsFromFunctionNode(path.node),
          filePath,
          start: path.node.start,
          end: path.node.end,
          bodyStart: path.node.body?.start || path.node.start,
          bodyEnd: path.node.body?.end || path.node.end,
        });
      },

      ClassProperty(path) {
        if (!t.isIdentifier(path.node.key) || !path.node.value) return;
        if (!(t.isArrowFunctionExpression(path.node.value) || t.isFunctionExpression(path.node.value))) return;
        const name = path.node.key.name;
        const params = getParams(path.node.value.params);

        addFunctionEntry({
          name,
          isExported: false,
          arg: params,
          returnExprs: getReturnExpressionsFromFunctionNode(path.node.value),
          filePath,
          start: path.node.value.start,
          end: path.node.value.end,
          bodyStart: path.node.value.body?.start || path.node.value.start,
          bodyEnd: path.node.value.body?.end || path.node.value.end,
        });
      },
    });

    return {
      functions: resultArray,
      prototypeAliases,
      objectDefs,
    };
  } catch (error) {
    console.error(`getFunc Failed to process file: ${filePath}`, error);
    return { functions: [], prototypeAliases, objectDefs };
  }
};

// 外部から呼び出せるようにexport
exports.getFunction = getFunction;

// 直接実行用のコード
if (require.main === module) {
  (async () => {
    try {
      const target = process.argv[2] || path.join(__dirname, 'data1.js');
      const result = await getFunction(target, 0);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(e);
    }
  })();
}
