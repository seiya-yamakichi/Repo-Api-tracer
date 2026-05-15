const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

exports.resolvePrototypeAliases = ({
  ast,
  prototypeAliases,
  exportedConstructors,
  resultArray
}) => {
  // 第1パス：ASTからプロトタイプエイリアスを収集 (Big.prototype = P など)
  traverse(ast, {
    AssignmentExpression(path) {
      if (
        t.isMemberExpression(path.node.left) &&
        t.isIdentifier(path.node.left.object) &&
        t.isIdentifier(path.node.left.property, { name: 'prototype' }) &&
        t.isIdentifier(path.node.right)
      ) {
        const ctor = path.node.left.object.name;
        const alias = path.node.right.name;
        prototypeAliases.set(alias, `${ctor}.prototype`);
      }
    }
  });

  // 第2パス：resultArray の関数名をエイリアス解決 (P.method -> Big.prototype.method など)
  resultArray.forEach((func) => {
    // P.method のようなエイリアス形式を検出
    const nameParts = func.name.split('.');
    if (nameParts.length >= 2) {
      const potentialAlias = nameParts[0];
      if (prototypeAliases.has(potentialAlias)) {
        const resolvedAlias = prototypeAliases.get(potentialAlias);
        const rest = nameParts.slice(1).join('.');
        func.name = `${resolvedAlias}.${rest}`;
        
        // resolvedAlias が BigConstructor.prototype の形式なら、export の可能性あり
        const ctorName = resolvedAlias.split('.prototype')[0];
        if (ctorName && exportedConstructors.has(ctorName)) {
          func.isExported = true;
        }
      }
    }
  });
};
