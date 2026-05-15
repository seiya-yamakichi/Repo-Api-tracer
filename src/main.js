const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { analyzeFile } = require('./api/function-analysis');
const { analyzeFunctionDependencies } = require('./api/dependencies/function-dependencies');
const { buildDependencyTrees, renderDependencyTrees } = require('./api/function-dependencies-tree');

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '..');

function parseCsvLine(line) {
	const result = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];

		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (ch === ',' && !inQuotes) {
			result.push(current);
			current = '';
			continue;
		}

		current += ch;
	}

	result.push(current);
	return result;
}

function sanitizeFileName(name) {
	return name.replace(/[\\/:*?"<>|]/g, '_');
}

function normalizePosix(inputPath) {
	return inputPath.replace(/\\\\/g, '/');
}

function isJsFile(filePath) {
	return /\.(js|mjs|cjs|jsx)$/i.test(filePath);
}

async function resolveExportEntrypoints(pkgDir, packageJson) {
	const candidates = new Set();

	const addCandidate = (value) => {
		if (!value || typeof value !== 'string') return;
		const normalized = normalizePosix(value).replace(/^\.\//, '');
		if (!normalized) return;
		candidates.add(normalized);
	};

	addCandidate(packageJson.main);
	addCandidate(packageJson.module);
	addCandidate(packageJson.browser);

	const walkExports = (node) => {
		if (!node) return;
		if (typeof node === 'string') {
			addCandidate(node);
			return;
		}
		if (Array.isArray(node)) {
			node.forEach(walkExports);
			return;
		}
		if (typeof node === 'object') {
			Object.values(node).forEach(walkExports);
		}
	};

	walkExports(packageJson.exports);

	const defaultEntrypoints = [
		'index.js',
		'index.mjs',
		'index.cjs',
		'dist/index.js',
		'lib/index.js',
		'src/index.js',
	];
	defaultEntrypoints.forEach(addCandidate);

	const resolved = [];

	for (const rel of candidates) {
		const base = path.resolve(pkgDir, rel);
		const withCandidates = [
			base,
			`${base}.js`,
			`${base}.mjs`,
			`${base}.cjs`,
			`${base}.jsx`,
			path.join(base, 'index.js'),
			path.join(base, 'index.mjs'),
			path.join(base, 'index.cjs'),
		];

		for (const maybe of withCandidates) {
			try {
				const stat = await fsp.stat(maybe);
				if (stat.isFile() && isJsFile(maybe)) {
					resolved.push(maybe);
					break;
				}
			} catch (_) {
				// Ignore missing candidates.
			}
		}
	}

	return [...new Set(resolved)];
}

async function getTarballUrl(pkgName, version) {
	const spec = `${pkgName}@${version}`;
	const { stdout } = await execFileAsync('npm', ['view', spec, 'dist.tarball', '--json'], {
		maxBuffer: 10 * 1024 * 1024,
	});

	const text = stdout.trim();
	if (!text) {
		throw new Error(`npm view returned empty tarball url for ${spec}`);
	}

	const parsed = JSON.parse(text);
	if (typeof parsed !== 'string' || !parsed.startsWith('http')) {
		throw new Error(`Invalid tarball url for ${spec}`);
	}

	return parsed;
}

async function downloadAndExtractPackage(pkgName, version) {
	const tarballUrl = await getTarballUrl(pkgName, version);
	const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bccheck-api-'));
	const archivePath = path.join(tempRoot, 'package.tgz');
	const extractedRoot = path.join(tempRoot, 'extract');
	await fsp.mkdir(extractedRoot, { recursive: true });

	await execFileAsync('curl', ['-L', tarballUrl, '-o', archivePath], {
		maxBuffer: 10 * 1024 * 1024,
	});

	await execFileAsync('tar', ['-xzf', archivePath, '-C', extractedRoot], {
		maxBuffer: 10 * 1024 * 1024,
	});

	const pkgDir = path.join(extractedRoot, 'package');
	return { tempRoot, pkgDir };
}

async function resolvePackageSource({ libraryName, version, commitId, packageDir }) {
	if (packageDir) {
		return {
			tempRoot: null,
			pkgDir: path.resolve(packageDir),
			targetVersion: version || commitId || null,
		};
	}

	if (!libraryName || !libraryName.trim()) {
		throw new Error('libraryName is required.');
	}

	const targetVersion = buildTargetVersion({ version, commitId });
	const extracted = await downloadAndExtractPackage(libraryName.trim(), targetVersion);

	return {
		tempRoot: extracted.tempRoot,
		pkgDir: extracted.pkgDir,
		targetVersion,
	};
}

async function collectExportedApisFromPackage(pkgDir) {
	const packageJsonPath = path.join(pkgDir, 'package.json');
	let packageJson = {};

	try {
		const raw = await fsp.readFile(packageJsonPath, 'utf8');
		packageJson = JSON.parse(raw);
	} catch (_) {
		packageJson = {};
	}

	const entrypoints = await resolveExportEntrypoints(pkgDir, packageJson);
	const apiMap = new Map();

	for (const entry of entrypoints) {
		try {
			const sourceCode = await fsp.readFile(entry, 'utf8');
			const functions = await analyzeFile(entry, 0);
			for (const fn of functions) {
				if (!fn || !fn.name) continue;
				const key = JSON.stringify({ name: fn.name, arg: fn.arg || [] });
				if (!apiMap.has(key)) {
					const code = typeof fn.start === 'number' && typeof fn.end === 'number'
						? sourceCode.slice(fn.start, fn.end)
						: '';
					apiMap.set(key, {
						name: fn.name,
						arg: fn.arg || [],
						sourceFile: path.relative(pkgDir, entry),
						code,
					});
				}
			}
		} catch (error) {
			console.warn(`Entry analysis failed: ${entry}`);
			console.warn(error.message || error);
		}
	}

	return [...apiMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildLibraryResult(libName, versionToApis) {
	const versions = [...versionToApis.keys()]
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.map((version) => ({
			version,
			apis: versionToApis.get(version),
		}));

	return {
		library: libName,
		versions,
	};
}

async function collectDependencyTreeFromPackage(pkgDir) {
	const analysis = await analyzeFunctionDependencies(pkgDir);
	const trees = await buildDependencyTrees(analysis, pkgDir);
	return {
		trees,
		text: renderDependencyTrees(trees),
	};
}

function buildLibraryTreeResult(treeResult) {
	return {
		trees: treeResult.trees,
		text: treeResult.text,
	};
}

function buildTargetVersion({ version, commitId }) {
	if (version && version.trim()) return version.trim();
	if (commitId && commitId.trim()) return commitId.trim();
	throw new Error('version or commitId is required.');
}

async function analyzeLibrary({ libraryName, version, commitId = null, packageDir = null }) {
	let tempRoot = null;
	try {
		const source = await resolvePackageSource({ libraryName, version, commitId, packageDir });
		tempRoot = source.tempRoot;
		const resolvedLibraryName = packageDir
			? (libraryName && libraryName.trim() ? libraryName.trim() : path.basename(path.resolve(packageDir)))
			: libraryName.trim();

		const apis = await collectExportedApisFromPackage(source.pkgDir);
		const treeResult = await collectDependencyTreeFromPackage(source.pkgDir);
		const apiResult = buildLibraryResult(resolvedLibraryName, new Map([[source.targetVersion || 'local', apis]]));

		return {
			libraryName: resolvedLibraryName,
			version: source.targetVersion,
			commitId,
			apis,
			dependencyTrees: treeResult.trees,
			dependencyTreeText: treeResult.text,
			apiResult,
			treeResult: buildLibraryTreeResult(treeResult),
			counts: {
				apis: apis.length,
				dependencyTrees: treeResult.trees.length,
			},
		};
	} finally {
		if (tempRoot) {
			await fsp.rm(tempRoot, { recursive: true, force: true });
		}
	}
}

function parseCliArgs(argv) {
	const args = { libraryName: '', version: '', commitId: '' };

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if ((token === '--library' || token === '-l') && argv[index + 1]) {
			args.libraryName = argv[index + 1];
			index += 1;
			continue;
		}
		if ((token === '--version' || token === '-v') && argv[index + 1]) {
			args.version = argv[index + 1];
			index += 1;
			continue;
		}
		if ((token === '--commit' || token === '-c') && argv[index + 1]) {
			args.commitId = argv[index + 1];
			index += 1;
		}
	}

	return args;
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));

	if (!args.libraryName) {
		throw new Error('Usage: node src/main.js --library <name> [--version <ver> | --commit <id>]');
	}

	const result = await analyzeLibrary({
		libraryName: args.libraryName,
		version: args.version,
		commitId: args.commitId,
	});

	console.log(`Analyzed ${result.libraryName}@${result.version || 'local'}`);
	console.log(`  -> ${result.counts.apis} APIs found`);
	console.log(`  -> ${result.counts.dependencyTrees} dependency trees found`);

	return result;
}

module.exports = {
	parseCsvLine,
	buildTargetVersion,
	resolveExportEntrypoints,
	collectExportedApisFromPackage,
	collectDependencyTreeFromPackage,
	analyzeLibrary,
	analyzeTarget: analyzeLibrary,
	resolvePackageSource,
	parseCliArgs,
	main,
};

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
