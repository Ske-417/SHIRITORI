// かな処理ユーティリティ。script.js と test/kana.test.mjs の両方から読み込む。
const KATA_OFFSET = 0x60;

export function toHiragana(str){
  if(!str) return str;
  return str.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - KATA_OFFSET));
}

export const VOWEL_MAP = {
  'あ':'あ','か':'あ','さ':'あ','た':'あ','な':'あ','は':'あ','ま':'あ','や':'あ','ら':'あ','わ':'あ','が':'あ','ざ':'あ','だ':'あ','ば':'あ','ぱ':'あ',
  'い':'い','き':'い','し':'い','ち':'い','に':'い','ひ':'い','み':'い','り':'い','ぎ':'い','じ':'い','び':'い','ぴ':'い',
  'う':'う','く':'う','す':'う','つ':'う','ぬ':'う','ふ':'う','む':'う','ゆ':'う','る':'う','ぐ':'う','ず':'う','づ':'う','ぶ':'う','ぷ':'う',
  'え':'え','け':'え','せ':'え','て':'え','ね':'え','へ':'え','め':'え','れ':'え','げ':'え','ぜ':'え','で':'え','べ':'え','ぺ':'え',
  'お':'お','こ':'お','そ':'お','と':'お','の':'お','ほ':'お','も':'お','よ':'お','ろ':'お','を':'お','ご':'お','ぞ':'お','ど':'お','ぼ':'お','ぽ':'お'
};

export const SMALL_YOON = {'ゃ':'や','ゅ':'ゆ','ょ':'よ','ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お'};

// 語尾から「次に続くべき音」を求める。「ん」で終わっていれば isN:true (=その場で負け)
export function analyzeEnding(readingRaw){
  const reading = toHiragana(readingRaw || '').trim();
  if(!reading) return {kana:null, isN:false};
  const last = reading[reading.length-1];
  if(last === 'ん') return {kana:null, isN:true};
  if(last === 'ー'){
    const prev = reading[reading.length-2];
    return {kana: VOWEL_MAP[prev] || null, isN:false};
  }
  if(SMALL_YOON[last]) return {kana: SMALL_YOON[last], isN:false};
  return {kana:last, isN:false};
}

export function startKana(readingRaw){
  const reading = toHiragana(readingRaw||'').trim();
  return reading ? reading[0] : null;
}
