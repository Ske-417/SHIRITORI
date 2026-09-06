#!/usr/bin/env node
/**
 * scripts/fetch-words.mjs
 *
 * JMdict-simplified / JMnedict-simplified (https://github.com/scriptin/jmdict-simplified) の
 * 最新リリースから公開データをダウンロードし、しりとりの手として使える語を抽出して
 * words-auto.tsv を作り直します。
 *
 * 使い方:
 *   npm install
 *   npm run fetch-words
 *
 * 生成物: ../words-auto.tsv (プロジェクトルート、既存ファイルを上書きします。TSV形式で、
 *   1行目はヘッダー w/r/m/t/d。表計算ソフトで開いて確認・編集しやすくするため
 *   JSONではなくTSVを採用している。詳細は ../tsv.js 参照)
 * ※ 手作業で日本語の意味を付けたコア辞書は words-core.tsv に分離してあり、
 *   このスクリプトが触るのは words-auto.tsv だけです。
 *
 * 抽出対象:
 *   1. 一般名詞      … jmdict-eng-common から品詞タグが名詞系のものだけ (よく使われる語のみ)
 *   2. ことわざ・故事成語 … jmdict-eng (フル版) から misc タグ "proverb" / "yoji" が付いた語
 *   3. 専門用語      … jmdict-eng (フル版) から field タグが専門分野を示す語(医学・化学・
 *                    数学・物理・法律・経済・スポーツ・音楽・ゲームなど FIELD_LABELS 参照)
 *   4. 神話          … jmdict-eng (フル版) から field タグが神話系(ギリシャ/ローマ/中国/日本)の語
 *   5. 固有名詞      … jmnedict-all (地名・組織名など「人でないもの」は種別ごとに上限を設けて全採用。
 *                    人物系(person/surname/given/fem/masc/unclass)は、JMnedict上で
 *                    生没年などの伝記情報が確認できるもの=著名人と判定できるものだけを採用する。
 *                    JMnedictの fem/given/masc/surname はただの名前読み辞書であり無名な人物も
 *                    大量に含まれるため、伝記情報という裏付けが無い語は採用しない)
 *   6. 神話・架空の存在(Wikidata) … Wikidata SPARQL(query.wikidata.org)から、
 *                    「神(Q22989102)」「神話・伝説の生物(Q24334685)」
 *                    「架空のキャラクター(Q95074)」に分類されている項目のうち、
 *                    日本語ラベルが純粋なかな(カタカナ/ひらがな)であるものを採用する。
 *                    JMnedictのchar/myth種別だけでは件数が少なすぎるため補完している。
 *                    Wikidataは CC0(パブリックドメイン相当)で公開されている構造化データ。
 *
 * 注意:
 * - JMdict/JMnedict は Electronic Dictionary Research and Development Group (EDRDG) が
 *   CC BY-SA 4.0 で配布しているデータです。配布・公開する場合は
 *   https://www.edrdg.org/jmdict/edict_doc.html のクレジット表記に従ってください。
 * - Wikidata由来のデータは CC0 です(https://www.wikidata.org/wiki/Wikidata:Licensing)。
 *   query.wikidata.org への負荷を抑えるため、説明文の取得はラベル取得とは別のバッチ
 *   クエリに分けている(1回の巨大なクエリにまとめるとタイムアウトしやすいため)。
 * - gloss(意味)は英語のみです。日本語の意味が欲しい語は words-core.tsv 側に追加してください。
 * - Node.js 18 以降 (fetch 標準搭載) が必要です。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import AdmZip from 'adm-zip';
import { stringifyTSV } from '../tsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = 'scriptin/jmdict-simplified';

// しりとりの読みとして許容する文字種(純粋なひらがな+長音のみ)
const KANA_ONLY = /^[ぁ-ゖー]+$/;

// ---------------------------------------------------------------------------
// Wiktionary(日本語版)由来の日本語解説文の補完
//
// JMdict/JMnedict由来の語には英語glossしか無く、これまではWikidataとの表記一致で
// 日本語の説明文(d)を補ってきたが、Wikidataは「実世界の物事」のデータベースであり、
// 一般語・和語動詞・ことわざのような「言葉そのものの意味」を持たないことが多い
// (ことわざは特に、Wikidata側にほぼ項目が無い)。
// kaikki.org (https://kaikki.org/) は Wiktionary の各言語版を構造化データとして
// 抽出・公開しており(wiktextractプロジェクトによる、元データはWiktionary同様
// CC BY-SA 3.0/GFDL)、日本語版Wiktionary(ja.wiktionary.org)の抽出データを
// 追加の情報源として使う。ことわざ・和語動詞・基本語彙で特に効果が大きい。
const WIKTIONARY_URL = 'https://kaikki.org/dictionary/downloads/ja/ja-extract.jsonl.gz';

// 語義が「〜の漢字表記」のような、別の見出し語への言い換えでしかないかどうか。
// 日本語版Wiktionaryは和語動詞などの本体をひらがな見出し(例: 「はしる」)に置き、
// 漢字表記側(例: 「走る」)は言い換えだけの薄い項目にしていることが多いため、
// このような語義は内容が無いものとして無視する。
function isFormOfSense(sense){
  return !!(sense.form_of && sense.form_of.length);
}

// 「いぬ。」のような、見出し語自身の読みをそのまま書いただけの中身の薄い語義を除外する。
const TRIVIAL_GLOSS_MAX_LEN = 4;
function isTrivialGloss(gloss){
  const stripped = gloss.replace(/[。、\s]/g, '');
  if(stripped.length <= TRIVIAL_GLOSS_MAX_LEN && KANA_ONLY.test(stripped)) return true;
  // 「〜の異表記。」「〜の別表記。」のような、別の見出し語への言い換えのみで
  // それ自体は語義の説明になっていないものも同様に除外する。
  if(/の(異|別)表記/.test(gloss)) return true;
  return false;
}

// 1つの見出し語エントリ(1行分のJSON)の senses から、画面表示に使える
// 最初の語義を1つ選ぶ。長すぎる語義は最初の句点までに切り詰める。
// 「（とうきょう）日本の事実上の首都。」のように、見出し語の読みをそのまま
// 括弧書きした前置きが付くことがあるため、表示上冗長なこの部分は取り除く。
const LEADING_KANA_PAREN = /^（[ぁ-ゖー]+）/;
function pickWiktionaryGloss(senses){
  for(const sense of senses || []){
    if(isFormOfSense(sense)) continue;
    let gloss = (sense.glosses || [])[0];
    if(!gloss) continue;
    gloss = gloss.replace(LEADING_KANA_PAREN, '');
    if(isTrivialGloss(gloss)) continue;
    const period = gloss.indexOf('。');
    if(period > 0 && period < 80) return gloss.slice(0, period + 1);
    return gloss.slice(0, 80);
  }
  return null;
}

// kaikki.orgからWiktionary日本語版の抽出データ(JSONL、gzip圧縮)をダウンロードし、
// ストリームのまま(全体をメモリに載せずに)1行ずつ読みながら、
// 「見出し語(表記または読み) -> 日本語の説明文」のMapを作る。
// 圧縮61MB・展開後400MB超だが、保持するのは選び出した説明文の文字列だけなので
// メモリ使用量は小さい。取得に失敗した場合は空のMapを返し、Wiktionaryによる
// 補完だけをスキップする(Wikidataベースの補完は従来通り動く)。
async function fetchWiktionaryDefinitions(){
  console.log('Wiktionary(日本語版)の辞書データをダウンロード中(圧縮61MB、展開しながら処理するため数分かかることがあります)…');
  const byWord = new Map();
  try{
    const res = await fetch(WIKTIONARY_URL);
    if(!res.ok) throw new Error(`Wiktionaryデータのダウンロードに失敗: ${res.status}`);
    const gunzip = zlib.createGunzip();
    Readable.fromWeb(res.body).pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
    let lines = 0, jaLines = 0;
    for await (const line of rl){
      lines++;
      if(!line) continue;
      let obj;
      try{ obj = JSON.parse(line); }catch(e){ continue; }
      if(obj.lang_code !== 'ja') continue;
      jaLines++;
      if(byWord.has(obj.word)) continue; // 同じ見出し語は先に見つかった語義を優先する
      const gloss = pickWiktionaryGloss(obj.senses);
      if(gloss) byWord.set(obj.word, gloss);
    }
    console.log(`  Wiktionary読み込み完了: 全${lines}行中、日本語エントリ${jaLines}件、説明文を抽出できた見出し語${byWord.size}件`);
  }catch(err){
    console.warn(`  Wiktionaryデータの取得に失敗しました(このカテゴリはスキップします): ${err.message}`);
  }
  return byWord;
}

// 一般語・和語動詞は表記(w)より先に読み(r)で引く: 上記の通り、和語動詞などは
// 読みの見出し語の方が内容の濃い語義を持っていることが多いため。
// 固有名詞(地名・人名など)は表記(w)のみで引き、読み(r)へのフォールバックは
// しない: 固有名詞の読みは短いひらがな列になりがちで、内容と無関係な
// 一般語・俗語の見出し語に誤って一致する事故が起きやすい(例: 地名種別の
// 「ウィル」が、読み「うぃる」経由でSNS用語「うぃる(will、SNS投稿の末尾に
// 付ける俗語)」の語義を拾ってしまい、地名なのに文法・俗語の説明が付く、
// という実例が確認された)。表記自体に載っていない語は、無理にrへ
// フォールバックせず「見つからない」扱いにする方が安全。
function lookupWiktionaryGloss(byWord, e, preferSurfaceForm = false){
  if(preferSurfaceForm) return byWord.get(e.w) || null;
  return byWord.get(e.r) || byWord.get(e.w) || null;
}

// dがまだ無いentriesに対して、Wiktionaryとの表記/読み一致で説明文を補う。
// ネットワーク通信を伴わない(byWordは事前に1回だけ取得済み)ため高速。
function enrichWithWiktionary(entries, byWord, label, preferSurfaceForm = false){
  let filled = 0;
  for(const e of entries){
    if(e.d) continue;
    const gloss = lookupWiktionaryGloss(byWord, e, preferSurfaceForm);
    if(gloss){ e.d = gloss; filled++; }
  }
  console.log(`  → ${label}: Wiktionaryから${filled}語に説明文を追加できました`);
}

// JMdict の partOfSpeech は "n" を含むだけの部分一致で判定すると
// interjection(int)や Noh(noh)、Nagano-ben(nab)まで誤って拾ってしまうため、
// 名詞系タグのみを厳密に列挙する。
const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pref', 'n-suf', 'n-pr']);

// 抽出する語数の上限。種別ごとに設けているのは、無名すぎる語(人名の末端など)で
// 辞書全体が埋まってゲームとして破綻するのを避けるため。値自体はここで調整できる。
const CAPS = {
  noun: 20000,
  place: 150000,
  person: 40000, // 著名人(伝記情報あり)のみ採用するため、上限自体は実質効かない想定
};
const CAP_DEFAULT = Infinity; // company / product / work / group / station など元々件数が少ないものは無制限

// JMdict の field タグ→日本語ラベル。専門用語として「よく使われる(common)」条件を
// 外して幅広い分野から抽出する(医学・化学だけでなく理数・人文・スポーツ・文化まで)。
// 値が無いタグ(field はあるが下記に列挙していないもの)は対象外になる。
const FIELD_LABELS = {
  // 医学・生物医学系
  med:'医学', chem:'化学', biochem:'生化学', pharm:'薬学', anat:'解剖学', physiol:'生理学',
  pathol:'病理学', genet:'遺伝学', dent:'歯学', surg:'外科', embryo:'発生学', vet:'獣医学',
  // 理数・工学系
  math:'数学', geom:'幾何学', stat:'統計学', logic:'論理学', physics:'物理学', astron:'天文学',
  geol:'地学', met:'気象学', min:'鉱物学', mining:'鉱業', cryst:'結晶学', paleo:'古生物学',
  engr:'工学', mech:'機械工学', electr:'電子工学', elec:'電気', telec:'電気通信', comp:'コンピュータ',
  internet:'インターネット', civeng:'土木工学', archit:'建築', motor:'自動車', rail:'鉄道', aviat:'航空',
  // 生物・自然
  biol:'生物学', zool:'動物学', bot:'植物学', ecol:'生態学', ornith:'鳥類学', fish:'魚類学',
  ent:'昆虫学', geogr:'地理学', agric:'農業', gardn:'園芸',
  // 人文・社会
  law:'法律', econ:'経済学', bus:'ビジネス', finc:'金融', stockm:'株式市場', politics:'政治学',
  phil:'哲学', psy:'心理学', psych:'心理学', psyanal:'精神分析学', ling:'言語学', gramm:'文法',
  archeol:'考古学', tradem:'商標', print:'印刷',
  // 宗教
  Buddh:'仏教', Christn:'キリスト教', Shinto:'神道',
  // 文化・芸術・娯楽
  art:'美術', music:'音楽', film:'映画', tv:'テレビ', manga:'漫画', vidg:'ゲーム', photo:'写真',
  audvid:'音響・映像', noh:'能', kabuki:'歌舞伎', cloth:'服飾', food:'料理',
  // スポーツ・遊戯
  sports:'スポーツ', baseb:'野球', sumo:'相撲', golf:'ゴルフ', boxing:'ボクシング', MA:'武道',
  ski:'スキー', horse:'競馬', prowres:'プロレス', figskt:'フィギュアスケート',
  mahj:'麻雀', go:'囲碁', shogi:'将棋', cards:'カードゲーム', hanaf:'花札',
  // その他
  mil:'軍事',
};

// ギリシャ/ローマ/中国/日本の神話に関する field タグ。ゼウス・ヘラクレス等の
// 神話上の人物・神・生物がここから採れる(JMnedictのmyth種別は件数が少ないため補完)。
const MYTHOLOGY_FIELDS = new Set(['grmyth', 'rommyth', 'chmyth', 'jpmyth']);

// JMnedictの種別のうち「個人の名前」を表すもの。この5種は生没年などの伝記情報が
// JMnedict上で確認できる語(=著名人と判定できる語)だけを採用する。
const PERSON_TYPES_REQUIRE_BIO = new Set(['person', 'surname', 'given', 'fem', 'masc', 'unclass']);

const NAME_TYPE_LABEL = {
  place: '地名', organization: '組織名', company: '企業名', product: '製品名',
  work: '作品名', station: '駅名', group: 'グループ名', person: '人名',
  surname: '姓', given: '名', fem: '女性の名', masc: '男性の名', unclass: '固有名詞',
  serv: '固有名詞', obj: '固有名詞', char: 'キャラクター', dei: '神話の神',
  fict: '架空の人物', creat: '架空の生物', myth: '神話', ship: '固有名詞',
  ev: '固有名詞', leg: '伝説上の人物', doc: '固有名詞',
};
// JMnedict の種別のうち、優先して採用する順序(重複読みは先勝ち)
const NAME_TYPE_PRIORITY = [
  'place', 'organization', 'company', 'product', 'work', 'station', 'group',
  'person', 'surname', 'given', 'fem', 'masc',
  'serv', 'obj', 'char', 'dei', 'fict', 'creat', 'myth', 'ship', 'ev', 'leg', 'doc',
  'unclass',
];

function toHiragana(str){
  return str.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function toKatakana(str){
  return str.replace(/[ぁ-ん]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

async function getAsset(nameTest){
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'shiritori-dojo-fetch-words' }
  });
  if(!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const asset = data.assets.find(a => nameTest.test(a.name));
  if(!asset) throw new Error(`対応するアセットが見つかりませんでした(パターン: ${nameTest})`);
  return asset;
}

async function downloadJson(asset){
  console.log(`ダウンロード: ${asset.name} (${(asset.size/1024/1024).toFixed(1)} MB)`);
  const res = await fetch(asset.browser_download_url);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
  if(!entry) throw new Error(`${asset.name} 内にjsonファイルが見つかりませんでした`);
  return JSON.parse(zip.readAsText(entry));
}

// t(tier)は「有名度」の目印。1=著名(都道府県・主要都市・広く知られた人物など)を付けておくと、
// script.js側のAI選手選びで優先的に手として選ばれるようになる(kana.js側の判定には無関係)。
// 通常語は t を省略してよい(その場合ファイル上は無印=tier0として扱われる)。
// d(簡単な日本語の解説。例: りんご→「バラ科の樹木、およびその食用となる果実のこと」)は
// mとは別枠の項目。script.js側はd があればdを、無ければ従来通りmを表示に使う。
function addEntry(out, seenReadings, cap, { w, r, m, t, d }){
  if(!KANA_ONLY.test(r)) return false;
  if(r.length < 2) return false;
  if(seenReadings.has(r)) return false;
  if(out.length >= cap) return false;
  seenReadings.add(r);
  const entry = { w, r, m };
  if(t) entry.t = t;
  if(d) entry.d = d;
  out.push(entry);
  return true;
}

function extractNouns(data, seenReadings){
  const out = [];
  for(const word of data.words){
    if(out.length >= CAPS.noun) break;
    const kanjiCommon = (word.kanji || []).find(k => k.common);
    const kanaCommon = (word.kana || []).find(k => k.common);
    if(!kanaCommon) continue; // 「よく使われる」語だけを対象にする

    const reading = toHiragana(kanaCommon.text);
    const isNoun = word.sense.some(s => (s.partOfSpeech || []).some(p => NOUN_POS.has(p)));
    if(!isNoun) continue;

    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;

    // JMdictの「よく使われる(common)」フラグが付いた語は、りんご・机のような
    // 誰でも知っている一般語である。数万〜数十万語の専門用語・固有名詞に埋もれて
    // 出にくくならないよう、この一般名詞は丸ごと tier1(著名優先)にしている。
    addEntry(out, seenReadings, CAPS.noun, {
      w: (kanjiCommon && kanjiCommon.text) || kanaCommon.text,
      r: reading,
      m: '普通名詞',
      t: 1,
    });
  }
  console.log(`一般名詞: ${out.length}語`);
  return out;
}

function extractProverbsAndYoji(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const isTarget = word.sense.some(s => (s.misc || []).includes('proverb') || (s.misc || []).includes('yoji'));
    if(!isTarget) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: 'ことわざ・故事成語',
    });
  }
  console.log(`ことわざ・故事成語: ${out.length}語`);
  return out;
}

// FIELD_LABELS に列挙した分野の専門用語をまとめて抽出する。「よく使われる(common)」
// 条件は外している(専門用語はそもそも一般的な語ではないため)。複数分野にまたがる語は
// 最初に見つかった分野のラベルを使う。意味欄は "[分野] (en) 英語のgloss" の形式。
function extractFieldTerms(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    let label = null;
    for(const s of word.sense){
      for(const f of (s.field || [])){
        if(FIELD_LABELS[f]){ label = FIELD_LABELS[f]; break; }
      }
      if(label) break;
    }
    if(!label) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: label,
    });
  }
  console.log(`専門用語(分野横断): ${out.length}語`);
  return out;
}

function extractMythology(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const isTarget = word.sense.some(s => (s.field || []).some(f => MYTHOLOGY_FIELDS.has(f)));
    if(!isTarget) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: '神話',
    });
  }
  console.log(`神話: ${out.length}語`);
  return out;
}

// 生没年などの伝記情報(例: "(1879-1955; ...)")を含む翻訳文を返す。
// 見つからなければ null(=著名人と判定できない)。JMnedictにはそれ以外の
// 著名度指標が無いため、この伝記情報の有無を「著名人らしさ」の判定に使う。
function getBioText(translations){
  for(const t of translations){
    for(const g of t.translation){
      if(/\(\d{3,4}/.test(g.text)) return g.text;
    }
  }
  return null;
}

// 固有名詞の並び優先度(place の上限に収める際、海外由来と推定できる語を優先する)。
function rankTier(cand){
  if(cand.type === 'place' && cand.t === 1) return 0; // 著名な都道府県・主要都市
  if(cand.type === 'place' && !cand.hasKanji) return 1; // 海外由来と推定できる地名
  return 2;
}

function primaryNameType(word){
  const types = new Set();
  for(const t of word.translation) for(const ty of (t.type || [])) types.add(ty);
  for(const t of NAME_TYPE_PRIORITY) if(types.has(t)) return t;
  return null;
}

function extractProperNouns(data, seenReadings, famousPlaceNames){
  const buckets = new Map(); // type -> array of {w,r,hasKanji,type,m,t}
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const type = primaryNameType(word);
    if(!type) continue;

    // person/surname/given/fem/masc/unclass はJMnedict上ただの名前読み辞書であり、
    // 無名な人物も大量に含まれる。生没年などの伝記情報が確認できる語(=著名人と
    // 判定できる語)だけを採用する。それ以外の種別(地名・組織名・神話上の人物など、
    // 個人の実名ではないもの)はこの条件を課さない。
    // 意味欄(m)は種別ラベルのみ(例:「人名」)にする。JMnedictの伝記情報は英語しか
    // 無いため、後段の enrichPersonDescriptions() でWikidataから日本語の説明文(d)を
    // 探す。見つからなければ「誰なのか」は表示されない(=種別ラベルのみになる)。
    const m = NAME_TYPE_LABEL[type];
    if(PERSON_TYPES_REQUIRE_BIO.has(type)){
      const bio = getBioText(word.translation);
      if(!bio) continue;
    }

    const reading = toHiragana(kana.text);
    if(!KANA_ONLY.test(reading) || reading.length < 2) continue;
    const kanji = word.kanji && word.kanji[0];
    const w = (kanji && kanji.text) || kana.text;
    // 都道府県・主要都市の表記(Wikidataから取得済み)と一致する地名はtier1にし、
    // Wikidataの日本語説明文があればdとして使う。読みはJMnedict側のものをそのまま
    // 使う(Wikidataの地名ラベルは漢字表記のみで読みが分からないため)。
    const isFamousPlace = type === 'place' && famousPlaceNames.has(w);
    const cand = {
      w,
      r: reading,
      hasKanji: !!kanji,
      type,
      m,
      t: isFamousPlace ? 1 : undefined,
      d: isFamousPlace ? famousPlaceNames.get(w) : undefined,
    };
    if(!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push(cand);
  }

  const out = [];
  const personEntries = []; // Wikidataからの説明文補完(enrichPersonDescriptions)の対象
  for(const type of NAME_TYPE_PRIORITY){
    const bucket = buckets.get(type);
    if(!bucket) continue;
    // rankTier: 著名な地名、および(placeについて)海外由来(漢字表記なし)を優先して
    // 上限内に収める。Array#sort は安定ソートなので、同ティア内は元の並び順を保つ。
    bucket.sort((a, b) => rankTier(a) - rankTier(b));
    const cap = CAPS[type] ?? CAP_DEFAULT;
    let added = 0, famousAdded = 0;
    for(const cand of bucket){
      if(added >= cap) break;
      if(addEntry(out, seenReadings, Infinity, { w: cand.w, r: cand.r, m: cand.m, t: cand.t, d: cand.d })){
        added++;
        if(cand.t) famousAdded++;
        if(PERSON_TYPES_REQUIRE_BIO.has(type)) personEntries.push(out[out.length - 1]);
      }
    }
    if(type === 'place') console.log(`  地名のうちtier1(著名な都道府県・主要都市): ${famousAdded}件`);
  }
  console.log(`固有名詞: ${out.length}語`);
  return { out, personEntries };
}

// Wikidata由来のカテゴリ。directOnly=true は P31 の直接インスタンスのみを対象にする
// (Q95074「架空のキャラクター」は下位クラスが非常に多く、P279*での再帰検索は
//  クエリがタイムアウトしやすいため直接インスタンスのみに絞っている)。
// ビデオゲーム/音楽グループは P31 直接インスタンスだけでも1万〜2万件と非常に多く、
// そのまま1クエリで取得しようとすると応答が巨大になりすぎて途中で壊れた(切れた)
// JSONが返ってくることがあった。minSitelinks(掲載されている言語版ウィキペディアの数)で
// 足切りし、「ある程度知られている」ものに絞ることで応答サイズを抑えている。
const WIKIDATA_CATEGORIES = [
  { qid: 'Q22989102', label: '神話の神', directOnly: false },
  { qid: 'Q24334685', label: '神話・伝説の生物', directOnly: false },
  { qid: 'Q95074', label: '架空のキャラクター', directOnly: true },
  { qid: 'Q7889', label: 'ビデオゲーム', directOnly: true, minSitelinks: 5 },
  { qid: 'Q215380', label: '音楽グループ', directOnly: true, minSitelinks: 5 },
];
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_USER_AGENT = 'shiritori-dojo-fetch-words/1.0 (https://github.com/; educational hobby project)';

// query.wikidata.org は共有の公開エンドポイントで、負荷状況により 502 等の
// HTTPエラーだけでなく、応答が大きすぎて壊れた(途中で切れた)JSONが返って
// くることもあるため、JSON解析の失敗も含めてリトライする。
// GET(URLクエリパラメータ)だと、VALUES句に語をたくさん詰めた大きなクエリで
// エンコード後のURLが1万文字を超えることがあり、Wikidata側のエッジ/CDN層で
// 592msほどの短時間で503(Wikimedia Error)が即座に返ってくる現象を確認した
// (SPARQLエンジン側のタイムアウトではなく、リクエストライン長の制限と見られる)。
// POST(クエリをリクエストボディに入れる)にすることでURL長の制限を回避できる。
async function sparql(query, retries = 4){
  for(let attempt = 0; ; attempt++){
    let rateLimited = false;
    try{
      const res = await fetch(WIKIDATA_ENDPOINT, {
        method: 'POST',
        headers: {
          'Accept': 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': WIKIDATA_USER_AGENT,
        },
        body: `query=${encodeURIComponent(query)}`,
      });
      if(!res.ok){
        rateLimited = res.status === 429;
        throw new Error(`Wikidata SPARQL error: ${res.status}`);
      }
      const data = await res.json();
      return data.results.bindings;
    }catch(err){
      if(attempt >= retries) throw err;
      // 429(レート制限)は通常のエラーより長めに待たないと、以降のリクエストも
      // 連鎖的に失敗し続ける(実際に一度発生すると後続チャンクが軒並み失敗する
      // 現象を確認した)ため、それ以外のエラーより待ち時間を長く取る。
      const base = rateLimited ? 15000 : 3000;
      await new Promise(r => setTimeout(r, base * (attempt + 1)));
    }
  }
}

// 結果件数が数千件を超えるクエリは、1回のレスポンスが巨大になりすぎて途中で
// 切れた(壊れた)JSONが返ってくることがある(sparql()のリトライだけでは直らない、
// 毎回同じ理由で壊れるため)。LIMIT/OFFSET でページ単位に分けて取得することで
// 1回あたりの応答サイズを抑える。ORDER BY を付けると(特にP279*のような再帰パスや
// 大きな結果集合で)ページごとに結果全体をソートし直す必要が生じてクエリ自体が
// タイムアウトしやすくなったため、あえて付けていない。順序が安定しない分、
// ページ境界で稀に重複/欠落が起こり得るが、重複はaddEntryの読み重複チェックで
// 吸収され、欠落も少数語を取りこぼす程度で致命的ではないため許容している。
// 1ページの取得が(sparql()内のリトライを尽くしても)失敗した場合は、そこまでに
// 取得できた分だけを返して打ち切る(1ページの不調でカテゴリ全体を諦めないため)。
async function sparqlPaginated(buildQuery, pageSize = 800){
  const out = [];
  for(let offset = 0; ; offset += pageSize){
    let rows;
    try{
      rows = await sparql(buildQuery(pageSize, offset));
    }catch(err){
      console.warn(`  ページ取得(offset=${offset})が失敗したため、ここまでの${out.length}件で打ち切ります: ${err.message}`);
      break;
    }
    out.push(...rows);
    if(rows.length < pageSize) break;
    await new Promise(r => setTimeout(r, 1500)); // Wikidataへの負荷を抑えるための小休止
  }
  return out;
}

async function fetchWikidataLabels(qid, directOnly, minSitelinks){
  const path = directOnly ? 'wdt:P31' : 'wdt:P31/wdt:P279*';
  const sitelinksClause = minSitelinks
    ? `?item wikibase:sitelinks ?sitelinks . FILTER(?sitelinks >= ${minSitelinks})`
    : '';
  return sparqlPaginated((limit, offset) =>
    `SELECT ?item ?itemLabel WHERE { ?item ${path} wd:${qid} . ${sitelinksClause} ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja') } LIMIT ${limit} OFFSET ${offset}`
  );
}

// Wikidataの「人間(Q5)」は全体で数百万件あり、素朴な P31 検索は必ずタイムアウトする。
// 日本語版ウィキペディアに記事がある(=schema:isPartOf jawiki)ことで対象を絞り込み、
// さらに sitelinks(記事が存在する言語版ウィキペディアの数)で足切りすることで、
// 「広く知られている人物」だけをクエリ側で選別する。MIN_SITELINKS を上げるほど
// 世界的に有名な人物に絞られ、クエリも軽くなる(下げすぎるとタイムアウトしやすい)。
const WIKIDATA_HUMAN_MIN_SITELINKS = 12;
// この件数以上の言語版ウィキペディアに記事がある人物は「世界的に広く知られた偉人」と
// みなし、tier1(著名優先)を付ける。sitelinksをSELECTしておくことで、後段で
// クエリを打ち直さずにそのまま判定に使える。
const WIKIDATA_HUMAN_FAMOUS_SITELINKS = 40;
async function fetchWikidataNotableHumans(){
  return sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel ?sitelinks WHERE {
    ?article schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> .
    ?item wdt:P31 wd:Q5 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_HUMAN_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
}

// 都道府県・日本国内の主要都市(sitelinksで足切り)をWikidataから抽出する。
// JMnedictのplace種別(上限150,000件)は無名な地名も大量に含み、AIの手の中で
// 有名な地名が埋もれてしまうため、確実に著名だと分かる地名を tier1 として
// 別枠で確保しておく。
const WIKIDATA_JAPAN_PLACE_MIN_SITELINKS = 15;
// 都道府県・日本国内の主要都市の「表記(漢字)」だけをWikidataから取得する。
// 日本の地名のWikidata日本語ラベルはほぼ全て漢字表記(例: 東京都、大阪市)であり、
// かな表記が無い(=読みがWikidata側から分からない)ため、ここでは読みの情報源としては
// 使わず、JMnedict側で既に読み付きで抽出済みの地名エントリのうち「この漢字表記に
// 一致するもの」を tier1(著名優先)としてマークするための照合キー集合として使う。
// 戻り値は「表記(漢字) -> Wikidataの日本語説明文(無ければundefined)」のMap。
// 都道府県・主要都市に加え、山・川・湖・島も同じ「表記の照合キー」方式で対象にする。
// これらは市区町村ほどsitelinksが多くない(=広く知られていても言語版の少ない
// ローカルな地形として登録されがち)ため、足切りをやや緩めている。
const WIKIDATA_JAPAN_GEO_MIN_SITELINKS = 8;
const WIKIDATA_JAPAN_GEO_CLASSES = [
  { qid: 'Q8502', label: '山' },
  { qid: 'Q4022', label: '川' },
  { qid: 'Q23397', label: '湖' },
  { qid: 'Q23442', label: '島' },
  { qid: 'Q845945', label: '神社' },
  { qid: 'Q5393308', label: '寺' },
  { qid: 'Q92026', label: '城' },
  { qid: 'Q655311', label: '温泉' },
  { qid: 'Q22698', label: '公園' },
  { qid: 'Q12280', label: '橋' },
  { qid: 'Q34763', label: '半島' },
  { qid: 'Q185113', label: '岬' },
  { qid: 'Q133056', label: '峠' },
];
async function fetchFamousJapanPlaceNames(){
  const prefectures = await sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel WHERE {
    ?item wdt:P31 wd:Q50337 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_JAPAN_PLACE_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
  const cities = await sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel WHERE {
    ?item wdt:P17 wd:Q17 ; wdt:P31/wdt:P279* wd:Q515 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_JAPAN_PLACE_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
  let rows = [...prefectures, ...cities];
  for(const geo of WIKIDATA_JAPAN_GEO_CLASSES){
    try{
      const geoRows = await sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel WHERE {
        ?item wdt:P17 wd:Q17 ; wdt:P31/wdt:P279* wd:${geo.qid} ; wikibase:sitelinks ?sitelinks .
        FILTER(?sitelinks >= ${WIKIDATA_JAPAN_GEO_MIN_SITELINKS})
        ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
      } LIMIT ${limit} OFFSET ${offset}`);
      console.log(`  ${geo.label}: ${geoRows.length}件`);
      rows.push(...geoRows);
    }catch(err){
      console.warn(`  ${geo.label}の取得に失敗しました: ${err.message} — スキップします`);
    }
  }
  const qids = rows.map(row => row.item.value.split('/').pop());
  const descMap = await fetchWikidataDescriptions(qids);
  const names = new Map();
  for(const row of rows){
    const qid = row.item.value.split('/').pop();
    names.set(row.itemLabel.value, descMap.get(qid));
  }
  console.log(`Wikidata(日本の著名な地名の表記): 都道府県${prefectures.length}件 + 都市${cities.length}件 + 山川湖島 = ${names.size}件(重複除去後、説明文あり${descMap.size}件)`);
  return names;
}

// 説明文はラベル取得とは別クエリでバッチ取得する(1クエリにまとめるとタイムアウトしやすいため)。
async function fetchWikidataDescriptions(qids){
  const out = new Map();
  const CHUNK = 250;
  for(let i = 0; i < qids.length; i += CHUNK){
    const chunk = qids.slice(i, i + CHUNK);
    const values = chunk.map(q => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?desc WHERE { VALUES ?item { ${values} } ?item schema:description ?desc . FILTER(LANG(?desc)='ja') }`;
    try{
      const rows = await sparql(query);
      for(const row of rows) out.set(row.item.value.split('/').pop(), row.desc.value);
    }catch(err){
      // このチャンクだけ諦める(該当語は種別ラベルにフォールバックするので致命的ではない)。
      console.warn(`  説明文取得チャンク(${i}-${i+chunk.length})が失敗したためスキップします: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // Wikidataへの負荷を抑えるための小休止
  }
  return out;
}

// Wikidata(CC0)から、神・神話上の生物・架空のキャラクターを補完的に抽出する。
// 日本語ラベルが純粋なかな(カタカナ/ひらがな)であるものだけを対象にする
// (漢字表記のみのラベルは読みが分からず、しりとりの手として使えないため)。
// 出典として Wikidata の QID を意味欄の末尾に付記する(README にライセンス表記あり)。
async function extractWikidataBeings(seenReadings){
  const out = [];
  for(const cat of WIKIDATA_CATEGORIES){
    try{
      const rows = await fetchWikidataLabels(cat.qid, cat.directOnly, cat.minSitelinks);
      const seenLocal = new Set();
      const candidates = [];
      for(const row of rows){
        const hira = toHiragana(row.itemLabel.value);
        if(!KANA_ONLY.test(hira) || hira.length < 2) continue;
        if(seenLocal.has(hira)) continue;
        seenLocal.add(hira);
        candidates.push({ w: row.itemLabel.value, r: hira, qid: row.item.value.split('/').pop() });
      }
      const descMap = await fetchWikidataDescriptions(candidates.map(c => c.qid));
      let added = 0;
      for(const c of candidates){
        const m = `${cat.label} [Wikidata:${c.qid}]`;
        if(addEntry(out, seenReadings, Infinity, { w: c.w, r: c.r, m, d: descMap.get(c.qid) })) added++;
      }
      console.log(`Wikidata(${cat.label}): ${added}語(説明文あり ${descMap.size}件)`);
    }catch(err){
      console.warn(`Wikidata取得に失敗しました(${cat.label}): ${err.message} — このカテゴリはスキップします`);
    }
  }
  return out;
}

// 日本語版ウィキペディアに記事を持ち、かつ一定数以上の言語版ウィキペディアでも
// 取り上げられている(=広く知られている)人物をWikidataから抽出する。
// JMnedictのperson/surname等(生没年の記載有無で判定)より遥かに件数・情報量が多い。
// 日本語ラベルが漢字表記のみの人物(日本の歴史上の人物など)は読みが分からず対象外になる
// (README参照)。意味欄にはWikidataの日本語説明文をそのまま使う。
async function extractWikidataHumans(seenReadings){
  try{
    const rows = await fetchWikidataNotableHumans();
    const seenLocal = new Set();
    const candidates = [];
    for(const row of rows){
      const hira = toHiragana(row.itemLabel.value);
      if(!KANA_ONLY.test(hira) || hira.length < 2) continue;
      if(seenLocal.has(hira)) continue;
      seenLocal.add(hira);
      const sitelinks = Number(row.sitelinks.value);
      candidates.push({ w: row.itemLabel.value, r: hira, qid: row.item.value.split('/').pop(), famous: sitelinks >= WIKIDATA_HUMAN_FAMOUS_SITELINKS });
    }
    const descMap = await fetchWikidataDescriptions(candidates.map(c => c.qid));
    const out = [];
    let added = 0, famousAdded = 0;
    for(const c of candidates){
      const m = `著名人 [Wikidata:${c.qid}]`;
      if(addEntry(out, seenReadings, Infinity, { w: c.w, r: c.r, m, d: descMap.get(c.qid), t: c.famous ? 1 : undefined })){
        added++;
        if(c.famous) famousAdded++;
      }
    }
    console.log(`Wikidata(著名人): ${added}語(説明文あり ${descMap.size}件、うちtier1(${WIKIDATA_HUMAN_FAMOUS_SITELINKS}言語版以上) ${famousAdded}件)`);
    return out;
  }catch(err){
    console.warn(`Wikidata(著名人)の取得に失敗しました: ${err.message} — このカテゴリはスキップします`);
    return [];
  }
}

// 都道府県・日本国内の主要都市を tier1(著名優先)として抽出する。
async function fetchFamousJapanPlaceNamesSafe(){
  try{
    return await fetchFamousJapanPlaceNames();
  }catch(err){
    console.warn(`Wikidata(日本の著名な地名の表記)の取得に失敗しました: ${err.message} — 地名のtier1付与はスキップします`);
    return new Map();
  }
}

// JMdict由来のカテゴリ(一般名詞・ことわざ/故事成語・専門用語)には日本語の説明文が無い
// (英語glossの m しか無い)ため、Wikidataで「日本語ラベルが表記(entry.w)と完全一致する
// 項目」を探し、見つかった日本語説明文を d として追加する。
//
// 表記が同じでも別の意味の項目(同名の作品・キャラクター・軍艦・雑誌など)に
// ヒットすることがある。あからさまに無関係と分かるもの(人物/作品/軍艦などの型、
// および説明文が『』年号やによる等の「作品らしいパターン」を含むもの)は
// ENTITY_TYPE_BLOCKLIST / NOISE_DESC_PATTERNS で除外するが、除外しきれず複数候補が
// 残った場合は先頭の1件を採用する(=読みの上での同音異義語として扱う。
// どちらの語義であっても実在する言葉であることに変わりはないため)。
const ENTITY_TYPE_BLOCKLIST = [
  'Q5', 'Q11424', 'Q482994', 'Q134556', 'Q7366', 'Q215380', 'Q7889',
  'Q101352', 'Q202444', 'Q4167410', 'Q486972', 'Q515',
  'Q3863', 'Q5398426', 'Q484170', 'Q4830453', 'Q783794',
];
const NOISE_DESC_EXACT = new Set(['漢字', 'ひらがな', 'カタカナ']);
// 読み(r)のカタカナ変換も候補に加えたことで、表記一致だけの場合より偶然の同名衝突
// (小惑星・競走馬・企業・TVシリーズ・ポケモンの技名など、普通名詞とは無関係な
// 固有名詞的カテゴリ)がヒットしやすくなった。「林檎→メキシコのTVシリーズ」のような
// 実例が確認できたため、そうしたカテゴリの説明文パターンも除外に加えている。
const NOISE_DESC_PATTERNS = [
  /『.*』/, /「.*」/, /\d{4}年/, /による/, /作曲/, /作詞/,
  /の登場人物/, /に登場/, /クルアーン/, /曲$/, /小説/, /映画/, /漫画/, /ドラマ/,
  /アルバム/, /シングル/, /楽曲/, /戯曲/, /彫刻/, /絵画/, /艦$/, /駆逐艦/, /軍艦/,
  /の姓/, /の名/, /人名/, /町丁/, /大字/, /地名/, /字$/, /曖昧さ回避/,
  /雑誌/, /タロット/, /ムック/, /散文詩/, /の演目/,
  /小惑星/, /クレーター/, /テレビシリーズ/, /TVシリーズ/, /コミューン/, /コムーネ/,
  /のエピソード$/, /のわざ$/, /の特性$/, /カード$/, /品種/, /競走馬/,
  /ウィキメディア/, /紋章/, /お笑い/, /企業/, /会社/, /の話$/,
];
function isUsableWikidataDesc(desc){
  if(NOISE_DESC_EXACT.has(desc)) return false;
  return !NOISE_DESC_PATTERNS.some(re => re.test(desc));
}

async function enrichWithWikidataDescriptions(entries, label){
  const targets = entries.filter(e => !e.d);
  if(targets.length === 0) return;
  console.log(`Wikidataとの表記一致で説明文を補完中(${label}): 対象${targets.length}語(数分かかることがあります)`);
  const CHUNK = 200;
  const badTypeValues = ENTITY_TYPE_BLOCKLIST.map(q => `wd:${q}`).join(' ');
  let filled = 0;
  for(let i = 0; i < targets.length; i += CHUNK){
    const chunk = targets.slice(i, i + CHUNK);
    // 検索候補ラベル: 表記(w)に加え、読み(r)をカタカナに変換したものも試す。
    // 例:「林檎」はJMdict上の表記(漢字)だが、Wikidataでは果物の項目が
    // カタカナの「リンゴ」というラベルで登録されていることが多く、
    // 表記だけの一致では拾えない語をここで拾えるようにする。
    const labelSet = new Set();
    for(const e of chunk){
      labelSet.add(e.w);
      labelSet.add(toKatakana(e.r));
    }
    const values = [...labelSet].map(l => `"${l.replace(/"/g, '\\"')}"@ja`).join(' ');
    const query = `SELECT ?label ?desc WHERE {
      VALUES ?label { ${values} }
      ?item rdfs:label ?label .
      ?item schema:description ?desc . FILTER(LANG(?desc)='ja')
      FILTER NOT EXISTS { ?item wdt:P31 ?badType . VALUES ?badType { ${badTypeValues} } }
    }`;
    try{
      const rows = await sparql(query);
      const descByLabel = new Map();
      for(const row of rows){
        const l = row.label.value, d = row.desc.value;
        if(!isUsableWikidataDesc(d)) continue;
        if(!descByLabel.has(l)) descByLabel.set(l, d); // 除外しきれず複数残った場合は先頭の1件
      }
      for(const e of chunk){
        const d = descByLabel.get(e.w) || descByLabel.get(toKatakana(e.r));
        if(d){ e.d = d; filled++; }
      }
    }catch(err){
      console.warn(`  チャンク(${i}-${i + chunk.length})が失敗したためスキップ: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`  → ${label}: ${filled}語に説明文を追加できました`);
}

// JMnedictの著名人(person/surname/given/fem/masc/unclass、生没年などの伝記情報で
// 判定済み)には英語の伝記文しか無いため、Wikidataで「日本語ラベルが表記(entry.w)と
// 完全一致し、かつ人間(P31=Q5)である項目」を探し、日本語の説明文をdとして補う。
// enrichWithWikidataDescriptions と違いブロックリストではなく人間限定のホワイト
// リストで絞るため、同名の作品・地名等に誤ってヒットすることはほぼ無い。
// 見つからなかった語は、説明文なし(m=種別ラベルのみ)のまま残る。
async function enrichPersonDescriptions(entries){
  const targets = entries.filter(e => !e.d);
  if(targets.length === 0) return;
  console.log(`Wikidataとの表記一致で人物の説明文を補完中: 対象${targets.length}語(数分かかることがあります)`);
  const CHUNK = 200;
  let filled = 0;
  for(let i = 0; i < targets.length; i += CHUNK){
    const chunk = targets.slice(i, i + CHUNK);
    const values = chunk.map(e => `"${e.w.replace(/"/g, '\\"')}"@ja`).join(' ');
    const query = `SELECT ?label ?desc WHERE {
      VALUES ?label { ${values} }
      ?item rdfs:label ?label .
      ?item wdt:P31 wd:Q5 .
      ?item schema:description ?desc . FILTER(LANG(?desc)='ja')
    }`;
    try{
      const rows = await sparql(query);
      const descByLabel = new Map();
      for(const row of rows){
        const l = row.label.value, d = row.desc.value;
        if(!isUsableWikidataDesc(d)) continue;
        if(!descByLabel.has(l)) descByLabel.set(l, d);
      }
      for(const e of chunk){
        const d = descByLabel.get(e.w);
        if(d){ e.d = d; filled++; }
      }
    }catch(err){
      console.warn(`  チャンク(${i}-${i + chunk.length})が失敗したためスキップ: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`  → 人物: ${filled}語に説明文を追加できました`);
}

// JMnedictの駅名/組織名/企業名/作品名/製品名は種別ラベルのみで説明文(d)が無いため、
// Wikidataで「日本語ラベルが表記(entry.w)と完全一致し、かつ指定クラスのインスタンス
// である項目」を探して日本語の説明文を補う。enrichPersonDescriptionsと同様、種別が
// 分かっているのでクラスのホワイトリストで絞り込め、同名の無関係な項目に誤って
// ヒットすることはほぼ無い。
// direct=false(既定)はP31/P279*で指定QIDのいずれかに到達するかを見る(祖先クラスが
// 具体的で件数も少ない駅・組織・企業向け)。direct=trueはP31が指定QIDのいずれかに
// 直接一致するかだけを見る(「作品」「製品」のような抽象度の高いクラスはP279*の
// 再帰探索がWikidata側で重く、504タイムアウトを頻発させることを確認したため、
// 代わりに具体的な下位クラスをQIDで直接列挙する)。
async function enrichByWikidataClass(entries, classQids, label, direct = false, chunkSize = 200){
  const targets = entries.filter(e => !e.d);
  if(targets.length === 0) return;
  console.log(`Wikidataとの表記一致で${label}の説明文を補完中: 対象${targets.length}語(数分かかることがあります)`);
  const CHUNK = chunkSize;
  const classValues = classQids.map(q => `wd:${q}`).join(' ');
  const classPath = direct ? 'wdt:P31' : 'wdt:P31/wdt:P279*';
  let filled = 0;
  for(let i = 0; i < targets.length; i += CHUNK){
    const chunk = targets.slice(i, i + CHUNK);
    const values = chunk.map(e => `"${e.w.replace(/"/g, '\\"')}"@ja`).join(' ');
    const query = `SELECT ?label ?desc WHERE {
      VALUES ?label { ${values} }
      ?item rdfs:label ?label .
      ?item ${classPath} ?class . VALUES ?class { ${classValues} }
      ?item schema:description ?desc . FILTER(LANG(?desc)='ja')
    }`;
    try{
      const rows = await sparql(query);
      const descByLabel = new Map();
      for(const row of rows){
        const l = row.label.value, d = row.desc.value;
        if(!isUsableWikidataDesc(d)) continue;
        if(!descByLabel.has(l)) descByLabel.set(l, d);
      }
      for(const e of chunk){
        const d = descByLabel.get(e.w);
        if(d){ e.d = d; filled++; }
      }
    }catch(err){
      console.warn(`  チャンク(${i}-${i + chunk.length})が失敗したためスキップ: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`  → ${label}: ${filled}語に説明文を追加できました`);
}

async function main(){
  console.log('最新リリース情報を取得中…');
  const [commonAsset, fullAsset, neAsset] = await Promise.all([
    getAsset(/^jmdict-eng-common-.*\.json\.zip$/),
    getAsset(/^jmdict-eng-\d.*\.json\.zip$/),
    getAsset(/^jmnedict-all-.*\.json\.zip$/),
  ]);

  const [commonData, fullData, neData, wiktionary] = await Promise.all([
    downloadJson(commonAsset),
    downloadJson(fullAsset),
    downloadJson(neAsset),
    fetchWiktionaryDefinitions(),
  ]);

  // Wikidataは神話・架空の存在/著名人について日本語の説明文を持つことが多く、
  // JMdict/JMnedictの単純な種別ラベルより情報量が多いため、読みが重複した場合は
  // Wikidata側を優先する(=先に登録する)順序にしている。
  const seenReadings = new Set();
  const nouns = extractNouns(commonData, seenReadings);
  const proverbs = extractProverbsAndYoji(fullData, seenReadings);
  const fieldTerms = extractFieldTerms(fullData, seenReadings);

  // まずWiktionary(ネットワーク通信を伴わない、事前取得済みのMap参照のみ)で
  // 日本語の説明文を補い、それでも埋まらなかった分だけWikidataとの表記一致で補完する。
  // ことわざ・和語動詞・基本語彙はWiktionaryの方が的確な語義を持つことが多い。
  enrichWithWiktionary(nouns, wiktionary, '一般名詞');
  enrichWithWiktionary(proverbs, wiktionary, 'ことわざ・故事成語');
  enrichWithWiktionary(fieldTerms, wiktionary, '専門用語');

  // JMdict由来で英語glossしか無い一般名詞・ことわざ/専門用語に、Wikidataとの表記一致で
  // 日本語の簡単な説明文(d)を補完する(例: りんご→「セイヨウリンゴの果実」)。
  // 件数が多いため時間がかかる。
  await enrichWithWikidataDescriptions(nouns, '一般名詞');
  await enrichWithWikidataDescriptions(proverbs, 'ことわざ・故事成語');
  await enrichWithWikidataDescriptions(fieldTerms, '専門用語');

  const properNouns = extractProperNouns(neData, seenReadings, await fetchFamousJapanPlaceNamesSafe());
  // 固有名詞にもWiktionaryを先に試す(著名な地名・人名・作品名等は掲載されていることがある)。
  enrichWithWiktionary(properNouns.out, wiktionary, '固有名詞', true);
  // JMnedict由来の著名人は英語の伝記文しか無いため、Wikidataとの表記一致(かつ人間限定)で
  // 日本語の説明文(d)を補う。見つかった分だけ「誰なのか」が表示されるようになる。
  await enrichPersonDescriptions(properNouns.personEntries);
  // 駅名・組織名・企業名・作品名・製品名は種別ラベルのみで説明文が無いため、
  // Wikidataとの表記一致(かつ各カテゴリのクラス限定)で日本語の説明文を補う。
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '駅名'), ['Q55488'], '駅名');
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '組織名'), ['Q43229'], '組織名');
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '企業名'), ['Q4830453', 'Q783794'], '企業名');
  // 「作品」「製品」はWikidata上ほぼ全ての物事を包含する抽象クラスで、P279*による
  // 祖先探索がタイムアウトしやすいため、直接インスタンスとして使われることの多い
  // 具体的な下位クラスを列挙し、P31の直接一致だけで判定する(direct=true)。
  const WORK_TYPE_QIDS = [
    'Q11424', 'Q5398426', 'Q7889', 'Q482994', 'Q134556', 'Q7366',
    'Q571', 'Q8261', 'Q1004', 'Q853520', 'Q49084', 'Q220577',
    'Q25379', 'Q1344', 'Q2743', 'Q41298', 'Q11032', 'Q3305213',
    'Q860861', 'Q131436', 'Q1150772', 'Q1555508', 'Q149537',
  ];
  const PRODUCT_TYPE_QIDS = ['Q2424752', 'Q1183543', 'Q39546', 'Q28877', 'Q11019'];
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '作品名'), WORK_TYPE_QIDS, '作品名', true);
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '製品名'), PRODUCT_TYPE_QIDS, '製品名', true);

  // 地名(150,000語)は、fetchFamousJapanPlaceNamesによる「著名な地名」照合だけでは
  // ごく一部(数千件)しかdが埋まらない。都道府県・市区町村より下位の、JMnedictの
  // 地名エントリの大半を占める町丁目・大字・字レベルの行政区画にもWikidata上の
  // クラスが存在する(ōaza/koaza/aza/chōme等)ため、著名度(tier1)とは切り離して、
  // 直接インスタンスとして該当するものにはdだけを補う(t=1にはしない)。
  // 「地名」の抽象的な祖先クラス(Q56061 行政区画等)でのP279*探索は、他の
  // 抽象クラス同様にWikidata側でタイムアウトすることを確認済みのため、
  // 具体的な下位クラスをQIDで直接列挙し、P31の直接一致だけで判定する。
  const JAPAN_PLACE_TYPE_QIDS = [
    'Q515', 'Q1059478', 'Q4174776', 'Q137773',
    'Q424857', 'Q5327509', 'Q66752884', 'Q28754498',
    'Q5327369', 'Q65948724',
  ];
  // 対象語数が非常に多い(15万語規模)ため、direct(P31直接一致、軽いクエリ)であることを
  // 活かしてチャンクサイズを大きくし、往復回数を減らす。
  await enrichByWikidataClass(properNouns.out.filter(e => e.m === '地名'), JAPAN_PLACE_TYPE_QIDS, '地名(住所区分)', true, 600);

  const out = [
    ...nouns,
    ...proverbs,
    ...fieldTerms,
    ...(await extractWikidataBeings(seenReadings)),
    ...(await extractWikidataHumans(seenReadings)),
    ...extractMythology(fullData, seenReadings),
    ...properNouns.out,
  ];

  console.log(`抽出できた語数の合計: ${out.length}`);
  const outPath = path.join(ROOT, 'words-auto.tsv');
  await fs.writeFile(outPath, stringifyTSV(out), 'utf-8');
  console.log(`書き出し完了: ${outPath}`);
}

main().catch(err => { console.error('失敗:', err.message); process.exit(1); });
