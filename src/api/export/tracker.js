const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

/**
 * AST から基本的な export 情報を収集する
 * @param {object} ast パースされたAST
 * @returns {object} { explicitlyExportedNames, exportedObjects, exportedConstructors }
 */
exports.collectExports = (ast) => {
  const explicitlyExportedNames = new Set();
  const exportedObjects = new Set();
  const exportedConstructors = new Set();

  traverse(ast, {
      AssignmentExpression(path) {
        if (t.isMemberExpression(path.node.left) && !path.node.left.computed) {
          const object = path.node.left.object;
          const property = path.node.left.property;
          
          const isModuleExports = 
            t.isIdentifier(object, { name: 'module' }) && 
            t.isIdentifier(property, { name: 'exports' });

          // ✅ 修正: module.exports = uid; のパターンを検出
          if (isModuleExports && t.isIdentifier(path.node.right)) {
            exportedObjects.add(path.node.right.name);
            exportedConstructors.add(path.node.right.name);
          }
        }
      },
      
      ExportDefaultDeclaration(path) {
        if (t.isIdentifier(path.node.declaration)) {
          exportedObjects.add(path.node.declaration.name);
          explicitlyExportedNames.add(path.node.declaration.name);
          exportedConstructors.add(path.node.declaration.name);
        } else if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
          const name = path.node.declaration.id.name;
          explicitlyExportedNames.add(name);
          exportedConstructors.add(name);
        }
      },
  });

  return {
    explicitlyExportedNames,
    exportedObjects,
    exportedConstructors
  };
};
