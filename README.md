# api-tracer

npm パッケージから公開 API と関数依存ツリーを抽出する Node.js ライブラリです。

## できること

- npm からパッケージ tarball を取得します。
- パッケージのエントリポイントから公開 API 関数を抽出します。
- 同一ファイル内のヘルパー関数や import された関数も含めて、関数依存ツリーを作成します。
- 結果をオブジェクトとして返します。

## 使い方

ライブラリとして使う場合:

```js
const { analyzeLibrary } = require('api-tracer');

async function run() {
	const result = await analyzeLibrary({
		libraryName: 'big.js',
		version: '5.1.2',
	});

	console.log(result.libraryName);
	console.log(result.version);
	console.log(result.apis);
	console.log(result.dependencyTrees);
}

run().catch(console.error);
```

commit id を指定する場合:

```js
const result = await analyzeLibrary({
	libraryName: 'big.js',
	commitId: 'abc123',
});
```

ローカルの展開済みパッケージを直接解析することもできます。

```js
const result = await analyzeLibrary({
	packageDir: '/absolute/path/to/package',
	libraryName: 'big.js',
});
```

## 戻り値の例

`dependencyTreeText` は、たとえば次のようになります。

```text
📄 src/main.js
	└─ decl: parseCsvLine (src/main.js)
	└─ decl: main (src/main.js)
		 └─ use: parseCsvLine [same-file] (src/main.js)
```

`apiResult` のイメージ:

```json
{
	"library": "big.js",
	"versions": [
		{
			"version": "5.1.2",
			"apis": [
				{
					"name": "Big",
					"arg": ["n"],
					"sourceFile": "index.js"
				}
			]
		}
	]
}
```

## テスト

すべてのテストを実行する場合:

```bash
npm test
```

ライブラリ公開面の確認だけを実行する場合:

```bash
npm run test:main
```

## 関数抽出機能（Function Extraction）

このプロジェクトには、パッケージのエントリポイントから関数を抽出し、エクスポート判定と関数依存情報を生成する機能が含まれています。

- 主要モジュール:
	- `src/api/search/getFunction.js` — 関数ノードの抽出（内部実装）
	- `src/api/function-analysis.js` — `analyzeFile(filePath, mode)` を提供し、`getFunction` の結果に `isExported` フラグを付与して返します

- `analyzeFile(filePath, mode)` の使い方:
	- `filePath` : 解析対象のファイル（パッケージのエントリポイントの絶対パスなど）
	- `mode` : `0` = エクスポートされた関数のみ返す、`1` = 全関数を返す

```js
const { analyzeFile } = require('./src/api/function-analysis');

(async () => {
	const entry = '/absolute/path/to/package/index.js';
	// 全関数を抽出
	const all = await analyzeFile(entry, 1);
	// エクスポート関数のみ抽出
	const exported = await analyzeFile(entry, 0);

	console.log(exported.map(f => f.name));
})();
```

注意: `analyzeFile` が返す各関数オブジェクトには `bodyStart` / `bodyEnd` / `body` が含まれます。`body` は関数本体（波かっこ内）のソース文字列です。

- テストと CLI:
	- 統合テスト：`test/function-extraction-test.js`（`npm test` で実行されます）
	- 直接実行する場合:

```bash
npm install
# 統合テストを実行
npm test
# 単体で関数抽出テストのみ実行する場合
node test/function-extraction-test.js
```

- 注意事項:
	- `test/function-extraction-test.js` は npm レジストリから tarball をダウンロードして解析します。`curl` と `tar` が利用可能で、ネットワーク接続が必要です。
	- 内部 API のため、ライブラリの公開インターフェースは将来変更される可能性があります。必要であればラッパー関数を用意してください。
