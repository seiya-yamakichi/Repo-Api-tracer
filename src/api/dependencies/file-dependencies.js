const fs = require('fs').promises;
const path = require('path');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const { parseFile } = require('../search/parser');
const { isObfuscated } = require('../search/utils');
const { funcNameIdentifiers } = require('./getLocalName');
const { getFunctionCall } = require('./getFuctionCall');

const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'output', '.DS_Store']);

const isSupportedFile = (filePath) => SUPPORTED_EXTENSIONS.some((ext) => filePath.endsWith(ext));

async function collectProjectFiles(rootDir) {
	const files = [];

	async function walk(currentDir) {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			if (IGNORED_DIRS.has(entry.name)) continue;

			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && isSupportedFile(fullPath)) {
				files.push(fullPath);
			}
		}
	}

	await walk(rootDir);
	return files.sort();
}

function getNodeSource(fileContent, node) {
	if (typeof node.start !== 'number' || typeof node.end !== 'number') return '';
	return fileContent.slice(node.start, node.end);
}

function getRequireSource(node) {
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
}

function getImportNameFromNode(node) {
	if (!node) return 'default';

	if (t.isMemberExpression(node)) {
		if (t.isIdentifier(node.property)) return node.property.name;
		if (t.isStringLiteral(node.property)) return node.property.value;
	}

	if (t.isCallExpression(node)) {
		return getImportNameFromNode(node.callee);
	}

	return 'default';
}

function buildObjectPatternEntries(pattern, fallbackImportedName = null) {
	const entries = [];

	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (!t.isIdentifier(prop.key) && !t.isStringLiteral(prop.key)) continue;

		const importedName = t.isIdentifier(prop.key) ? prop.key.name : prop.key.value;
		let localName = importedName;

		if (t.isIdentifier(prop.value)) {
			localName = prop.value.name;
		} else if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			localName = prop.value.left.name;
		}

		entries.push({
			importedName: fallbackImportedName || importedName,
			localName,
		});
	}

	return entries;
}

function extractImportSources(ast) {
	const imports = [];

	traverse(ast, {
		ImportDeclaration(path) {
			if (!t.isStringLiteral(path.node.source)) return;
			imports.push({
				libraryName: path.node.source.value,
				sourceCode: null,
				node: path.node,
			});
		},

		VariableDeclarator(path) {
			if (!path.node.init) return;

			const libraryName = getRequireSource(path.node.init);
			if (!libraryName) return;

			if (t.isIdentifier(path.node.id)) {
				imports.push({
					libraryName,
					sourceCode: null,
					node: path.node,
					localEntries: [{ importedName: getImportNameFromNode(path.node.init), localName: path.node.id.name }],
				});
				return;
			}

			if (t.isObjectPattern(path.node.id)) {
				imports.push({
					libraryName,
					sourceCode: null,
					node: path.node,
					localEntries: buildObjectPatternEntries(path.node.id),
				});
			}
		},
	});

	return imports;
}

function printUsageReport(rows) {
	console.log('\n=== Function Usage ===\n');

	if (rows.length === 0) {
		console.log('No function usage found.');
		return;
	}

	for (const fileItem of rows) {
		console.log(`📄 ${fileItem.filePath}`);
		for (const dep of fileItem.dependencies) {
			console.log(`  ├─ ${dep.libraryName}`);
			for (const binding of dep.usages) {
				console.log(`  │  ├─ imported: ${binding.importedName}`);
				console.log(`  │  ├─ local: ${binding.localName}`);
				for (const usage of binding.usages) {
					console.log(`  │  │  └─ call: ${usage.code}`);
				}
			}
		}
		console.log();
	}
}

async function analyzeProjectFunctionUsage(rootDir) {
	const files = await collectProjectFiles(rootDir);
	const grouped = new Map();

	for (const filePath of files) {
		const fileContent = await fs.readFile(filePath, 'utf8');
		if (isObfuscated(fileContent)) continue;

		const ast = parseFile(filePath, fileContent);
		if (!ast) continue;

		const imports = extractImportSources(ast);
		const importSeen = new Set();
		const depMap = new Map();

		for (const importItem of imports) {
			const importLine = getNodeSource(fileContent, importItem.node);
			if (!importLine) continue;

			const localEntries = importItem.localEntries && importItem.localEntries.length > 0
				? importItem.localEntries
				: (funcNameIdentifiers(importLine, importItem.libraryName) || []);
			for (const entry of localEntries) {
				if (!entry || !entry.localName) continue;

				const key = `${importItem.libraryName}::${entry.localName}`;
				if (importSeen.has(key)) continue;
				importSeen.add(key);

				const usages = await getFunctionCall(filePath, importItem.libraryName, entry.localName);
				if (!usages || usages.length === 0) continue;

				if (!depMap.has(importItem.libraryName)) {
					depMap.set(importItem.libraryName, []);
				}

				depMap.get(importItem.libraryName).push({
					importedName: entry.importedName,
					localName: entry.localName,
					usages,
				});
			}
		}

		if (depMap.size > 0) {
			grouped.set(filePath, Array.from(depMap.entries()).map(([libraryName, usages]) => ({ libraryName, usages })));
		}
	}

	const result = Array.from(grouped.entries()).map(([filePath, dependencies]) => ({
		filePath,
		dependencies,
	}));

	printUsageReport(result);
	return result;
}

async function main() {
	const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../..');
	await analyzeProjectFunctionUsage(rootDir);
}

module.exports = {
	collectProjectFiles,
	extractImportSources,
	analyzeProjectFunctionUsage,
	printUsageReport,
	main,
};

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
