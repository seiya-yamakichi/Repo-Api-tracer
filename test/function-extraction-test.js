/**
 * Function Extraction Test
 * 
 * getFunction.js と function-analysis.js が正確に関数を抽出するかをテストします
 * - mode=1: 全関数を抽出
 * - mode=0: export 関数のみを抽出
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// テスト対象のパッケージとバージョン
const TEST_PACKAGES = [
  { name: 'big.js', version: '3.2.0' },
];

// 期待ファイルのパス
const EXPECTED_OUTPUT_DIR = path.join(__dirname, '..', 'output', 'api');

// ========================================
// ユーティリティ関数
// ========================================

async function getTarballUrl(pkgName, version) {
  const spec = `${pkgName}@${version}`;
  const { stdout } = await execFileAsync('npm', ['view', spec, 'dist.tarball', '--json']);
  return JSON.parse(stdout.trim());
}

async function downloadAndExtractPackage(pkgName, version) {
  const tarballUrl = await getTarballUrl(pkgName, version);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'test-extract-'));
  const archivePath = path.join(tempRoot, 'package.tgz');
  const extractedRoot = path.join(tempRoot, 'extract');
  await fs.mkdir(extractedRoot, { recursive: true });

  await execFileAsync('curl', ['-L', tarballUrl, '-o', archivePath]);
  await execFileAsync('tar', ['-xzf', archivePath, '-C', extractedRoot]);

  const pkgDir = path.join(extractedRoot, 'package');
  return { tempRoot, pkgDir };
}

async function loadExpectedOutput(pkgName) {
  const expectedPath = path.join(EXPECTED_OUTPUT_DIR, `${pkgName}.json`);
  try {
    const content = await fs.readFile(expectedPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// ========================================
// テスト実行
// ========================================

async function runTest(pkgName, version) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${pkgName}@${version}`);
  console.log(`${'='.repeat(60)}`);

  let tempRoot = null;

  try {
    // 1. パッケージをダウンロード・抽出
    console.log(`[1/4] Downloading ${pkgName}@${version}...`);
    const extracted = await downloadAndExtractPackage(pkgName, version);
    const pkgDir = extracted.pkgDir;
    tempRoot = extracted.tempRoot;

    // 2. エントリーポイントを解決
    console.log(`[2/4] Resolving entry points...`);
    const { analyzeFile } = require('../src/api/function-analysis');
    const { getFunction } = require('../src/api/search/getFunction');

    const packageJsonPath = path.join(pkgDir, 'package.json');
    let packageJson = {};
    try {
      const raw = await fs.readFile(packageJsonPath, 'utf8');
      packageJson = JSON.parse(raw);
    } catch (_) {
      packageJson = {};
    }

    // エントリーポイント候補
    const candidates = [];
    if (packageJson.main) candidates.push(path.join(pkgDir, packageJson.main));
    if (packageJson.module) candidates.push(path.join(pkgDir, packageJson.module));
    if (packageJson.browser) candidates.push(path.join(pkgDir, packageJson.browser));

    if (candidates.length === 0) {
      candidates.push(path.join(pkgDir, 'index.js'));
    }

    let mainEntry = null;
    for (const c of candidates) {
      try {
        await fs.stat(c);
        mainEntry = c;
        break;
      } catch (_) {
        // continue
      }
    }

    if (!mainEntry) {
      console.error('❌ Entry point not found');
      return;
    }

    // 3. 全関数を抽出（mode=1）
    console.log(`[3/4] Extracting ALL functions (mode=1)...`);
    const allFunctions = await analyzeFile(mainEntry, 1);
    console.log(`     Found ${allFunctions.length} functions (total)`);

    // 4. export 関数を抽出（mode=0）
    console.log(`[4/4] Extracting EXPORTED functions (mode=0)...`);
    const exportedFunctions = await analyzeFile(mainEntry, 0);
    console.log(`     Found ${exportedFunctions.length} functions (exported)`);

    // 結果出力
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Results:`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`\nAll Functions (${allFunctions.length}):`);
    allFunctions.slice(0, 10).forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.name}`);
    });
    if (allFunctions.length > 10) {
      console.log(`  ... and ${allFunctions.length - 10} more`);
    }

    console.log(`\nExported Functions (${exportedFunctions.length}):`);
    exportedFunctions.slice(0, 10).forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.name}`);
    });
    if (exportedFunctions.length > 10) {
      console.log(`  ... and ${exportedFunctions.length - 10} more`);
    }

    // 期待ファイルとの比較
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Comparison with Expected Output:`);
    console.log(`${'─'.repeat(60)}`);

    const expected = await loadExpectedOutput(pkgName);
    if (expected) {
      const expectedV = expected.versions.find(v => v.version === version);
      if (expectedV) {
        const expectedNames = new Set(expectedV.apis.map(a => a.name));
        const actualNames = new Set(exportedFunctions.map(f => f.name));

        console.log(`\nExpected: ${expectedV.apis.length} functions`);
        console.log(`Actual:   ${exportedFunctions.length} functions`);

        let missing = [];
        let extra = [];

        for (const n of expectedNames) {
          if (!actualNames.has(n)) missing.push(n);
        }

        for (const n of actualNames) {
          if (!expectedNames.has(n)) extra.push(n);
        }

        if (missing.length === 0 && extra.length === 0) {
          console.log(`\n✅ PASS: Perfect match with expected output`);
        } else {
          if (missing.length > 0) {
            console.log(`\n⚠️  Missing ${missing.length} function(s):`);
            missing.forEach(m => console.log(`    - ${m}`));
          }
          if (extra.length > 0) {
            console.log(`\n⚠️  Extra ${extra.length} function(s):`);
            extra.forEach(e => console.log(`    + ${e}`));
          }
          console.log(`\n⚠️  PARTIAL MATCH: ${expectedNames.size - missing.length}/${expectedNames.size} functions matched`);
        }
      }
    }

    // 詳細レポート（JSON出力）
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Detailed Report (JSON):`);
    console.log(`${'─'.repeat(60)}`);
    const report = {
      package: pkgName,
      version: version,
      totalFunctions: allFunctions.length,
      exportedFunctions: exportedFunctions.length,
      functions: exportedFunctions.map(f => ({
        name: f.name,
        args: f.arg,
        isExported: f.isExported,
      })),
    };
    console.log(JSON.stringify(report, null, 2));

  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    console.error(error);
  } finally {
    if (tempRoot) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch (_) {
        // Ignore cleanup errors
      }
    }
  }
}

// ========================================
// Main
// ========================================

async function main() {
  console.log('Function Extraction Test Suite');
  console.log('==============================\n');

  for (const pkg of TEST_PACKAGES) {
    await runTest(pkg.name, pkg.version);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Test Suite Complete');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
