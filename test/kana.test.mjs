import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHiragana, analyzeEnding, startKana } from '../kana.js';

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
