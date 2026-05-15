const assert = require('assert');

const mainModule = require('../src/main');

function testExports() {
  const requiredFunctions = [
    'parseCliArgs',
    'buildTargetVersion',
    'resolvePackageSource',
    'analyzeLibrary',
    'analyzeTarget',
    'main',
  ];

  for (const fnName of requiredFunctions) {
    assert.strictEqual(typeof mainModule[fnName], 'function', `${fnName} should be exported as function`);
  }
}

function testAnalyzeAlias() {
  assert.strictEqual(
    mainModule.analyzeLibrary,
    mainModule.analyzeTarget,
    'analyzeTarget should remain an alias of analyzeLibrary'
  );
}

function testParseCliArgsLongOptions() {
  const args = mainModule.parseCliArgs([
    '--library', 'big.js',
    '--version', '5.1.2',
    '--commit', 'abc123',
  ]);

  assert.strictEqual(args.libraryName, 'big.js');
  assert.strictEqual(args.version, '5.1.2');
  assert.strictEqual(args.commitId, 'abc123');
}

function testParseCliArgsShortOptions() {
  const args = mainModule.parseCliArgs([
    '-l', 'lodash',
    '-v', '4.17.21',
    '-c', 'deadbeef',
  ]);

  assert.strictEqual(args.libraryName, 'lodash');
  assert.strictEqual(args.version, '4.17.21');
  assert.strictEqual(args.commitId, 'deadbeef');
}

function testParseCliArgsMissingValues() {
  const args = mainModule.parseCliArgs(['--library', 'react']);

  assert.strictEqual(args.libraryName, 'react');
  assert.strictEqual(args.version, '');
  assert.strictEqual(args.commitId, '');
}

function testBuildTargetVersionPriority() {
  assert.strictEqual(
    mainModule.buildTargetVersion({ version: '1.2.3', commitId: 'abcdef' }),
    '1.2.3',
    'version should take precedence over commitId'
  );

  assert.strictEqual(
    mainModule.buildTargetVersion({ version: '', commitId: 'abcdef' }),
    'abcdef',
    'commitId should be used when version is empty'
  );
}

function testBuildTargetVersionValidation() {
  assert.throws(
    () => mainModule.buildTargetVersion({ version: '', commitId: '' }),
    /version or commitId is required\./
  );
}

function run() {
  testExports();
  testAnalyzeAlias();
  testParseCliArgsLongOptions();
  testParseCliArgsShortOptions();
  testParseCliArgsMissingValues();
  testBuildTargetVersionPriority();
  testBuildTargetVersionValidation();

  console.log('main-cli-test: all tests passed');
}

run();
