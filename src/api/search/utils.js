const t = require('@babel/types');

/**
 * ファイルが難読化されているか判定 (ビルド成果物か判定)
 * @param {string} fileContent ファイルの内容
 * @returns {boolean} true: 難読化, false: 非難読化
 */
const isObfuscated = (fileContent) => {
  // 1行の平均文字数が異常に多い
  const lines = fileContent.split('\n');
  if (lines.length === 0) return false;
  const avgLineLength = fileContent.length / lines.length;
  if (avgLineLength > 300) return true;
  
  // 変数名が1文字のみが多い（圧縮の兆候）
  const singleCharVars = (fileContent.match(/\b[a-z]\b/g) || []).length;
  const ratio = singleCharVars / (fileContent.length / 100);
  if (ratio > 5) return true;
  
  return false;
};

/**
 * 関数の引数 AST ノードを文字列の配列に変換
 * @param {Array} params パラメータノードの配列
 * @param {string} fileContent ファイルの内容（複雑なパラメータ用）
 * @returns {Array} 引数を文字列で表現した配列
 */
const getParams = (params, fileContent) =>
  (params || []).map((param) => {
    if (!param) return '';

    // 単純な識別子
    if (t.isIdentifier(param)) return param.name;

    // デフォルト引数 (AssignmentPattern)
    if (t.isAssignmentPattern(param)) {
      // 可能ならソースからそのまま切り取って `name = default` の文字列として返す
      if (fileContent && typeof param.start === 'number' && typeof param.end === 'number') {
        return fileContent.slice(param.start, param.end).replace(/\s+/g, ' ').trim();
      }
      // 左側が識別子なら名前だけ返す
      if (t.isIdentifier(param.left)) return param.left.name;
      return '';
    }

    // Rest パラメータ
    if (t.isRestElement(param) && t.isIdentifier(param.argument)) return '...' + param.argument.name;

    // 分割代入など複雑なパラメータはソースを切り取る
    if (fileContent && typeof param.start === 'number' && typeof param.end === 'number') {
      return fileContent.slice(param.start, param.end).replace(/\s+/g, ' ').trim();
    }

    return '';
  });

/**
 * return文の式をソース文字列として取得
 * @param {Node} funcNode 関数ノード
 * @param {string} fileContent ファイルの内容
 * @returns {Array} return式を文字列で表現した配列
 */
const getReturnExpressionsFromFunctionNode = (funcNode, fileContent) => {
  const exprs = [];
  if (!funcNode || !fileContent) return exprs;

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    
    // ネストされた関数を検出したら、その内部は走査しない
    if (depth > 0 && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
      return;
    }
    
    // return文が見つかったら
    if (node.type === 'ReturnStatement') {
      if (node.argument && typeof node.argument.start === 'number' && typeof node.argument.end === 'number') {
        exprs.push(fileContent.slice(node.argument.start, node.argument.end));
      }
      return;
    }
    
    // ASTノードの全プロパティを走査して、子ノード（配列／オブジェクト）を再帰的に探索
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(n => walk(n, depth + 1));
      else if (v && typeof v === 'object' && v.type) walk(v, depth + 1);
    }
  };

  // アロー関数の場合
  if (funcNode.body && funcNode.body.type && funcNode.body.type !== 'BlockStatement') {
    if (typeof funcNode.body.start === 'number' && typeof funcNode.body.end === 'number') {
      exprs.push(fileContent.slice(funcNode.body.start, funcNode.body.end));
    }
  } else if (funcNode.body) {
    walk(funcNode.body, 0);
  }

  return exprs;
};

/**
 * ASTノードを正規化して、変数名を除外した構造を表現する
 * 返り値のAST構造が同じで、Identifier（変数名）のみが異なる場合は同じと扱う
 * @param {Node} astNode ASTノード
 * @returns {string} 正規化されたAST構造を表現する文字列
 */
const normalizeAstStructure = (astNode) => {
  if (!astNode || typeof astNode !== 'object') {
    return JSON.stringify(astNode);
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return JSON.stringify(node);
    }

    if (Array.isArray(node)) {
      return node.map(visit);
    }

    // Identifierの場合は名前を除外（型情報のみで、具体的な名前は比較しない）
    if (node.type === 'Identifier') {
      return { type: 'Identifier' };
    }

    const normalized = { type: node.type };

    // 重要な子ノードプロパティを再帰的に正規化
    const importantKeys = [
      'callee', 'object', 'property', 'arguments', 'params',
      'body', 'left', 'right', 'test', 'consequent', 'alternate',
      'elements', 'properties', 'init', 'value', 'argument', 'key'
    ];

    for (const key of importantKeys) {
      if (key in node) {
        const child = node[key];
        if (child === null || child === undefined) continue;
        
        if (Array.isArray(child)) {
          normalized[key] = child.map(c => (c && typeof c === 'object' && c.type) ? JSON.parse(visit(c)) : c);
        } else if (typeof child === 'object' && child.type) {
          normalized[key] = JSON.parse(visit(child));
        } else if (typeof child === 'object') {
          normalized[key] = child;
        }
      }
    }

    return JSON.stringify(normalized);
  };

  return visit(astNode);
};

module.exports = {
  isObfuscated,
  getParams,
  getReturnExpressionsFromFunctionNode,
  normalizeAstStructure,
};
