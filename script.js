import { toHiragana, analyzeEnding, startKana, acceptableStartKana } from './kana.js';
import { parseTSV } from './tsv.js';

(function(){
  const appEl = document.getElementById('app');
  const contactsEl = document.getElementById('contacts');
  const restartAllBtn = document.getElementById('restartAllBtn');
  const backBtn = document.getElementById('backBtn');
  const chainEl = document.getElementById('chain');
  const inputEl = document.getElementById('wordInput');
  const submitBtn = document.getElementById('submitBtn');
  const medallion = document.getElementById('medallion');
  const medallionLabel = document.getElementById('medallionLabel');
  const chatNameEl = document.getElementById('chatName');
  const toastEl = document.getElementById('toast');
  const timerFill = document.getElementById('timerFill');
  const timerLabel = document.getElementById('timerLabel');

  let WORDS = [];               // 辞書番(AI)専用の辞書。ユーザーの入力判定には使わない。全会話で共有する
  let busy = true;              // 現在アクティブな会話がターン処理中かどうか(処理中は会話の切り替えを禁止する)

  // ---------------- 「6人のチャット相手」(6段階の帯ランク) ----------------
  // メッセンジャーアプリの連絡先リストのように、強さ・持ち時間の有無の組み合わせ
  // ごとに別々の相手(=別々の対局・別々の会話履歴)として扱う。対局中の強さ変更や
  // 持ち時間のON/OFF切り替えという概念は無くなり、代わりに「どの相手とチャット
  // しているか」を選ぶ形になる。「道場」らしく、持ち時間の有無も含めた易しい順を
  // 空手・柔道等の帯の色になぞらえた6段階のランクとして表現する(持ち時間ありの方が
  // 同じ強さの持ち時間無しより難しい、という前提で並べている)。
  const STRENGTH_LABELS = { easy:'やさしめ', normal:'ふつう', hard:'めちゃ強い' };
  const RANKS = [
    { strength:'easy',   timerOn:false, belt:'白帯', beltClass:'white'  },
    { strength:'easy',   timerOn:true,  belt:'黄帯', beltClass:'yellow' },
    { strength:'normal', timerOn:false, belt:'緑帯', beltClass:'green'  },
    { strength:'normal', timerOn:true,  belt:'青帯', beltClass:'blue'   },
    { strength:'hard',   timerOn:false, belt:'茶帯', beltClass:'brown'  },
    { strength:'hard',   timerOn:true,  belt:'黒帯', beltClass:'black'  },
  ];
  const CONTACTS = RANKS.map(r => ({
    id: r.strength + '-' + (r.timerOn ? 'timer' : 'notimer'),
    strength: r.strength,
    timerOn: r.timerOn,
    belt: r.belt,
    beltClass: r.beltClass,
    name: '辞書番【' + r.belt + '】',
  }));
  const CONTACTS_BY_ID = new Map(CONTACTS.map(c => [c.id, c]));

  const TURN_TIME_LIMIT = 60; // 秒(強さに関わらず一律)
  function freshConversationState(contact){
    return {
      strength: contact.strength,
      timerOn: contact.timerOn,
      usedReadings: new Set(), // これまでに場に出た「読み」(ユーザー・AI問わず)
      requiredKana: null,      // null = 最初の一手は自由
      gameOver: false,
      turnRemaining: TURN_TIME_LIMIT,
      aiTurnCount: 0,           // 辞書番がこれまでに打った手数(「ん」うっかり率を対局の長さに応じて上げるため)
      cards: [],                // 表示履歴(会話を切り替えて戻ってきたときに再描画するため)
    };
  }
  let conversations = new Map(CONTACTS.map(c => [c.id, freshConversationState(c)]));
  let activeId = 'hard-timer'; // 従来のデフォルト(強さ「めちゃ強い」・持ち時間ON)に合わせる
  function active(){ return conversations.get(activeId); }

  // usedReadingsはアクティブな会話のSetへの参照をそのまま持つショートカット
  // (中身をadd()するだけなら会話オブジェクト側にも自動的に反映される)。
  // turnRemainingは表示用の数値なので、会話切り替え時に明示的に保存・復元する。
  let usedReadings = active().usedReadings;
  let turnRemaining = active().turnRemaining;

  // ---------------- 持ち時間 ----------------
  let turnInterval = null;
  function renderTurnTimerDisplay(){
    if(!active().timerOn){
      timerFill.style.width = '100%'; timerFill.classList.remove('urgent');
      timerLabel.textContent = 'OFF'; timerLabel.classList.remove('urgent');
      return;
    }
    const pct = Math.max(0, (turnRemaining / TURN_TIME_LIMIT) * 100);
    timerFill.style.width = pct + '%';
    timerLabel.textContent = turnRemaining + '秒';
    const urgent = turnRemaining <= 10;
    timerFill.classList.toggle('urgent', urgent);
    timerLabel.classList.toggle('urgent', urgent);
  }
  function tickTurnTimer(){
    turnRemaining--;
    if(turnRemaining <= 0){
      clearInterval(turnInterval); turnInterval = null;
      turnRemaining = 0;
      renderTurnTimerDisplay();
      handleTimeout();
      return;
    }
    renderTurnTimerDisplay();
  }
  // 新しい手番を丸ごと開始する(持ち時間をTURN_TIME_LIMITに戻す)。
  function startTurnTimer(){
    if(turnInterval){ clearInterval(turnInterval); turnInterval = null; }
    turnRemaining = TURN_TIME_LIMIT;
    renderTurnTimerDisplay();
    if(!active().timerOn || !active().requiredKana) return; // OFF、または最初の自由な一手は計測しない
    turnInterval = setInterval(tickTurnTimer, 1000);
  }
  // 送信中の一瞬だけ計測を止める(残り時間はそのまま保持する)。
  function pauseTurnTimer(){
    if(turnInterval){ clearInterval(turnInterval); turnInterval = null; }
  }
  // 「読みが特定できません」等、その場で弾かれた無効な入力の後や、会話を
  // 切り替えて戻ってきたときに使う。新しい手番ではないので、残り時間を
  // TURN_TIME_LIMITに戻さずそこから再開する。
  function resumeTurnTimer(){
    renderTurnTimerDisplay();
    if(!active().timerOn || !active().requiredKana || active().gameOver || turnInterval) return;
    turnInterval = setInterval(tickTurnTimer, 1000);
  }
  // 対局終了時や、最初の自由な一手に戻ったときに使う(表示を60秒/フルに戻して止める)。
  function clearTurnTimer(){
    if(turnInterval){ clearInterval(turnInterval); turnInterval = null; }
    turnRemaining = TURN_TIME_LIMIT;
    renderTurnTimerDisplay();
  }

  // ---------------- UI ヘルパー ----------------
  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 2800);
  }
  function showScreen(name){
    // スマホ幅では「トーク一覧」と「個別チャット」を画面遷移で切り替える
    // (LINE等の実際のメッセンジャーアプリと同様)。PC幅ではCSS側で常に
    // 両方表示するため、このクラスは無視される。
    appEl.classList.toggle('screen-chat', name === 'chat');
  }
  const BELT_CLASSES = RANKS.map(r => 'belt-' + r.beltClass);
  function updateChatHeader(){
    const c = CONTACTS_BY_ID.get(activeId);
    chatNameEl.textContent = c.name;
    // ヘッダーのアバター(medallion)も、選んでいる相手の帯の色に合わせる。
    medallion.classList.remove(...BELT_CLASSES);
    medallion.classList.add('belt-' + c.beltClass);
  }
  // medallionLabelは、チャット相手(辞書番)の名前の下にある「オンライン状態」の
  // ようなステータステキストとして表示する(メッセンジャーアプリの見た目に
  // 合わせるため、対局の進行状況をここに集約している)。
  function updateMedallion(){
    const conv = active();
    medallion.classList.remove('multi');
    if(conv.gameOver){ medallion.textContent = '終'; medallionLabel.textContent = '対局終了'; return; }
    if(!conv.requiredKana){ medallion.textContent = '―'; medallionLabel.textContent = '最初のことばへ'; return; }
    const opts = acceptableStartKana(conv.requiredKana);
    if(opts.length > 1){
      medallion.textContent = opts.join('/');
      medallion.classList.add('multi');
    }else{
      medallion.textContent = conv.requiredKana;
    }
    medallionLabel.textContent = '「' + conv.requiredKana + '」から始めてください';
  }
  // d(簡単な解説)があればそれを表示に使い、無ければ従来のm(種別ラベル/英語glossなど)に
  // フォールバックする。dはまだ全語には付いていないため、この関数を通して常に安全に読む。
  function entryMeaning(e){ return (e && (e.d || e.m)) || null; }
  function scrollToBottom(){ chainEl.scrollTop = chainEl.scrollHeight; }

  function markReading(reading, markFirst, markLast){
    const chars = reading.split('');
    return chars.map((c,i) => {
      const isMark = (markFirst && i===0) || (markLast && i===chars.length-1);
      return isMark ? '<span class="mark">'+c+'</span>' : c;
    }).join('');
  }

  // カードのDOM構築だけを行う純粋な関数(履歴からの再描画にも使うため、
  // 「会話に記録する」処理とは分離してある)。
  function buildCardEl({word, reading, meaning, by, invalid, reason, requiredWasSet}){
    const card = document.createElement('div');
    card.className = 'card ' + by + (invalid ? ' invalid' : '');
    if(!invalid){
      const wordRow = document.createElement('div');
      wordRow.className = 'word-row';
      const w = document.createElement('div'); w.className = 'word'; w.textContent = word;
      const r = document.createElement('div'); r.className = 'reading';
      r.innerHTML = markReading(reading, !!requiredWasSet, true);
      wordRow.appendChild(w); wordRow.appendChild(r);
      card.appendChild(wordRow);
      if(meaning){ const m = document.createElement('div'); m.className='meaning'; m.textContent = meaning; card.appendChild(m); }
    }else{
      const w = document.createElement('div'); w.className='word'; w.style.fontSize='16px'; w.textContent = word || '(不明)';
      card.appendChild(w);
      const rs = document.createElement('div'); rs.className='reason'; rs.textContent = reason || '無効です';
      card.appendChild(rs);
    }
    return card;
  }
  function buildGameOverEl({winner, note}){
    const el = document.createElement('div');
    el.className = 'gameover';
    const win = winner === 'user';
    const result = document.createElement('div');
    result.className = 'result ' + (win ? 'win' : 'lose');
    result.textContent = win ? 'あなたの勝ち' : '辞書番の勝ち';
    const p = document.createElement('p');
    p.innerHTML = note; // note はこちらで組み立てた文字列のみで、ユーザー入力を直接挿入することは無い
    el.appendChild(result); el.appendChild(p);
    return el;
  }

  function renderCard(data){
    active().cards.push({ kind:'card', ...data });
    const emptyHint = document.getElementById('emptyHint');
    if(emptyHint && emptyHint.parentNode) emptyHint.remove();
    chainEl.appendChild(buildCardEl(data));
    scrollToBottom();
    renderContactList(); // 一覧側の「最後のメッセージ」プレビューを更新する
  }
  function renderThinking(by){
    const el = document.createElement('div');
    el.className = 'thinking-card ' + by;
    el.id = 'thinkingCard';
    el.innerHTML = (by==='ai' ? '辞書番、考え中' : '受理中') + '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    chainEl.appendChild(el); scrollToBottom();
  }
  function removeThinking(){ const el = document.getElementById('thinkingCard'); if(el) el.remove(); }
  function renderGameOver(winner, note){
    active().cards.push({ kind:'gameover', winner, note });
    chainEl.appendChild(buildGameOverEl({winner, note}));
    scrollToBottom();
    renderContactList();
  }
  // 会話を切り替えたとき、保存しておいた履歴からチャットログを丸ごと再構築する。
  function renderChainFromHistory(conv){
    chainEl.innerHTML = '';
    if(conv.cards.length === 0){
      chainEl.innerHTML = '<div class="empty-hint" id="emptyHint"><div class="kanban-mini">— 対局開始 —</div>ひらがな・カタカナで、ことばを入力してください。<br>読みが「ん」で終わったら、その場で負けです。</div>';
      return;
    }
    for(const item of conv.cards){
      chainEl.appendChild(item.kind === 'card' ? buildCardEl(item) : buildGameOverEl(item));
    }
    scrollToBottom();
  }

  // ---------------- 連絡先(トーク)一覧 ----------------
  function contactPreview(conv){
    for(let i = conv.cards.length - 1; i >= 0; i--){
      const item = conv.cards[i];
      if(item.kind === 'gameover') return item.winner === 'user' ? 'あなたの勝ち' : '辞書番の勝ち';
      if(item.kind === 'card' && !item.invalid) return (item.by === 'user' ? 'あなた: ' : '辞書番: ') + item.word;
    }
    return 'まだ対局していません';
  }
  function renderContactList(){
    contactsEl.innerHTML = '';
    for(const c of CONTACTS){
      const conv = conversations.get(c.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'contact-row' + (c.id === activeId ? ' active' : '');

      const avatar = document.createElement('div');
      avatar.className = 'contact-avatar belt-' + c.beltClass;
      avatar.textContent = '辞';

      const info = document.createElement('div');
      info.className = 'contact-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'contact-name-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'contact-name';
      nameEl.textContent = c.name;
      const badge = document.createElement('span');
      badge.className = 'contact-badge';
      badge.textContent = STRENGTH_LABELS[c.strength];
      nameRow.appendChild(nameEl); nameRow.appendChild(badge);

      const meta = document.createElement('div');
      meta.className = 'contact-meta';
      meta.textContent = c.timerOn ? '持ち時間60秒' : '持ち時間なし';

      const preview = document.createElement('div');
      preview.className = 'contact-preview';
      preview.textContent = contactPreview(conv);

      info.appendChild(nameRow); info.appendChild(meta); info.appendChild(preview);
      row.appendChild(avatar); row.appendChild(info);
      row.addEventListener('click', () => selectContact(c.id));
      contactsEl.appendChild(row);
    }
  }
  function selectContact(id){
    if(busy) return; // ターン処理中の切り替えは禁止(処理中の会話が宙に浮くのを避ける)
    if(id !== activeId){
      pauseTurnTimer();
      active().turnRemaining = turnRemaining; // 現在の残り時間を出て行く会話側に保存

      activeId = id;
      const conv = active();
      usedReadings = conv.usedReadings;
      turnRemaining = conv.turnRemaining;

      renderChainFromHistory(conv);
      updateChatHeader();
      updateMedallion();
      setBusy(false);
      if(!conv.gameOver && conv.requiredKana) resumeTurnTimer();
      else clearTurnTimer();
      renderContactList();
    }
    showScreen('chat');
    inputEl.focus();
  }
  function restartAll(){
    if(busy) return;
    pauseTurnTimer();
    conversations = new Map(CONTACTS.map(c => [c.id, freshConversationState(c)]));
    const conv = active();
    usedReadings = conv.usedReadings;
    turnRemaining = conv.turnRemaining;
    renderChainFromHistory(conv);
    updateChatHeader();
    updateMedallion();
    setBusy(false);
    clearTurnTimer();
    renderContactList();
    inputEl.focus();
  }

  // ---------------- ゲームロジック ----------------

  // ユーザーの入力は「実在する言葉である」ことを前提として信頼する。
  // 辞書には無くても構わない。ただし読み(かな)を確定させる必要があるので、
  //  1) まず辞書に完全一致する語があれば、その読み・意味を使う(表示が豊かになる)
  //  2) 無ければ、入力そのもの(カタカナはひらがなに変換)をそのまま読みとして扱う
  // これにより「辞書にあるかどうか」はもう合否の条件にならない。
  function resolveUserWord(inputRaw){
    const input = inputRaw.trim();
    if(!input) return null;
    const hira = toHiragana(input);

    const dictHit = WORDS.find(e => e.w === input || e.r === input || e.r === hira);
    if(dictHit){
      return { word: dictHit.w, reading: dictHit.r, meaning: entryMeaning(dictHit) };
    }
    // 辞書外でも、純粋なかなであれば読みとしてそのまま信頼する
    if(/^[ぁ-んゔー]+$/.test(hira)){
      return { word: input, reading: hira, meaning: null };
    }
    return null; // 漢字表記かつ辞書に無く、読みが特定できない
  }

  // 語彙が数万語規模になったため、「かな→その音で始まる語」の索引を読み込み時に一度だけ作り、
  // 候補列挙のたびに全語をなめないようにする。
  let wordsByKana = new Map();
  function buildWordIndex(){
    wordsByKana = new Map();
    for(const e of WORDS){
      const k = startKana(e.r);
      if(!k) continue;
      if(!wordsByKana.has(k)) wordsByKana.set(k, []);
      wordsByKana.get(k).push(e);
    }
  }
  // kana から始まる語に加え、濁点/半濁点を外した清音や歴史的仮名遣いの現代読みで
  // 始まる語も候補に含める(acceptableStartKana、このアプリの緩和ルール)。
  function candidatesFor(kana, used){
    const out = [];
    for(const k of acceptableStartKana(kana)){
      for(const e of (wordsByKana.get(k) || [])){
        if(!used.has(e.r)) out.push(e);
      }
    }
    return out;
  }
  // 使用済みを考慮しない、おおよその「かな→語数」。深い先読みの枝刈り(有望な候補の絞り込み)にのみ使う概算値。
  function kanaSizeApprox(kana){
    if(!kana) return 0;
    let sum = 0;
    for(const k of acceptableStartKana(kana)) sum += (wordsByKana.get(k) || []).length;
    return sum;
  }

  // 制限時間切れの際、「ちなみにこんな言葉があった」という一例を示すための候補探し。
  // requiredKana が無い(最初の一手)場合は未使用の語からランダムに1つ選ぶ。
  function pickHintWord(kana){
    const pool = kana ? candidatesFor(kana, usedReadings) : WORDS.filter(e => !usedReadings.has(e.r));
    if(pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const LOOKAHEAD_BRANCH_CAP = 12; // 2手目以降で深掘りする候補数の上限(枝刈り)
  const HARD_OUTER_CAP = 50;       // 一手目候補のうち、深く読むのは有望な上位何件までか
  const HARD_LOOKAHEAD_DEPTH = 2;  // 0=1手先読み(従来通り) 1=2手先読み 2=3手先読み

  // 語彙(words-auto.tsv)には都道府県・主要都市・広く知られた偉人などに
  // t:1(著名)の目印が付いている。数万〜数十万語の中に埋もれて滅多に選ばれない
  // ということがないよう、AIの手選びで優先的に(=高い確率で)選ぶための重み。
  // 0にはしない(=完全に選ばなくなる)ことで無名な語(ニッチな語)も出続けるようにする。
  const FAME_WEIGHT = 6;
  // d(簡単な日本語解説)が付いている語を優先する重み。mは「普通名詞」等の
  // 分類ラベルに過ぎずほぼ全語に付いているため判定には使わない。プレイヤーが
  // 「へえ」となるような語が出やすくなるよう、著名度の重みとは別に掛け合わせる。
  const DEF_WEIGHT = 4;
  const HARD_FAMOUS_SHORTLIST = 20;   // 上位HARD_OUTER_CAPに入らなくても、著名な語・解説付きの語は別枠でこの件数まで深掘り対象に加える
  const HARD_NEAR_OPTIMAL_MARGIN = 1; // 最善のdeepScoreからこの差までは「ほぼ互角」として著名優先の対象にする
  function weightedPick(list){
    if(list.length === 1) return list[0];
    const weights = list.map(s =>
      (s.e.t === 1 ? FAME_WEIGHT : 1) * (s.e.d ? DEF_WEIGHT : 1)
    );
    const total = weights.reduce((a,b) => a+b, 0);
    let r = Math.random() * total;
    for(let i = 0; i < list.length; i++){
      r -= weights[i];
      if(r <= 0) return list[i];
    }
    return list[list.length-1];
  }

  // kana から始まる語を選ぶ番の人にとって「その後どれだけ選択肢が少ないか」を depth 手先まで評価する。
  // depth<=0 ならその場の候補数をそのまま返す(=1手先読み相当)。depth>0 では、
  // お互いが同じ基準(相手の選択肢を最も減らす手)で最適に打ち続けたと仮定して深く評価する。
  // 候補数が多い場合は kanaSizeApprox の概算値で有望な候補だけに絞ってから再帰する(全探索は重すぎるため)。
  function minimaxOptions(kana, used, depth){
    const pool = candidatesFor(kana, used);
    if(pool.length === 0 || depth <= 0) return pool.length;

    let candidates = pool;
    if(candidates.length > LOOKAHEAD_BRANCH_CAP){
      candidates = [...pool].sort((a,b) => {
        const ea = analyzeEnding(a.r), eb = analyzeEnding(b.r);
        return kanaSizeApprox(ea.isN ? null : ea.kana) - kanaSizeApprox(eb.isN ? null : eb.kana);
      }).slice(0, LOOKAHEAD_BRANCH_CAP);
    }

    let best = Infinity;
    for(const e of candidates){
      const end = analyzeEnding(e.r);
      let val;
      if(end.isN){
        val = 0; // 相手を「ん」で終わる語に追い込めれば、それ以上ないくらい良い手
      }else{
        used.add(e.r);
        val = minimaxOptions(end.kana, used, depth - 1);
        used.delete(e.r);
      }
      if(val < best) best = val;
      if(best === 0) break;
    }
    return best;
  }

  // 「やさしめ」「ふつう」では辞書番が選べる語彙そのものを絞る(=知らない語は言わない)。
  // 上限が無いと辞書番は常に全375,000語超から最適に近い手を選べてしまい、こちらが
  // どれだけ言葉を知っていても勝ち筋(相手の持ち駒を尽きさせる/「ん」に追い込む)が
  // ほぼ存在しなかったため。t===1は有名な地名・人物・よく使われる一般名詞(約2万語)。
  // 「やさしめ」はそこからさらに読みが4文字以下の短い語(=基本的な語が中心、約1.3万語)
  // に絞る。dは簡単な解説が付いている語(有名語含め約11.5万語)。「めちゃ強い」だけ無制限。
  const EASY_VOCAB = e => e.t === 1 && e.r.length <= 4;
  const NORMAL_VOCAB = e => e.t === 1 || !!e.d;

  // 語彙を絞るだけでは、対局が長く続いても辞書番が絶対に「ん」を選ばない(=自滅しない)
  // ため、勝ち筋がほぼ「相手の持ち駒切れ」頼みになってしまう。そこで、安全な手がまだ
  // 残っていても、対局が長引く(=辞書番の手数が増える)ほど少しずつ「ん」で終わる語を
  // うっかり選んでしまう確率を上げる。全難易度共通の仕様(ユーザー要望)。
  const N_MISTAKE_PER_TURN = 0.004; // 辞書番の1手ごとに+0.4%
  const N_MISTAKE_MAX = 0.18;       // 上限18%(対局45手あたりで頭打ち)
  function pickAiMove(kana, strength, aiTurnCount){
    let pool = candidatesFor(kana, usedReadings);
    if(strength === 'easy') pool = pool.filter(EASY_VOCAB);
    else if(strength === 'normal') pool = pool.filter(NORMAL_VOCAB);
    if(pool.length === 0) return null;

    // 語彙が数万〜十万語規模になったため、ここでは概算値(kanaSizeApprox、使用済みを考慮しない
    // O(1)の目安)で高速に見積もる。正確な値が必要な「めちゃ強い」の最終決定は、後段で
    // 有望な上位候補だけに絞ってから使用済みを考慮した正確な探索(minimaxOptions)を行う。
    const scored = pool.map(e => {
      const end = analyzeEnding(e.r);
      const approxOptions = end.isN ? -1 : kanaSizeApprox(end.kana);
      return {e, end, isN: end.isN, approxOptions};
    });

    const safe = scored.filter(s => !s.isN);
    const nEnding = scored.filter(s => s.isN);
    if(safe.length && nEnding.length){
      const mistakeChance = Math.min(N_MISTAKE_MAX, (aiTurnCount || 0) * N_MISTAKE_PER_TURN);
      if(Math.random() < mistakeChance) return weightedPick(nEnding);
    }
    const usable = safe.length ? safe : scored; // 安全な手が無ければ「ん」で終わる手を仕方なく選ぶ(=辞書番の自滅)

    if(strength === 'easy'){
      return weightedPick(usable);
    }
    if(strength === 'normal'){
      usable.sort((a,b) => a.approxOptions - b.approxOptions);
      const mid = usable.slice(0, Math.max(1, Math.ceil(usable.length*0.6)));
      return weightedPick(mid);
    }

    // hard: まず概算値(kanaSizeApprox)で有望な候補に絞り込み、その上位だけを
    // 使用済みを考慮した正確な探索で2〜3手先まで深掘りして最終決定する
    // (合法手すべてを正確に数えてから深く読むと、語彙が大きいときに重すぎるため)。
    // 上位HARD_OUTER_CAP件に加えて、そこに入らなかった著名な語・解説付きの語も
    // 別枠で深掘り対象に加える(でないと数十万語の中でそうした語がそもそも
    // 検討すらされないことがあるため)。
    usable.sort((a,b) => a.approxOptions - b.approxOptions);
    const deepPoolSet = new Set(usable.slice(0, HARD_OUTER_CAP));
    for(const s of usable){
      if(s.e.t === 1 || s.e.d){
        if(deepPoolSet.size - HARD_OUTER_CAP >= HARD_FAMOUS_SHORTLIST) break;
        deepPoolSet.add(s);
      }
    }
    const deepPool = [...deepPoolSet];
    for(const s of deepPool){
      if(s.isN){ s.deepScore = 0; continue; }
      usedReadings.add(s.e.r);
      s.deepScore = minimaxOptions(s.end.kana, usedReadings, HARD_LOOKAHEAD_DEPTH);
      usedReadings.delete(s.e.r);
    }
    deepPool.sort((a,b) => a.deepScore - b.deepScore);
    const bestScore = deepPool[0].deepScore;
    // 最善とほぼ互角(誤差HARD_NEAR_OPTIMAL_MARGIN以内)の手の中から、著名な語を優先しつつ選ぶ。
    const nearBest = deepPool.filter(s => s.deepScore <= bestScore + HARD_NEAR_OPTIMAL_MARGIN);
    return weightedPick(nearBest);
  }

  // 持ち時間の制御はここでは行わない(呼び出し側で意図に応じて
  // startTurnTimer/pauseTurnTimer/resumeTurnTimer/clearTurnTimerを使い分ける)。
  function setBusy(v){
    busy = v;
    const gameOver = active().gameOver;
    inputEl.disabled = v || gameOver;
    submitBtn.disabled = v || gameOver;
  }

  // 制限時間(強さに関わらず一律 TURN_TIME_LIMIT 秒)以内に入力できなかった場合の即負け。
  function handleTimeout(){
    if(busy || active().gameOver) return;
    const conv = active();
    conv.gameOver = true;
    const hint = pickHintWord(conv.requiredKana);
    let note = '制限時間('+TURN_TIME_LIMIT+'秒)以内に言葉を入力できませんでした。';
    if(hint){
      const shown = hint.w === hint.r ? hint.w : (hint.w+'('+hint.r+')');
      note += '<br><span class="hint">ちなみに「'+shown+'」という言葉がありました。</span>';
    }
    updateMedallion();
    renderGameOver('ai', note);
    setBusy(true);
  }

  async function handleSubmit(){
    const conv = active();
    if(busy || conv.gameOver) return;
    const val = inputEl.value.trim();
    if(!val) return;
    inputEl.value = '';
    setBusy(true);
    pauseTurnTimer(); // 判定中は一時停止するだけで、残り時間はリセットしない
    renderThinking('user');
    await new Promise(r => setTimeout(r, 200));
    removeThinking();

    const resolved = resolveUserWord(val);
    if(!resolved){
      renderCard({word: val, invalid:true, reason:'読みが特定できません。ひらがな/カタカナで入力してください', by:'user'});
      setBusy(false); resumeTurnTimer(); return;
    }
    if(conv.requiredKana && !acceptableStartKana(conv.requiredKana).includes(startKana(resolved.reading))){
      const opts = acceptableStartKana(conv.requiredKana).map(k => '「'+k+'」').join('か');
      renderCard({word: resolved.word, invalid:true, reason: opts+'から始まっていません', by:'user'});
      setBusy(false); resumeTurnTimer(); return;
    }
    if(usedReadings.has(resolved.reading)){
      renderCard({word: resolved.word, invalid:true, reason:'その言葉はすでに使われています', by:'user'});
      setBusy(false); resumeTurnTimer(); return;
    }

    usedReadings.add(resolved.reading);
    renderCard({word: resolved.word, reading: resolved.reading, meaning: resolved.meaning, by:'user', requiredWasSet: !!conv.requiredKana});

    // ユーザーの言葉が「ん」で終わっていれば、ここで即負け
    const ending = analyzeEnding(resolved.reading);
    if(ending.isN){
      conv.gameOver = true; updateMedallion();
      renderGameOver('ai', 'あなたの言葉の読みが「ん」で終わりました。');
      setBusy(true); clearTurnTimer(); return;
    }
    conv.requiredKana = ending.kana;
    updateMedallion();

    renderThinking('ai');
    await new Promise(r => setTimeout(r, 1000));
    removeThinking();

    conv.aiTurnCount++;
    const move = pickAiMove(conv.requiredKana, conv.strength, conv.aiTurnCount);
    if(!move){
      const opts = acceptableStartKana(conv.requiredKana).map(k => '「'+k+'」').join('か');
      renderGameOver('user', '辞書番の持ち駒('+opts+'から始まる言葉)が尽きました。');
      conv.gameOver = true; updateMedallion(); setBusy(true); clearTurnTimer(); return;
    }
    usedReadings.add(move.e.r);
    renderCard({word: move.e.w, reading: move.e.r, meaning: entryMeaning(move.e), by:'ai', requiredWasSet:true});

    // 辞書番の言葉が「ん」で終わっていれば、辞書番の即負け
    if(move.isN){
      conv.gameOver = true; updateMedallion();
      renderGameOver('user', '辞書番が読みが「ん」で終わる言葉を選ばざるを得ませんでした。');
      setBusy(true); clearTurnTimer(); return;
    }
    conv.requiredKana = move.end.kana;
    updateMedallion();
    setBusy(false);
    startTurnTimer(); // ここからがあなたの新しい手番なので、持ち時間を60秒に戻す
    inputEl.focus();
  }

  // words-core.tsv(手作業・日本語の意味つき)と words-auto.tsv(自動取得分)を
  // 両方読み込み、読み(reading)が重複する場合は words-core.tsv を優先してマージする。
  // words-auto.tsv は無くても(未生成でも)動くようにする。
  async function loadWords(){
    const [coreRes, autoRes] = await Promise.allSettled([
      fetch('words-core.tsv'),
      fetch('words-auto.tsv'),
    ]);
    const core = coreRes.status === 'fulfilled' && coreRes.value.ok ? parseTSV(await coreRes.value.text()) : [];
    const auto = autoRes.status === 'fulfilled' && autoRes.value.ok ? parseTSV(await autoRes.value.text()) : [];

    const seen = new Set();
    const merged = [];
    for(const e of core){ if(!seen.has(e.r)){ seen.add(e.r); merged.push(e); } }
    for(const e of auto){ if(!seen.has(e.r)){ seen.add(e.r); merged.push(e); } }

    if(core.length === 0 && auto.length === 0) throw new Error('no words loaded');
    return merged;
  }

  async function init(){
    try{
      WORDS = await loadWords();
    }catch(e){
      WORDS = [];
      showToast('辞書データの読み込みに失敗しました(ローカルサーバー経由で開いてください)');
    }
    buildWordIndex();
    renderContactList();
    updateChatHeader();
    updateMedallion();
    renderChainFromHistory(active());
    clearTurnTimer();
    setBusy(false);
  }

  submitBtn.addEventListener('click', handleSubmit);
  // IME変換確定のEnterでも submit してしまわないよう、変換中(isComposing/keyCode 229)は無視する。
  // これにより「変換確定のEnter」と「送信のEnter」が別の操作として扱われる。
  inputEl.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    if(e.isComposing || e.keyCode === 229) return;
    handleSubmit();
  });
  restartAllBtn.addEventListener('click', restartAll);
  backBtn.addEventListener('click', () => showScreen('list'));

  init();
})();
