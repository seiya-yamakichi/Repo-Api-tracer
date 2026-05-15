const fs = require('fs').promises;
const path = require('path');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const fsSync = require('fs');

const { parseFile } = require('../search/parser');
const { isObfuscated } = require('../search/utils');
const { getFunction } = require('../search/getFunction');

const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'output', '.DS_Store']);

const isSupportedFile = (filePath) => SUPPORTED_EXTENSIONS.some((ext) => filePath.endsWith(ext));

/**
 * プロジェクト内の全サポートファイルを収集
 */
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

/**
 * ファイル内のすべての関数呼び出しを収集（詳細版）
 * @param {string} filePath - 対象ファイル
 * @param {string} fileContent - ファイル内容
 * @param {Map} importMap - ローカル名 -> {importedName, sourceFile} のマッピング
 * @returns {Map<number, Array>} 関数のstart位置をキー、呼び出し詳細の配列を値
 */
function extractDetailedFunctionCalls(filePath, fileContent, importMap) {
	const ast = parseFile(filePath, fileContent);
	if (!ast) return new Map();

	const functionCalls = new Map(); // funcStart -> Array of { name, isImported, sourceFile, propertyPath }

	traverse(ast, {
		FunctionDeclaration(path) {
			const funcStart = path.node.start;
			const calls = [];

			path.traverse({
				CallExpression(callPath) {
					// simple function call: func()
					if (t.isIdentifier(callPath.node.callee)) {
						const name = callPath.node.callee.name;
						const importInfo = importMap.get(name);
						calls.push({
							name,
							type: 'simple',
							isImported: !!importInfo,
							sourceFile: importInfo?.sourceFile,
							importedName: importInfo?.importedName,
						});
					}
					// method call: obj.method() or obj.prop.method()
					else if (t.isMemberExpression(callPath.node.callee)) {
						const parts = [];
						let node = callPath.node.callee;
						while (t.isMemberExpression(node)) {
							if (t.isIdentifier(node.property)) {
								parts.unshift(node.property.name);
							}
							node = node.object;
						}
						if (t.isIdentifier(node)) {
							const baseObjName = node.name;
							const fullPath = [baseObjName, ...parts].join('.');
							const importInfo = importMap.get(baseObjName);
							calls.push({
								name: fullPath,
								type: 'member',
								baseObject: baseObjName,
								propertyPath: parts,
								isImported: !!importInfo,
								sourceFile: importInfo?.sourceFile,
								importedName: importInfo?.importedName,
							});
						}
					}
				},
			});

			if (calls.length > 0) {
				functionCalls.set(funcStart, calls);
			}
		},

		ArrowFunctionExpression(path) {
			if (path.parent && !t.isVariableDeclarator(path.parent)) return;

			const funcStart = path.node.start;
			const calls = [];

			path.traverse({
				CallExpression(callPath) {
					if (t.isIdentifier(callPath.node.callee)) {
						const name = callPath.node.callee.name;
						const importInfo = importMap.get(name);
						calls.push({
							name,
							type: 'simple',
							isImported: !!importInfo,
							sourceFile: importInfo?.sourceFile,
							importedName: importInfo?.importedName,
						});
					} else if (t.isMemberExpression(callPath.node.callee)) {
						const parts = [];
						let node = callPath.node.callee;
						while (t.isMemberExpression(node)) {
							if (t.isIdentifier(node.property)) {
								parts.unshift(node.property.name);
							}
							node = node.object;
						}
						if (t.isIdentifier(node)) {
							const baseObjName = node.name;
							const fullPath = [baseObjName, ...parts].join('.');
							const importInfo = importMap.get(baseObjName);
							calls.push({
								name: fullPath,
								type: 'member',
								baseObject: baseObjName,
								propertyPath: parts,
								isImported: !!importInfo,
								sourceFile: importInfo?.sourceFile,
								importedName: importInfo?.importedName,
							});
						}
					}
				},
			});

			if (calls.length > 0) {
				functionCalls.set(funcStart, calls);
			}
		},

		FunctionExpression(path) {
			const funcStart = path.node.start;
			const calls = [];

			path.traverse({
				CallExpression(callPath) {
					if (t.isIdentifier(callPath.node.callee)) {
						const name = callPath.node.callee.name;
						const importInfo = importMap.get(name);
						calls.push({
							name,
							type: 'simple',
							isImported: !!importInfo,
							sourceFile: importInfo?.sourceFile,
							importedName: importInfo?.importedName,
						});
					} else if (t.isMemberExpression(callPath.node.callee)) {
						const parts = [];
						let node = callPath.node.callee;
						while (t.isMemberExpression(node)) {
							if (t.isIdentifier(node.property)) {
								parts.unshift(node.property.name);
							}
							node = node.object;
						}
						if (t.isIdentifier(node)) {
							const baseObjName = node.name;
							const fullPath = [baseObjName, ...parts].join('.');
							const importInfo = importMap.get(baseObjName);
							calls.push({
								name: fullPath,
								type: 'member',
								baseObject: baseObjName,
								propertyPath: parts,
								isImported: !!importInfo,
								sourceFile: importInfo?.sourceFile,
								importedName: importInfo?.importedName,
							});
						}
					}
				},
			});

			if (calls.length > 0) {
				functionCalls.set(funcStart, calls);
			}
		},
	});

	return functionCalls;
}

