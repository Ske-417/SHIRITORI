#!/usr/bin/env node
/**
 * scripts/fetch-words.mjs
 *
 * JMdict-simplified / JMnedict-simplified (https://github.com/scriptin/jmdict-simplified) の
 * 最新リリースから公開データをダウンロードし、しりとりの手として使える語を抽出して
 * words-auto.json を作り直します。
 *
 * 使い方:
 *   npm install
 *   npm run fetch-words
 *
 * 生成物: ../words-auto.json (プロジェクトルート、既存ファイルを上書きします)
 * ※ 手作業で日本語の意味を付けたコア辞書は words-core.json に分離してあり、
 *   このスクリプトが触るのは words-auto.json だけです。
 *
 * 抽出対象:
 *   1. 一般名詞      … jmdict-eng-common から品詞タグが名詞系のものだけ (よく使われる語のみ)
 *   2. ことわざ・故事成語 … jmdict-eng (フル版) から misc タグ "proverb" / "yoji" が付いた語
 *   3. 専門用語      … jmdict-eng (フル版) から field タグが医学・化学系の語
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
 * - gloss(意味)は英語のみです。日本語の意味が欲しい語は words-core.json 側に追加してください。
 * - Node.js 18 以降 (fetch 標準搭載) が必要です。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = 'scriptin/jmdict-simplified';

// しりとりの読みとして許容する文字種(純粋なひらがな+長音のみ)
const KANA_ONLY = /^[ぁ-ゖー]+$/;

// JMdict の partOfSpeech は "n" を含むだけの部分一致で判定すると
// interjection(int)や Noh(noh)、Nagano-ben(nab)まで誤って拾ってしまうため、
// 名詞系タグのみを厳密に列挙する。
const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pref', 'n-suf', 'n-pr']);

// 抽出する語数の上限。種別ごとに設けているのは、無名すぎる語(人名の末端など)で
// 辞書全体が埋まってゲームとして破綻するのを避けるため。値自体はここで調整できる。
const CAPS = {
  noun: 20000,
  place: 80000,
  person: 40000, // 著名人(伝記情報あり)のみ採用するため、上限自体は実質効かない想定
};
const CAP_DEFAULT = Infinity; // company / product / work / group / station など元々件数が少ないものは無制限

// JMdict の field タグのうち、医学・化学(および隣接する生物医学系)とみなすもの。
// これらは専門用語なので「よく使われる(common)」条件を外して抽出する。
const MEDICAL_CHEMISTRY_FIELDS = new Set([
  'med', 'chem', 'biochem', 'pharm', 'anat', 'physiol', 'pathol',
  'genet', 'dent', 'surg', 'embryo', 'vet',
]);

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

function addEntry(out, seenReadings, cap, { w, r, m }){
  if(!KANA_ONLY.test(r)) return false;
  if(r.length < 2) return false;
  if(seenReadings.has(r)) return false;
  if(out.length >= cap) return false;
  seenReadings.add(r);
  out.push({ w, r, m });
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

    addEntry(out, seenReadings, CAPS.noun, {
      w: (kanjiCommon && kanjiCommon.text) || kanaCommon.text,
      r: reading,
      m: `(en) ${gloss.text}`,
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
      m: `(en) ${gloss.text}`,
    });
  }
  console.log(`ことわざ・故事成語: ${out.length}語`);
  return out;
}

function extractTechnicalTerms(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const isTarget = word.sense.some(s => (s.field || []).some(f => MEDICAL_CHEMISTRY_FIELDS.has(f)));
    if(!isTarget) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: `(en) ${gloss.text}`,
    });
  }
  console.log(`医学・化学系専門用語: ${out.length}語`);
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
      m: `(en) ${gloss.text}`,
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
  if(cand.type === 'place' && !cand.hasKanji) return 0;
  return 1;
}

function primaryNameType(word){
  const types = new Set();
  for(const t of word.translation) for(const ty of (t.type || [])) types.add(ty);
  for(const t of NAME_TYPE_PRIORITY) if(types.has(t)) return t;
  return null;
}

function extractProperNouns(data, seenReadings){
  const buckets = new Map(); // type -> array of {w,r,hasKanji,type,m}
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const type = primaryNameType(word);
    if(!type) continue;

    // person/surname/given/fem/masc/unclass はJMnedict上ただの名前読み辞書であり、
    // 無名な人物も大量に含まれる。生没年などの伝記情報が確認できる語(=著名人と
    // 判定できる語)だけを採用する。それ以外の種別(地名・組織名・神話上の人物など、
    // 個人の実名ではないもの)はこの条件を課さない。
    // 伝記情報がある場合は、種別ラベルの代わりにその伝記情報自体を意味欄に使う
    // (しりとり中に「誰なのか」がそのまま分かるようにするため)。
    let m = NAME_TYPE_LABEL[type];
    if(PERSON_TYPES_REQUIRE_BIO.has(type)){
      const bio = getBioText(word.translation);
      if(!bio) continue;
      m = `(en) ${bio}`;
    }

    const reading = toHiragana(kana.text);
    if(!KANA_ONLY.test(reading) || reading.length < 2) continue;
    const kanji = word.kanji && word.kanji[0];
    const cand = {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      hasKanji: !!kanji,
      type,
      m,
    };
    if(!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push(cand);
  }

  const out = [];
  for(const type of NAME_TYPE_PRIORITY){
    const bucket = buckets.get(type);
    if(!bucket) continue;
    // rankTier: place について海外由来(漢字表記なし)を優先して上限内に収める。
    // Array#sort は安定ソートなので、同ティア内は元の並び順を保つ。
    bucket.sort((a, b) => rankTier(a) - rankTier(b));
    const cap = CAPS[type] ?? CAP_DEFAULT;
    let added = 0;
    for(const cand of bucket){
      if(added >= cap) break;
      if(addEntry(out, seenReadings, Infinity, { w: cand.w, r: cand.r, m: cand.m })) added++;
    }
  }
  console.log(`固有名詞: ${out.length}語`);
  return out;
}

// Wikidata由来のカテゴリ。directOnly=true は P31 の直接インスタンスのみを対象にする
// (Q95074「架空のキャラクター」は下位クラスが非常に多く、P279*での再帰検索は
//  クエリがタイムアウトしやすいため直接インスタンスのみに絞っている)。
const WIKIDATA_CATEGORIES = [
  { qid: 'Q22989102', label: '神話の神', directOnly: false },
  { qid: 'Q24334685', label: '神話・伝説の生物', directOnly: false },
  { qid: 'Q95074', label: '架空のキャラクター', directOnly: true },
];
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_USER_AGENT = 'shiritori-dojo-fetch-words/1.0 (https://github.com/; educational hobby project)';

async function sparql(query){
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': WIKIDATA_USER_AGENT }
  });
  if(!res.ok) throw new Error(`Wikidata SPARQL error: ${res.status}`);
  const data = await res.json();
  return data.results.bindings;
}

async function fetchWikidataLabels(qid, directOnly){
  const path = directOnly ? 'wdt:P31' : 'wdt:P31/wdt:P279*';
  const query = `SELECT ?item ?itemLabel WHERE { ?item ${path} wd:${qid} . ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja') }`;
  return sparql(query);
}

// 説明文はラベル取得とは別クエリでバッチ取得する(1クエリにまとめるとタイムアウトしやすいため)。
async function fetchWikidataDescriptions(qids){
  const out = new Map();
  const CHUNK = 300;
  for(let i = 0; i < qids.length; i += CHUNK){
    const chunk = qids.slice(i, i + CHUNK);
    const values = chunk.map(q => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?desc WHERE { VALUES ?item { ${values} } ?item schema:description ?desc . FILTER(LANG(?desc)='ja') }`;
    const rows = await sparql(query);
    for(const row of rows) out.set(row.item.value.split('/').pop(), row.desc.value);
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
      const rows = await fetchWikidataLabels(cat.qid, cat.directOnly);
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
        const desc = descMap.get(c.qid);
        const m = desc ? `${desc} [Wikidata:${c.qid}]` : `${cat.label} [Wikidata:${c.qid}]`;
        if(addEntry(out, seenReadings, Infinity, { w: c.w, r: c.r, m })) added++;
      }
      console.log(`Wikidata(${cat.label}): ${added}語(説明文あり ${descMap.size}件)`);
    }catch(err){
      console.warn(`Wikidata取得に失敗しました(${cat.label}): ${err.message} — このカテゴリはスキップします`);
    }
  }
  return out;
}

async function main(){
  console.log('最新リリース情報を取得中…');
  const [commonAsset, fullAsset, neAsset] = await Promise.all([
    getAsset(/^jmdict-eng-common-.*\.json\.zip$/),
    getAsset(/^jmdict-eng-\d.*\.json\.zip$/),
    getAsset(/^jmnedict-all-.*\.json\.zip$/),
  ]);

  const [commonData, fullData, neData] = await Promise.all([
    downloadJson(commonAsset),
    downloadJson(fullAsset),
    downloadJson(neAsset),
  ]);

  // Wikidataは神話・架空の存在について日本語の説明文を持つことが多く、JMdict/JMnedictの
  // 単純な種別ラベルより情報量が多いため、読みが重複した場合はWikidata側を優先する
  // (=先に登録する)順序にしている。
  const seenReadings = new Set();
  const out = [
    ...extractNouns(commonData, seenReadings),
    ...extractProverbsAndYoji(fullData, seenReadings),
    ...extractTechnicalTerms(fullData, seenReadings),
    ...(await extractWikidataBeings(seenReadings)),
    ...extractMythology(fullData, seenReadings),
    ...extractProperNouns(neData, seenReadings),
  ];

  console.log(`抽出できた語数の合計: ${out.length}`);
  const outPath = path.join(ROOT, 'words-auto.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`書き出し完了: ${outPath}`);
}

main().catch(err => { console.error('失敗:', err.message); process.exit(1); });
