import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHiragana, analyzeEnding, startKana, acceptableStartKana } from '../kana.js';

test('toHiragana: カタカナをひらがなに変換する', () => {
  assert.equal(toHiragana('ラーメン'), 'らーめん');
  assert.equal(toHiragana('コーヒー'), 'こーひー');
  assert.equal(toHiragana('いぬ'), 'いぬ');
});

test('analyzeEnding: 「ん」で終わる語は isN:true になる', () => {
  assert.deepEqual(analyzeEnding('らーめん'), {kana:null, isN:true});
  assert.deepEqual(analyzeEnding('みかん'), {kana:null, isN:true});
  assert.deepEqual(analyzeEnding('ペン'), {kana:null, isN:true}); // カタカナのまま渡しても判定できる
});

test('analyzeEnding: 長音「ー」で終わる語は直前の音の母音に変換する', () => {
  assert.deepEqual(analyzeEnding('こーひー'), {kana:'い', isN:false}); // ひ→い段
  assert.deepEqual(analyzeEnding('たわー'), {kana:'あ', isN:false});   // わ→あ段
  assert.deepEqual(analyzeEnding('じゅーす'), {kana:'す', isN:false}); // 語尾は「す」で通常判定(長音は語中)
});

test('analyzeEnding: 長音の直前が拗音・小さい母音のときも正しく母音に変換する', () => {
  // 「てぃー」「しょー」「ゅー」のような、外来語で頻出する 小さいかな+長音 の組み合わせ。
  // VOWEL_MAP には小さいかなが無いため、SMALL_YOON で正規化してから引く必要がある。
  assert.deepEqual(analyzeEnding('りーどしてぃー'), {kana:'い', isN:false}); // てぃ→い段(実例: リードシティー)
  assert.deepEqual(analyzeEnding('ぱーてぃー'), {kana:'い', isN:false});     // パーティー
  assert.deepEqual(analyzeEnding('でびゅー'), {kana:'う', isN:false});       // デビュー ゅ→ゆ→う段
  assert.deepEqual(analyzeEnding('しょー'), {kana:'お', isN:false});         // ショー ょ→よ→お段
});

test('analyzeEnding: 歴史的仮名遣い(ゐ/ゑ)を含む長音も母音に変換できる', () => {
  assert.deepEqual(analyzeEnding('ぶろーどうゑー'), {kana:'え', isN:false}); // ブロードウェー ゑ→え段
});

test('analyzeEnding: 拗音「ゃゅょ」で終わる語は や/ゆ/よ に正規化する', () => {
  assert.deepEqual(analyzeEnding('とんきゃ'), {kana:'や', isN:false});
  assert.deepEqual(analyzeEnding('ひゅ'), {kana:'ゆ', isN:false});
  assert.deepEqual(analyzeEnding('ひょ'), {kana:'よ', isN:false});
});

test('analyzeEnding: 小さい「っ」を含んでも語末が通常音なら影響しない', () => {
  assert.deepEqual(analyzeEnding('しっぽ'), {kana:'ぽ', isN:false});
});

test('analyzeEnding: 通常の語は最後の1文字がそのまま次の音になる', () => {
  assert.deepEqual(analyzeEnding('いぬ'), {kana:'ぬ', isN:false});
  assert.deepEqual(analyzeEnding('さくら'), {kana:'ら', isN:false});
});

test('analyzeEnding: 空文字列やnullは安全に処理する', () => {
  assert.deepEqual(analyzeEnding(''), {kana:null, isN:false});
  assert.deepEqual(analyzeEnding(null), {kana:null, isN:false});
});

test('startKana: 先頭の1文字を返す(カタカナはひらがな化)', () => {
  assert.equal(startKana('いぬ'), 'い');
  assert.equal(startKana('ラーメン'), 'ら');
  assert.equal(startKana(''), null);
});

test('acceptableStartKana: 濁点・半濁点付きの音は清音からの開始も許容する', () => {
  assert.deepEqual(acceptableStartKana('ば'), ['ば', 'は']);
  assert.deepEqual(acceptableStartKana('ぱ'), ['ぱ', 'は']); // 半濁点も同じ清音(は行)に戻る
  assert.deepEqual(acceptableStartKana('が'), ['が', 'か']);
  assert.deepEqual(acceptableStartKana('ゔ'), ['ゔ', 'う']);
});

test('acceptableStartKana: 歴史的仮名遣い(を/ゐ/ゑ)は現代仮名遣いからの開始も許容する', () => {
  assert.deepEqual(acceptableStartKana('を'), ['を', 'お']);
  assert.deepEqual(acceptableStartKana('ゐ'), ['ゐ', 'い']);
  assert.deepEqual(acceptableStartKana('ゑ'), ['ゑ', 'え']);
});

test('acceptableStartKana: 清音や通常の音は緩和の対象にならず単一のまま', () => {
  assert.deepEqual(acceptableStartKana('か'), ['か']);
  assert.deepEqual(acceptableStartKana('お'), ['お']); // お段自体は緩和対象ではない(を→おの一方向のみ)
  assert.deepEqual(acceptableStartKana(null), []);
});