/**
 * import/require宣言から依存ファイルマッピングを作成
 */
function buildImportMap(filePath, fileContent) {
	const ast = parseFile(filePath, fileContent);
	if (!ast) return new Map(); // localName -> { importedName, sourceFile }

	const imports = new Map();

	traverse(ast, {
		ImportDeclaration(path) {
			const sourceFile = path.node.source.value;
			for (const specifier of path.node.specifiers) {
				if (t.isImportDefaultSpecifier(specifier)) {
					imports.set(specifier.local.name, {
						importedName: 'default',
						sourceFile,
					});
				} else if (t.isImportSpecifier(specifier)) {
					const importedName = t.isIdentifier(specifier.imported)
						? specifier.imported.name
						: specifier.imported.value;
					imports.set(specifier.local.name, {
						importedName,
						sourceFile,
					});
				} else if (t.isImportNamespaceSpecifier(specifier)) {
					imports.set(specifier.local.name, {
						importedName: '*',
						sourceFile,
					});
				}
			}
		},

		VariableDeclarator(path) {
			if (!path.node.init) return;

			const sourceFile = extractRequireSource(path.node.init);
			if (!sourceFile) return;

			if (t.isIdentifier(path.node.id)) {
				imports.set(path.node.id.name, {
					importedName: 'default',
					sourceFile,
				});
			} else if (t.isObjectPattern(path.node.id)) {
				for (const prop of path.node.id.properties) {
					if (!t.isObjectProperty(prop)) continue;
					const key = t.isIdentifier(prop.key) ? prop.key.name : prop.key.value;
					const localName = t.isIdentifier(prop.value) ? prop.value.name : key;
					imports.set(localName, {
						importedName: key,
						sourceFile,
					});
				}
			}
		},
	});

	return imports;
}

/**
 * require呼び出しからソースファイルを抽出
 */
function extractRequireSource(node) {
	if (!node) return null;

	if (t.isCallExpression(node)) {
		if (t.isIdentifier(node.callee, { name: 'require' })) {
			const [firstArg] = node.arguments;
			if (t.isStringLiteral(firstArg)) return firstArg.value;
		}
		return extractRequireSource(node.callee);
	}

	if (t.isMemberExpression(node)) {
		return extractRequireSource(node.object);
	}

	return null;
}

/**
 * 相対パスを解決
 */
function resolveImportPath(sourceFile, currentDir, projectRoot) {
	if (sourceFile.startsWith('.')) {
		// 相対パス: ./file or ../folder/file
		let resolved = path.resolve(currentDir, sourceFile);

		// 拡張子がない場合、.js/.ts を試す
		if (!path.extname(sourceFile)) {
			for (const ext of ['.js', '.ts', '.jsx', '.tsx']) {
				const withExt = resolved + ext;
				if (fsSync.existsSync(withExt)) {
					return path.relative(projectRoot, withExt);
				}
			}
			// index.js を試す
			const indexFile = path.join(resolved, 'index.js');
			if (fsSync.existsSync(indexFile)) {
				return path.relative(projectRoot, indexFile);
			}
		}

		const rel = path.relative(projectRoot, resolved);
		return rel.startsWith('..') ? null : rel;
	}

	// 外部モジュール
	return null;
}

/**
 * ファイルごとの関数依存関係を解析
 */
