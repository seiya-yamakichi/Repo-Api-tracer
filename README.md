# repo-api-tracer

npm パッケージから公開 API と関数依存ツリーを抽出する Node.js ライブラリです。

## 目次

- [できること](#できること)
- [インストール](#インストール)
- [使い方](#使い方)
- [戻り値の例](#戻り値の例)
- [関数抽出機能](#関数抽出機能function-extraction)
- [エクスポートメタデータ](#エクスポートメタデータ-exportkind)
- [CLI での JSON 出力](#cli-での-json-出力)
- [テスト](#テスト)
- [注意事項](#注意事項)

## できること

- 📦 npm からパッケージ tarball を取得
- 🔍 パッケージのエントリポイントから公開 API 関数を抽出
- 🌳 同一ファイル内のヘルパー関数や import された関数を含めた関数依存ツリーを作成
- 📤 結果をオブジェクトとして返却

## インストール

```bash
npm install
```

## 使い方

### ライブラリとして使う

```js
const { analyzeLibrary } = require('repo-api-tracer');

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

### commit id を指定する

```js
const result = await analyzeLibrary({
  libraryName: 'big.js',
  commitId: 'abc123',
});
```

### ローカルの展開済みパッケージを解析する

```js
const result = await analyzeLibrary({
  packageDir: '/absolute/path/to/package',
  libraryName: 'big.js',
});
```

## 戻り値の例

**`dependencyTreeText`**

```text
📄 src/main.js
  └─ decl: parseCsvLine (src/main.js)
  └─ decl: main (src/main.js)
       └─ use: parseCsvLine [same-file] (src/main.js)
```

**`apiResult`**

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

## 関数抽出機能（Function Extraction）

パッケージのエントリポイントから関数を抽出し、エクスポート判定と関数依存情報を生成する機能です。

| モジュール | 役割 |
|---|---|
| `src/api/search/getFunction.js` | 関数ノードの抽出（内部実装） |
| `src/api/function-analysis.js` | `analyzeFile(filePath, mode)` を提供し、`getFunction` の結果に `isExported` フラグを付与 |

### `analyzeFile(filePath, mode)`

| 引数 | 説明 |
|---|---|
| `filePath` | 解析対象のファイル（パッケージのエントリポイントの絶対パスなど） |
| `mode` | `0` = エクスポートされた関数のみ返す / `1` = 全関数を返す |

```js
const { analyzeFile } = require('./src/api/function-analysis');

(async () => {
  const entry = '/absolute/path/to/package/index.js';

  const all = await analyzeFile(entry, 1);      // 全関数を抽出
  const exported = await analyzeFile(entry, 0); // エクスポート関数のみ抽出

  console.log(exported.map(f => f.name));
})();
```

## エクスポートメタデータ (`exportKind`)

各関数オブジェクトには、エクスポートの種類を示す `exportKind` フィールドが付与されます。

| 値 | 説明 |
|---|---|
| `none` | エクスポートではない（デフォルト） |
| `named` | `export function foo` / `export const foo = () => {}` のような named export |
| `default` | `export default function ...` のような宣言型 default export |
| `default-assignment` | `module.exports = function(...) {}` のように `module.exports` に直接代入された関数（`name` にはファイル名のベースが割り当てられ、`isExported: true`） |
| `property` | `module.exports.foo = ...` / `exports.bar = ...` のようなプロパティ割当てによるエクスポート |

追加フィールド:

- `exportSource`（任意）— エクスポート元を示す文字列（例: `'module.exports'`、`'exports'`）

**出力例**

```json
{
  "name": "index",
  "isExported": true,
  "exportKind": "property",
  "exportSource": "module.exports",
  "filePath": "index.js",
  "bodyStart": 123,
  "bodyEnd": 456
}
```

## CLI での JSON 出力

関数依存ツリー生成 CLI は JSON オプションをサポートしており、`exportKind` を含む解析結果を得られます。

```bash
node src/api/function-dependencies-tree.js /path/to/package --json > result.json
```

外部パッケージ呼び出しを含める場合は `--include-external`（短縮 `-e`）フラグを使用します。

## テスト

```bash
# すべてのテストを実行
npm test

# ライブラリ公開面の確認だけを実行
npm run test:main

# 関数抽出テストのみ単体実行
node test/function-extraction-test.js
```

統合テストは `test/function-extraction-test.js` に含まれており、`npm test` で実行されます。

## 注意事項

> [!NOTE]
> - `test/function-extraction-test.js` は npm レジストリから tarball をダウンロードして解析します。`curl` と `tar` が利用可能で、ネットワーク接続が必要です。
> - 内部 API のため、ライブラリの公開インターフェースは将来変更される可能性があります。必要であればラッパー関数を用意してください。
