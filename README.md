# 辞書番 -しりとり道場-

API不使用・完全オフラインで動くしりとり対戦アプリ。GitHub Pages でそのまま公開できます。

## 構成

```
index.html          画面本体
style.css            スタイル
script.js             ゲームロジック(判定・辞書番のAI思考)
kana.js               かな処理ユーティリティ(script.js / テストの両方から読み込む)
words-core.json        手作業で日本語の意味を付けたコア辞書(約180語)
words-auto.json        自動取得分の辞書(scripts/fetch-words.mjs が生成、未生成でも動作する)
scripts/fetch-words.mjs  words-auto.json を自動生成するビルドスクリプト
test/kana.test.mjs      語尾判定(analyzeEnding/startKana)のユニットテスト
```

起動時、`script.js` は `words-core.json` と `words-auto.json` を両方読み込み、
読み(reading)が重複する場合は `words-core.json` を優先してマージします。
`words-auto.json` が無い(未生成の)状態でもコア辞書だけで動作します。

## ルール仕様(重要)

- **あなたの入力は「実在する言葉である」と信頼し、辞書と照合して合否判定はしません。**
  読み(かな)を特定する必要があるため、ひらがな/カタカナでの入力を前提にしています。
  (辞書に載っている語を漢字で打った場合は辞書の読みを流用します)
- 読みの先頭が直前の語の指定音と一致しているか、既出でないかはチェックします。
- **読みが「ん」で終わった側が、その場で負けになります。** あなた・辞書番どちらの場合も判定します。
- 辞書番(AI)は `words-core.json` / `words-auto.json` の中からしか手を選べません。強さ「めちゃ強い」は、
  次の一手を選ぶ際に「その手を打つとあなたの返せる語が何個残るか」を計算し、
  一番少なくなる手を選ぶ簡易な先読み(1手読み)で実現しています。

## 開発環境での起動

`fetch` で辞書データを読み込むため、`file://` で直接開くとブラウザによっては
CORSエラーになります。簡易サーバー経由で開いてください。

```bash
npm install
npm run serve
# → http://localhost:3000 などが表示されるのでブラウザで開く
```

VSCode を使うなら「Live Server」拡張機能でも同様に動きます。

## テスト

```bash
npm test
```

`kana.js` の語尾判定(「ん」で即負け、長音「ー」の母音変換、拗音「ゃゅょ」の正規化など)を
Node標準の `node --test` で検証します。

## 語彙を増やす(自動化)

`words-core.json` は手作業で日本語の意味を付けた約180語です。もっと語彙を増やしたい場合、
[JMdict-simplified / JMnedict-simplified](https://github.com/scriptin/jmdict-simplified)
(オープンな日本語辞書データ、CC BY-SA 4.0)から語を自動抽出するスクリプトを用意しています。

```bash
npm install
npm run fetch-words
```

これで `words-auto.json` が数万語規模に生成されます。**このスクリプトの実行にAIやAPIトークンは
一切使いません。GitHubから公開データをダウンロードして加工するだけのビルドステップです。**

抽出対象は3種類です:

- **一般名詞** … JMdict の「よく使われる」語のうち、品詞タグが名詞系(`n`, `n-adv`, `n-t`,
  `n-pref`, `n-suf`)のものだけ。形容詞・感動詞・表現(フレーズ)は含みません。
- **ことわざ・故事成語** … JMdict の `misc` タグに `proverb` / `yoji` が付いた語。
- **固有名詞** … JMnedict から地名・組織名・企業名・人名(姓/名)などを種別ごとに
  上限を設けて抽出します(無名すぎる人名で辞書が埋まらないよう、種別ごとに件数上限あり。
  `scripts/fetch-words.mjs` 内の `CAPS` で調整できます)。

### 既知のトレードオフ

- JMdict由来の意味(gloss)は英語のみです。`words-auto.json` の一般名詞・ことわざ/故事成語には
  `"(en) ..."` という注記付きで英語の意味がそのまま入ります。固有名詞は英語の原音表記の代わりに
  「地名」「姓」などの種別ラベルを意味欄に入れています。
- 固有名詞(特に人名)は読みの短い語を優先していますが、専門用語・古い言葉なども混ざります。
  必要に応じて `scripts/fetch-words.mjs` 内の `CAPS` やフィルタ条件を調整してください。

## GitHub Pages への公開

静的ファイルのみで構成されているため、ビルドステップ無しでそのまま公開できます。
リポジトリの Settings → Pages で「Deploy from a branch」を選び、`main` ブランチの
ルート(`/`)を指定してください。`words-auto.json` を使う場合は、事前に
`npm run fetch-words` を実行して生成物をコミットしておく必要があります
(Pages はビルドを実行しないため)。

## ライセンス表記

`words-auto.json` を JMdict/JMnedict由来のデータで生成した場合は、EDRDGの利用条件に従い
クレジット表記(例: "This application uses the JMdict and JMnedict dictionary files.
These files are the property of the Electronic Dictionary Research and
Development Group, and are used in conformance with the Group's licence.")
をどこかに残してください。