async function analyzeFunctionDependencies(rootDir) {
	const files = await collectProjectFiles(rootDir);
	const allFunctions = new Map(); // filePath -> functions[]
	const filePathCache = new Map(); // resolvedPath -> actual filePath

	// ステップ1: 全ファイルから関数定義を抽出
	for (const filePath of files) {
		try {
			const fileContent = await fs.readFile(filePath, 'utf8');
			if (isObfuscated(fileContent)) continue;

			const result = await getFunction(filePath);
			const functions = (result && result.functions) ? result.functions : [];
			if (functions.length > 0) {
				allFunctions.set(filePath, functions);
				filePathCache.set(path.relative(rootDir, filePath), filePath);
			}
		} catch (err) {
			console.error(`Error reading ${filePath}:`, err.message);
		}
	}

	// ステップ2: 関数の依存関係を構築（関数単位）
	const result = [];

	for (const filePath of files) {
		try {
			const fileContent = await fs.readFile(filePath, 'utf8');
			if (isObfuscated(fileContent)) continue;

			const functions = allFunctions.get(filePath) || [];
			if (functions.length === 0) continue;

			const importMap = buildImportMap(filePath, fileContent);
			const detailedCalls = extractDetailedFunctionCalls(filePath, fileContent, importMap);
			const currentDir = path.dirname(filePath);

			const fileEntry = {
				filePath: path.relative(rootDir, filePath),
				functions: [],
			};

			for (const func of functions) {
				const calls = detailedCalls.get(func.start) || [];

				const funcDependencies = {
					name: func.name,
					args: func.arg || [],
					isExported: func.isExported || false,
					propertyPath: func.propertyPath,
					dependencies: [],
				};

				// 依存関係を分類
				const seen = new Set();

				for (const call of calls) {
					const key = `${call.type}::${call.name}`;
					if (seen.has(key)) continue;
					seen.add(key);

					if (call.isImported && call.sourceFile) {
						// インポートされた関数の呼び出し
						const resolvedPath = resolveImportPath(call.sourceFile, currentDir, rootDir);
						
						if (resolvedPath) {
							// ローカルファイル
							const targetFilePath = path.join(rootDir, resolvedPath);
							const targetFunctions = allFunctions.get(targetFilePath) || [];
							
							// 呼び出し対象の関数を特定
							let targetFunctionName = '';
							if (call.type === 'simple') {
								targetFunctionName = call.importedName || call.name;
							} else if (call.type === 'member') {
								// obj.method() の場合、methodが関数名
								targetFunctionName = call.propertyPath[call.propertyPath.length - 1];
							}

							funcDependencies.dependencies.push({
								name: call.name,
								type: 'local-file',
								targetFile: resolvedPath,
								targetFunction: targetFunctionName,
								imported: true,
							});
						} else {
							// 外部モジュール
							funcDependencies.dependencies.push({
								name: call.name,
								type: 'external',
								sourceFile: call.sourceFile,
								imported: true,
							});
						}
					} else {
						// ローカル呼び出し（同一ファイル内または外部ライブラリ）
						funcDependencies.dependencies.push({
							name: call.name,
							type: 'external-lib',
							imported: false,
						});
					}
				}

				fileEntry.functions.push(funcDependencies);
			}

			if (fileEntry.functions.length > 0) {
				result.push(fileEntry);
			}
		} catch (err) {
			console.error(`Error analyzing ${filePath}:`, err.message);
		}
	}

	return result;
}

/**
 * 依存関係レポートを出力（関数単位）
 */
function printDependencyReport(analysis) {
	console.log('\n=== Function-Level Dependencies ===\n');

	if (analysis.length === 0) {
		console.log('No function dependencies found.');
		return;
	}

	for (const fileItem of analysis) {
		console.log(`📄 ${fileItem.filePath}`);

		for (const func of fileItem.functions) {
			const exportedMark = func.isExported ? '✓' : '·';
			console.log(`  ${exportedMark} ${func.name}(${func.args.join(', ')})`);

			if (func.dependencies.length === 0) {
				console.log(`    └─ (no dependencies)`);
			} else {
				for (let i = 0; i < func.dependencies.length; i++) {
					const dep = func.dependencies[i];
					const isLast = i === func.dependencies.length - 1;
					const prefix = isLast ? '└─' : '├─';

					if (dep.type === 'local-file') {
						console.log(`    ${prefix} 📦 ${dep.name}`);
						console.log(`    ${ isLast ? '  ' : '│ '} └─ in ${dep.targetFile}` + (dep.targetFunction ? ` (${dep.targetFunction})` : ''));
					} else if (dep.type === 'external') {
						console.log(`    ${prefix} 🔗 ${dep.name} (external: ${dep.sourceFile})`);
					} else {
						console.log(`    ${prefix} 🌐 ${dep.name} (external library)`);
					}
				}
			}
			console.log();
		}
	}
}

/**
 * JSON形式での詳細出力用レポートジェネレータ
 */
function generateJsonReport(analysis) {
	return analysis;
}

async function main() {
	const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../..');
	const analysis = await analyzeFunctionDependencies(rootDir);
	printDependencyReport(analysis);

	// JSON形式で出力
	if (process.argv.includes('--json')) {
		console.log('\n=== JSON Format ===\n');
		console.log(JSON.stringify(analysis, null, 2));
	}

	return analysis;
}

module.exports = {
	collectProjectFiles,
	extractDetailedFunctionCalls,
	buildImportMap,
	analyzeFunctionDependencies,
	printDependencyReport,
	main,
};

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
