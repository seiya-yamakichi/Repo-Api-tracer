const fs = require('fs').promises;
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { parseFile } = require('../search/parser');
const { isObfuscated } = require('../search/utils');

const isTargetLibrary = (sourceValue, libraryName) => {
	if (!sourceValue || !libraryName) return false;
	return sourceValue === libraryName || sourceValue.startsWith(`${libraryName}/`);
};

const normalizeNameList = (value) => {
	if (!value) return [];
	return Array.isArray(value) ? value.filter(Boolean) : [value];
};

const getRequireSource = (node) => {
	if (!node) return null;

	if (t.isCallExpression(node)) {
		if (t.isIdentifier(node.callee, { name: 'require' })) {
			const [firstArg] = node.arguments;
			if (t.isStringLiteral(firstArg)) return firstArg.value;
		}
		return getRequireSource(node.callee);
	}

	if (t.isMemberExpression(node)) {
		return getRequireSource(node.object);
	}

	return null;
};

const getMemberImportName = (node) => {
	if (!node) return 'default';

	if (t.isMemberExpression(node)) {
		if (t.isIdentifier(node.property)) return node.property.name;
		if (t.isStringLiteral(node.property)) return node.property.value;
	}

	if (t.isCallExpression(node)) {
		return getMemberImportName(node.callee);
	}

	return 'default';
};

const buildPatternEntries = (pattern, importedName = null) => {
	const entries = [];
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (!t.isIdentifier(prop.key) && !t.isStringLiteral(prop.key)) continue;

		const keyName = t.isIdentifier(prop.key) ? prop.key.name : prop.key.value;
		let localName = keyName;

		if (t.isIdentifier(prop.value)) {
			localName = prop.value.name;
		} else if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			localName = prop.value.left.name;
		}

		entries.push({
			importedName: importedName || keyName,
			localName,
		});
	}
	return entries;
};

const collectImportedLocalNames = (ast, libraryName) => {
	const localToImported = new Map();

	traverse(ast, {
		ImportDeclaration(path) {
			if (!t.isStringLiteral(path.node.source) || !isTargetLibrary(path.node.source.value, libraryName)) return;

			for (const specifier of path.node.specifiers) {
				if (t.isImportDefaultSpecifier(specifier)) {
					localToImported.set(specifier.local.name, 'default');
				} else if (t.isImportNamespaceSpecifier(specifier)) {
					localToImported.set(specifier.local.name, '*');
				} else if (t.isImportSpecifier(specifier)) {
					const importedName = t.isIdentifier(specifier.imported)
						? specifier.imported.name
						: specifier.imported.value;
					localToImported.set(specifier.local.name, importedName);
				}
			}
		},

		VariableDeclarator(path) {
			if (!path.node.init) return;

			const source = getRequireSource(path.node.init);
			if (!source || !isTargetLibrary(source, libraryName)) return;

			if (t.isIdentifier(path.node.id)) {
				localToImported.set(path.node.id.name, getMemberImportName(path.node.init));
				return;
			}

			if (t.isObjectPattern(path.node.id)) {
				for (const entry of buildPatternEntries(path.node.id)) {
					localToImported.set(entry.localName, entry.importedName);
				}
			}
		}
	});

	return localToImported;
};

const getFunctionCall = async (filePath, libraryName, localName) => {
	const targetNames = normalizeNameList(localName);
	if (!filePath || targetNames.length === 0) return [];

	try {
		if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

		const fileContent = await fs.readFile(filePath, 'utf8');
		if (isObfuscated(fileContent)) return [];

		const ast = parseFile(filePath, fileContent);
		if (!ast) return [];

		const importedLocalNames = collectImportedLocalNames(ast, libraryName);
		const results = [];

		traverse(ast, {
			CallExpression(path) {
				if (!t.isIdentifier(path.node.callee)) return;

				const calleeName = path.node.callee.name;
				if (!targetNames.includes(calleeName)) return;

				if (importedLocalNames.size > 0 && !importedLocalNames.has(calleeName)) return;

				results.push({
					libraryName,
					importedName: importedLocalNames.get(calleeName) || calleeName,
					localName: calleeName,
					filePath,
					start: path.node.start,
					end: path.node.end,
					code: typeof path.node.start === 'number' && typeof path.node.end === 'number'
						? fileContent.slice(path.node.start, path.node.end)
						: '',
				});
			}
		});

		return results;
	} catch (error) {
		console.error('getFunctionCall failed', error);
		return [];
	}
};

module.exports = {
	getFunctionCall,
	getFuncitonCall: getFunctionCall,
};
