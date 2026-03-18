# CLAUDE.md — Image Metadata Viewer

## Overview

VS Code拡張機能。画像ファイルのメタデータ（SD / ComfyUI / EXIF）をサイドパネルに表示する。
旧名: `sd-metadata-viewer`。現在のバージョン: **1.0.0** / VS Code `^1.85.0` 必須。

## Project Structure

```
src/
├── extension.ts        # エントリポイント: コマンド登録, タブ変更リスナー, パネル管理
├── webviewContent.ts   # Webview HTML 生成 (SD / ComfyUI / EXIF / No metadata)
├── metadataParser.ts   # SD メタデータ文字列パース (A1111 形式)
├── comfyuiParser.ts    # ComfyUI ノードグラフ JSON パース (プロンプト・設定抽出)
├── pngReader.ts        # PNG バイナリ解析 (tEXt チャンク読み取り)
└── exifReader.ts       # JPEG EXIF バイナリ解析 (IFD0/ExifSubIFD/GPS タグ)
out/                    # コンパイル済みJS + sourcemap
*.vsix                  # パッケージ済みリリース
```

## Build & Development

```bash
npm run compile    # 単発ビルド
npm run watch      # watchモード (開発時推奨)
npm run package    # .vsix 生成 (npx @vscode/vsce package --no-dependencies)
```

- **依存**: ランタイム依存なし。devDeps は `typescript`, `@types/vscode`, `@types/node` のみ

## Architecture

### コマンド駆動
- `imageMetadata.show` コマンドで起動（右クリックメニュー / エディタタイトル）
- パネルはシングルトン（`currentPanel` 変数で管理）
- アクティブタブ変更時に自動で連動更新

### 対応フォーマット
- **PNG → SD Metadata**: tEXt チャンクの `parameters` キーを A1111 形式でパース
- **PNG → ComfyUI**: tEXt チャンクの `prompt` / `workflow` キーをノードグラフとしてパース
- **JPEG → EXIF**: APP1 セグメントの TIFF/IFD 構造を解析

### セキュリティ
- CSP: `default-src 'none'` + nonce ベースの script allowlist
- `escapeHtml()` でファイル名・メタデータ値の XSS を防止
- クリップボードコピーは `vscode.postMessage` → Extension 側で `vscode.env.clipboard` を使用

## Supported File Types

- **PNG**: SD Metadata (A1111), ComfyUI ノードグラフ
- **JPG / JPEG**: EXIF データ

## Commands

| Command ID | Description | Trigger |
|------------|-------------|---------|
| `imageMetadata.show` | メタデータパネル表示 | Explorer右クリック / エディタタイトルボタン |

## 表示内容

### SD Metadata
- サムネイルプレビュー画像
- **SD Metadata** バッジ
- Positive Prompt（コピーボタン付き）
- Negative Prompt（コピーボタン付き）
- Generation Settings テーブル（行コピーボタン付き）
- Raw Metadata（折りたたみ、コピーボタン付き）

### ComfyUI
- サムネイルプレビュー画像
- **ComfyUI** バッジ
- Positive / Negative Prompt
- Generation Settings テーブル
- Raw Prompt JSON / Raw Workflow JSON（折りたたみ）

### EXIF
- サムネイルプレビュー画像
- **EXIF** バッジ
- Camera / Shooting / Image / GPS / Other カテゴリ別テーブル
- 人間が読みやすいラベル（FNumber → Aperture 等）

## Code Conventions

- **命名**: 関数は camelCase、定数は UPPER_CASE
- **非同期処理**: `fs.promises` + async/await
- **コメント**: 日本語で記述可
- **型安全**: `tsconfig.json` で `strict: true`

## Key Implementation Notes

- `webviewContent.ts` に SD / EXIF / ComfyUI / No metadata の4種類の HTML 生成関数
- タブ切り替え時の自動更新は `onDidChangeTabGroups` + `onDidChangeActiveTextEditor` の両方でリスン
- ファイル先頭 64KB のみ読み取り（メタデータは IDAT/SOS の前に格納されるため）
- サムネイルプレビューは `webview.asWebviewUri()` で安全に表示
- VS Code テーマ変数 (`var(--vscode-*)`) でテーマ統合

## When Making Changes

- 新しいメタデータフォーマット対応: `extension.ts` の判定ロジック + `webviewContent.ts` に HTML 生成関数を追加
- WebView の HTML 変更時は CSP ヘッダーとの整合性を確認すること
- メタデータ関連コード（`pngReader.ts`, `metadataParser.ts`, `comfyuiParser.ts`, `exifReader.ts`）は `image-thumbnail-explorer` と共有。変更時は両プロジェクトを同期すること
