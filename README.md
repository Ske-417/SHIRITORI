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
  お互いが同じ基準(相手の選択肢を最も減らす手)で最適に打ち続けたと仮定して3手先まで読み、
  相手の選択肢が一番少なくなる手を選ぶ先読み(`script.js` の `minimaxOptions`)で実現しています。

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

これで `words-auto.json` が数万〜十万語規模に生成されます(現在のリポジトリ同梱データは
約150,000語)。**このスクリプトの実行にAIやAPIトークンは一切使いません。GitHubやWikidataから
公開データをダウンロードして加工するだけのビルドステップです。**

抽出対象は6種類です:

- **一般名詞** … JMdict の「よく使われる」語のうち、品詞タグが名詞系(`n`, `n-adv`, `n-t`,
  `n-pref`, `n-suf`)のものだけ。形容詞・感動詞・表現(フレーズ)は含みません。
- **ことわざ・故事成語** … JMdict の `misc` タグに `proverb` / `yoji` が付いた語。
- **医学・化学系専門用語** … JMdict の `field` タグが `med`/`chem`/`biochem`/`pharm`/`anat`/
  `physiol`/`pathol`/`genet`/`dent`/`surg`/`embryo`/`vet` のいずれかの語(「よく使われる」条件は
  外している。専門用語はそもそも一般的な語ではないため)。
- **神話**(JMdict由来) … JMdict の `field` タグが `grmyth`/`rommyth`/`chmyth`/`jpmyth`
  (ギリシャ/ローマ/中国/日本神話)の語。
- **神話・架空の存在**(Wikidata由来) … [Wikidata](https://www.wikidata.org/)のSPARQL
  エンドポイントから、「神」「神話・伝説の生物」「架空のキャラクター」に分類されている
  項目のうち日本語ラベルが純粋なかなのものを抽出します。JMnedictのchar/myth種別だけでは
  件数が少なすぎるため(合計300語程度)の補完です。Wikidataは日本語の短い説明文
  (例: ゼウス→「ギリシャ神話の最高神」)を持つことが多く、それをそのまま意味欄に使い、
  末尾に `[Wikidata:Q番号]` で出典を明記しています。ワンパンマンなどのアニメキャラクターも
  多数含まれます。
- **固有名詞**(JMnedict由来) … 地名・組織名・企業名・作品名・海外の地名や著名人・
  神話上の人物・架空のキャラクターなどを抽出します。**個人の実名を表す種別
  (person/surname/given/fem/masc/unclass)は、JMnedict上で生没年などの伝記情報が
  確認できる語(=著名人と判定できる語)だけを採用し、意味欄にはその伝記情報自体を
  使います**(例: アインシュタイン→「Einstein, Albert (1879-1955; German-born
  theoretical physicist)」。しりとり中にそのまま「誰なのか」が分かるようにするためです)。
  JMnedictの姓/名/女性の名/男性の名は単なる名前読みの辞書であり、著名かどうかとは無関係に
  大量の無名な人名を含むため(実測: 伝記情報が付いている割合は女性の名で0.13%、名で0.04%程度)、
  この条件を課さないと聞いたこともない人名がゲームに出てきてしまいます。
  一方、地名・組織名や、JMnedict自体が架空/神話上の存在として分類している種別
  (char/dei/fict/creat/myth/leg)には伝記情報を要求しません(分類自体が根拠のため)。
  `scripts/fetch-words.mjs` 内の `CAPS` / `PERSON_TYPES_REQUIRE_BIO` で調整できます。

### 既知のトレードオフ

- JMdict由来の意味(gloss)は英語のみです。`words-auto.json` の一般名詞・ことわざ/故事成語・
  専門用語・神話(JMdict由来)には `"(en) ..."` という注記付きで英語の意味がそのまま入ります。
  Wikidata由来の語は日本語の説明文(無ければ種別ラベル)+出典タグ、JMnedict由来の固有名詞は
  伝記情報(人物)または種別ラベル(地名など)を意味欄に入れています。
- 人名の著名性判定はJMnedictの伝記情報(生没年表記)の有無に頼っているため、フルネームの
  エントリには伝記情報があっても、姓だけの別エントリ(例: 「シェイクスピア」単体)には
  伝記情報が付いていないことがあり、その場合は姓単体のエントリは採用されません。
  無名な人名を出さないことを優先したトレードオフです。
- Wikidataのラベルは漢字表記のみのことが多く、その場合は読み(ふりがな)が分からないため
  対象外にしています(日本語ラベルが純粋なかなの項目だけを採用)。そのため、外来語由来の
  神・妖怪・キャラクターに比べて日本古来の神話上の存在はやや少なめです。
- JMdict/JMnedict/Wikidata は一般公開のデータであり、際どい語義や専門用語なども含まれます
  (人名以外は意図的にフィルタをかけていません)。必要であれば `scripts/fetch-words.mjs`
  側でフィルタ条件を追加してください。

## GitHub Pages への公開

静的ファイルのみで構成されているため、ビルドステップ無しでそのまま公開できます。
リポジトリの Settings → Pages で「Deploy from a branch」を選び、`main` ブランチの
ルート(`/`)を指定してください。`words-auto.json` を使う場合は、事前に
`npm run fetch-words` を実行して生成物をコミットしておく必要があります
(Pages はビルドを実行しないため)。

## ライセンス表記

- `words-auto.json` を JMdict/JMnedict由来のデータで生成した場合は、EDRDGの利用条件に従い
  クレジット表記(例: "This application uses the JMdict and JMnedict dictionary files.
  These files are the property of the Electronic Dictionary Research and
  Development Group, and are used in conformance with the Group's licence.")
  をどこかに残してください。
- 神話・架空の存在の一部は [Wikidata](https://www.wikidata.org/) から取得しています。
  Wikidataの構造化データは [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
  (パブリックドメイン相当)で提供されており、各語の意味欄末尾の `[Wikidata:Q番号]` から
  個別の出典(`https://www.wikidata.org/wiki/Q番号`)を確認できます。
