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