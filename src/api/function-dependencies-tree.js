const path = require('path');
const fs = require('fs').promises;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const { analyzeFunctionDependencies } = require('./dependencies/function-dependencies');
const { parseFile } = require('./search/parser');
const { isObfuscated } = require('./search/utils');

const normalizePath = (value) => value.replace(/\\/g, '/');

function buildAnalysisIndex(analysis) {
	const fileMap = new Map();

	for (const fileItem of analysis) {
		const filePath = normalizePath(fileItem.filePath);
		const functions = Array.isArray(fileItem.functions) ? fileItem.functions : [];
		fileMap.set(filePath, functions);
	}

	return fileMap;
}

function buildLocalFunctionIndex(functions) {
	const index = new Map();

	for (const func of functions) {
		if (!func || !func.name) continue;
		if (!index.has(func.name)) {
			index.set(func.name, func);
		}
	}

	return index;
}

function extractFunctionCalls(filePath, fileContent) {
	const ast = parseFile(filePath, fileContent);
	if (!ast) return new Map();

	const callMap = new Map();

	traverse(ast, {
		FunctionDeclaration(path) {
			if (!path.node.id || !path.node.id.name) return;
			const calls = [];
			path.traverse({
				CallExpression(callPath) {
					if (t.isIdentifier(callPath.node.callee)) {
						calls.push(callPath.node.callee.name);
					}
				},
			});
			callMap.set(path.node.id.name, calls);
		},
		FunctionExpression(path) {
			if (path.parentPath && path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
				const calls = [];
				path.traverse({
					CallExpression(callPath) {
						if (t.isIdentifier(callPath.node.callee)) {
							calls.push(callPath.node.callee.name);
						}
					},
				});
				callMap.set(path.parentPath.node.id.name, calls);
			}
		},
		ArrowFunctionExpression(path) {
			if (path.parentPath && path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
				const calls = [];
				path.traverse({
					CallExpression(callPath) {
						if (t.isIdentifier(callPath.node.callee)) {
							calls.push(callPath.node.callee.name);
						}
					},
				});
				callMap.set(path.parentPath.node.id.name, calls);
			}
		},
	});

	return callMap;
}

function pickTargetFunction(fileMap, dep) {
	if (!dep || dep.type !== 'local-file' || !dep.targetFile) return null;

	const targetFile = normalizePath(dep.targetFile);
	const candidates = fileMap.get(targetFile) || [];
	if (candidates.length === 0) return null;

	if (dep.targetFunction) {
		const exactMatch = candidates.find((func) => func.name === dep.targetFunction);
		if (exactMatch) return exactMatch;
	}

	if (dep.importedName) {
		const importedNameMatch = candidates.find((func) => func.name === dep.importedName);
		if (importedNameMatch) return importedNameMatch;
	}

	if (candidates.length === 1) return candidates[0];

	return null;
}

function formatUseLabel(localName, declaredName, relationType) {
	const relation = relationType === 'same-file' ? 'same-file' : 'imported-file';
	if (!declaredName || localName === declaredName) {
		return `${localName} [${relation}]`;
	}

	return `${localName} -> ${declaredName} [${relation}]`;
}

function buildFunctionTree(fileMap, filePath, func, sameFileCallsByFunction = new Map(), stack = new Set(), labelOverride = null, kind = 'decl', includeExternal = false) {
	const normalizedFilePath = normalizePath(filePath);
	const key = `${normalizedFilePath}::${func.name}`;

	if (stack.has(key)) {
		return {
			label: labelOverride || func.name,
			kind,
			filePath: normalizedFilePath,
			isCycle: true,
			children: [],
		};
	}

	const nextStack = new Set(stack);
	nextStack.add(key);

	const children = [];
	const seen = new Set();
	const dependencies = Array.isArray(func.dependencies) ? func.dependencies : [];
	const sameFileCalls = sameFileCallsByFunction.get(func.name) || [];
	const fileFunctions = fileMap.get(normalizedFilePath) || [];
	const localFunctionIndex = buildLocalFunctionIndex(fileFunctions);

	for (const callName of sameFileCalls) {
		const localTarget = localFunctionIndex.get(callName);
		if (!localTarget) continue;

		const childKey = `${normalizedFilePath}::${localTarget.name}`;
		if (seen.has(childKey)) continue;
		seen.add(childKey);

		if (localTarget.name === func.name) continue;

		children.push(buildFunctionTree(
			fileMap,
			normalizedFilePath,
			localTarget,
			sameFileCallsByFunction,
			nextStack,
			formatUseLabel(callName, localTarget.name, 'same-file'),
			'use'
		));
	}

	for (const dep of dependencies) {
		if (dep.type === 'local-file') {

			const targetFunction = pickTargetFunction(fileMap, dep);
			const targetFile = normalizePath(dep.targetFile);
			const childKey = targetFunction
				? `${targetFile}::${targetFunction.name}`
				: `${targetFile}::${dep.targetFunction || dep.importedName || dep.name}`;

			if (seen.has(childKey)) continue;
			seen.add(childKey);

			if (targetFunction) {
				children.push(buildFunctionTree(
					fileMap,
					targetFile,
					targetFunction,
					sameFileCallsByFunction,
					nextStack,
					formatUseLabel(dep.name, targetFunction.name, 'imported-file'),
					'use',
					includeExternal
				));
			} else {
				children.push({
					label: formatUseLabel(
						dep.name,
						dep.targetFunction || dep.importedName || dep.name,
						'imported-file'
					),
					kind: 'use',
					filePath: targetFile,
					children: [],
				});
			}

		} else if (includeExternal && (dep.type === 'external' || dep.type === 'external-lib')) {
			// 表示オプションが有効なら外部API呼び出しを木に追加
			const externalLabel = dep.type === 'external'
				? `${dep.name} (external: ${dep.sourceFile})`
				: `${dep.name} (external library)`;
			const childKey = `external::${externalLabel}`;
			if (seen.has(childKey)) continue;
			seen.add(childKey);
			children.push({
				label: externalLabel,
				kind: 'use',
				filePath: dep.sourceFile || null,
				children: [],
			});
		}
	}

	return {
		label: labelOverride || `${func.name}`,
		kind,
		filePath: normalizedFilePath,
		children,
	};
}

function appendTreeNode(lines, node, indent = '', isLast = true) {
	const connector = indent ? (isLast ? '└─ ' : '├─ ') : '';
	const role = node.kind === 'use' ? 'use' : 'decl';
	const cycleMark = node.isCycle ? ' [cycle]' : '';
	const label = node.filePath
		? `${role}: ${node.label} (${node.filePath})${cycleMark}`
		: `${role}: ${node.label}${cycleMark}`;
	lines.push(`${indent}${connector}${label}`);

	const childIndent = indent ? `${indent}${isLast ? '   ' : '│  '}` : '  ';
	for (let index = 0; index < node.children.length; index += 1) {
		appendTreeNode(lines, node.children[index], childIndent, index === node.children.length - 1);
	}
}

async function buildDependencyTrees(analysis, rootDir, includeExternal = false) {
	const fileMap = buildAnalysisIndex(analysis);
	const trees = [];

	for (const fileItem of analysis) {
		const filePath = normalizePath(fileItem.filePath);
		const functions = Array.isArray(fileItem.functions) ? fileItem.functions : [];
		const absoluteFilePath = path.join(rootDir, filePath);
		let sameFileCallsByFunction = new Map();

		try {
			const fileContent = await fs.readFile(absoluteFilePath, 'utf8');
			if (!isObfuscated(fileContent)) {
				sameFileCallsByFunction = extractFunctionCalls(absoluteFilePath, fileContent);
			}
		} catch (error) {
			// tree の構築を止めず、同一ファイル依存だけ空扱いにする
		}

		for (const func of functions) {
			const dependencies = Array.isArray(func.dependencies) ? func.dependencies : [];
			const importedDependencies = dependencies.filter((dep) => dep.type === 'local-file');
			const sameFileCalls = sameFileCallsByFunction.get(func.name) || [];

			trees.push({
				filePath,
				functionName: func.name,
				root: buildFunctionTree(fileMap, filePath, func, sameFileCallsByFunction, new Set(), null, 'decl', includeExternal),
			});
		}
	}

	return trees;
}

function printDependencyTrees(trees) {
	console.log(renderDependencyTrees(trees));
}

function renderDependencyTrees(trees) {
	const lines = [];
	lines.push('=== Function Dependency Tree ===');
	lines.push('');

	if (trees.length === 0) {
		lines.push('No imported function dependencies found.');
		return `${lines.join('\n')}\n`;
	}

	let currentFile = null;
	for (const tree of trees) {
		if (tree.filePath !== currentFile) {
			currentFile = tree.filePath;
			lines.push(`📄 ${currentFile}`);
		}

		appendTreeNode(lines, tree.root, '  ', true);
		lines.push('');
	}

	return `${lines.join('\n')}\n`;
}

async function main() {
	const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../..');
	const analysis = await analyzeFunctionDependencies(rootDir);
	const includeExternal = process.argv.includes('--include-external') || process.argv.includes('-e');
	const trees = await buildDependencyTrees(analysis, rootDir, includeExternal);

	if (process.argv.includes('--json')) {
		console.log(JSON.stringify(trees, null, 2));
		return trees;
	}

	printDependencyTrees(trees);
	return trees;
}

module.exports = {
	buildAnalysisIndex,
	pickTargetFunction,
	buildFunctionTree,
	buildDependencyTrees,
	renderDependencyTrees,
	printDependencyTrees,
	main,
};

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
