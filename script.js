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
  const DUEL_CONTACTS = RANKS.map(r => ({
    kind: 'duel',
    id: r.strength + '-' + (r.timerOn ? 'timer' : 'notimer'),
    strength: r.strength,
    timerOn: r.timerOn,
    belt: r.belt,
    beltClass: r.beltClass,
    name: '辞書番【' + r.belt + '】',
  }));

  // ---------------- グループチャット / AI観戦(2つの追加モード) ----------------
  // 1対1の対局(duel)とは別に、複数人が同じ場で1本のしりとりをリレーする
  // 「グループチャット」(自分+AI2体、固定メンバー)と、自分は一切参加せず
  // AI同士の対局を眺めるだけの「観戦」(対戦相手は6段階の帯ランクから毎回
  // 選べる、同じ帯同士の対戦も可)を追加する。どちらも内部的には同じ
  // 「複数参加者が順番に手番を回す」エンジン(participants/order/turnCursor/
  // eliminated)を使う。
  const GROUP_BOTS = [
    { id:'botA', name:'辞書猫', strength:'normal', avatarClass:'bot-a', avatarChar:'猫' },
    { id:'botB', name:'辞書犬', strength:'hard',   avatarClass:'bot-b', avatarChar:'犬' },
  ];
  // 観戦の対戦相手候補。1対1(duel)と同じ6段階の帯ランクをそのまま流用する
  // (持ち時間の有無はAIの強さに影響しないため、強さが同じ帯が2つ実質重複
  // することになるが、「どの帯として観戦したいか」という気分の問題なので
  // あえて6つとも選べるようにしてある)。
  const BELT_FIGHTERS = RANKS.map(r => ({ id: 'belt-' + r.beltClass, belt: r.belt, strength: r.strength, beltClass: r.beltClass }));
  const SPECIAL_CONTACTS = [
    { kind:'group', id:'group', name:'みんなでしりとり', beltClass:'group', avatarChar:'群', bots: GROUP_BOTS },
    { kind:'spectator', id:'spectator', name:'AI同士の観戦', beltClass:'spectator', avatarChar:'観' },
  ];

  const CONTACTS = [...DUEL_CONTACTS, ...SPECIAL_CONTACTS];
  const CONTACTS_BY_ID = new Map(CONTACTS.map(c => [c.id, c]));

  const TURN_TIME_LIMIT = 60; // 秒(強さに関わらず一律)
  function freshConversationState(contact){
    if(contact.kind === 'group'){
      // 自分(user)を必ず先頭にする(=最初の一手はいつも自分から。AIが自由な
      // 一手目を選ぶロジックを別途用意せずに済む)。
      const participants = [{ id:'user', kind:'user', name:'あなた', avatarClass:'user' }];
      for(const b of contact.bots){
        participants.push({ id:b.id, kind:'ai', name:b.name, strength:b.strength, avatarClass:b.avatarClass, avatarChar:b.avatarChar, aiTurnCount:0 });
      }
      return {
        kind: 'group',
        participants,
        order: participants.map(p => p.id), // 固定の巡回順(脱落者はeliminatedで読み飛ばす)
        turnCursor: 0,
        eliminated: new Set(),
        winnerId: null,
        usedReadings: new Set(),
        requiredKana: null,
        gameOver: false,
        cards: [],
      };
    }
    if(contact.kind === 'spectator'){
      // 対戦相手(帯)をまだ選んでいない状態で始まる。started=falseの間は
      // participants/orderが空のままで、ピッカーUIで選ぶとstartSpectatorMatch()
      // が組み立てる。
      return {
        kind: 'spectator',
        participants: [],
        order: [],
        turnCursor: 0,
        eliminated: new Set(),
        winnerId: null,
        usedReadings: new Set(),
        requiredKana: null,
        gameOver: false,
        started: false,
        lastPickA: null, lastPickB: null, // 選び直すときに前回の選択を初期値にする
        autoplayTimer: null, // 観戦モードの自動進行タイマー(会話を離れたら止める)
        cards: [],
      };
    }
    return {
      kind: 'duel',
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
  const SPECIAL_CLASSES = SPECIAL_CONTACTS.map(c => 'special-' + c.beltClass);
  function updateChatHeader(){
    const c = CONTACTS_BY_ID.get(activeId);
    chatNameEl.textContent = c.name;
    // ヘッダーのアバター(medallion)も、選んでいる相手の帯の色(グループ/観戦は専用の色)に合わせる。
    medallion.classList.remove(...BELT_CLASSES, ...SPECIAL_CLASSES);
    medallion.classList.add(c.kind === 'duel' ? 'belt-' + c.beltClass : 'special-' + c.beltClass);
  }
  // medallionLabelは、チャット相手(辞書番)の名前の下にある「オンライン状態」の
  // ようなステータステキストとして表示する(メッセンジャーアプリの見た目に
  // 合わせるため、対局の進行状況をここに集約している)。グループ/観戦では
  // 「誰の番か」も併せて表示する(1対1と違い、次が自分の番とは限らないため)。
  function updateMedallion(){
    const conv = active();
    medallion.classList.remove('multi');
    if(conv.kind === 'spectator' && !conv.started){
      medallion.textContent = '?';
      medallionLabel.textContent = '対戦相手を選んでください';
      return;
    }
    if(conv.gameOver){
      medallion.textContent = '終';
      if(conv.kind === 'duel'){ medallionLabel.textContent = '対局終了'; return; }
      const winner = participantById(conv, conv.winnerId);
      medallionLabel.textContent = winner ? ((winner.kind==='user'?'あなた':winner.name) + 'の勝ち') : '対局終了';
      return;
    }
    if(!conv.requiredKana){ medallion.textContent = '―'; medallionLabel.textContent = '最初のことばへ'; return; }
    const opts = acceptableStartKana(conv.requiredKana);
    if(opts.length > 1){
      medallion.textContent = opts.join('/');
      medallion.classList.add('multi');
    }else{
      medallion.textContent = conv.requiredKana;
    }
    if(conv.kind === 'duel'){
      medallionLabel.textContent = '「' + conv.requiredKana + '」から始めてください';
    }else{
      const turnP = currentParticipant(conv);
      const who = turnP ? (turnP.kind==='user' ? 'あなた' : turnP.name) : '';
      medallionLabel.textContent = '「' + conv.requiredKana + '」から(' + who + 'の番)';
    }
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
  // 「会話に記録する」処理とは分離してある)。by は 'user' か、それ以外は
  // すべて「相手」側(左・白ふきだし)として扱う。グループ/観戦では by に
  // 参加者ID(botA等)を渡すことで、ボットごとの色分け(CSS)も可能にする。
  // senderNameを渡すと、ふきだしの上に発言者名を表示する(グループ/観戦用。
  // 1対1では相手が辞書番だけなので省略する)。
  function buildCardEl({word, reading, meaning, by, invalid, reason, requiredWasSet, senderName}){
    const card = document.createElement('div');
    const isUser = by === 'user';
    const cls = isUser ? 'user' : (by === 'ai' ? 'ai' : 'ai ' + by);
    card.className = 'card ' + cls + (invalid ? ' invalid' : '');
    if(senderName){
      const nameEl = document.createElement('div');
      nameEl.className = 'sender-name';
      nameEl.textContent = senderName;
      card.appendChild(nameEl);
    }
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
  // グループ/観戦用の勝敗表示。参加者が3人以上いる/自分が参加していない
  // 場合もあるため、勝った側の名前をそのまま表示する(win/lose二択ではない)。
  // humanWon: true=自分の勝ち(緑) false=自分が勝てなかった(赤・グループのみ)
  // null=そもそも自分は参加していない(観戦、水色・中立)。
  function buildMultiGameOverEl({winnerName, humanWon, note}){
    const el = document.createElement('div');
    el.className = 'gameover';
    const result = document.createElement('div');
    result.className = 'result ' + (humanWon === true ? 'win' : humanWon === false ? 'lose' : 'neutral');
    result.textContent = winnerName ? (winnerName + 'の勝ち') : '引き分け';
    const p = document.createElement('p');
    p.innerHTML = note;
    el.appendChild(result); el.appendChild(p);
    return el;
  }
  function buildEliminationEl(text){
    const el = document.createElement('div');
    el.className = 'elimination-note';
    el.textContent = text;
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
  // by: 'user'(=受理中) か 'ai'(=考え中)。nameを渡すと「◯◯、考え中」のように
  // 発言者名を出す(グループ/観戦用。省略時は従来通り「辞書番、考え中」)。
  function renderThinking(by, name){
    const el = document.createElement('div');
    el.className = 'thinking-card ' + by;
    el.id = 'thinkingCard';
    const label = by === 'ai' ? (name || '辞書番') + '、考え中' : '受理中';
    el.innerHTML = label + '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    chainEl.appendChild(el); scrollToBottom();
  }
  function removeThinking(){ const el = document.getElementById('thinkingCard'); if(el) el.remove(); }
  function renderGameOver(winner, note){
    active().cards.push({ kind:'gameover', winner, note });
    chainEl.appendChild(buildGameOverEl({winner, note}));
    scrollToBottom();
    renderContactList();
  }
  function renderMultiGameOver(conv, winnerParticipant, note){
    const humanExists = conv.participants.some(p => p.kind === 'user');
    const humanWon = humanExists ? (!!winnerParticipant && winnerParticipant.kind === 'user') : null;
    const data = {
      kind: 'gameover', multi: true,
      winnerId: winnerParticipant ? winnerParticipant.id : null,
      winnerName: winnerParticipant ? (winnerParticipant.kind==='user' ? 'あなた' : winnerParticipant.name) : null,
      humanWon, note,
    };
    conv.cards.push(data);
    chainEl.appendChild(buildMultiGameOverEl(data));
    if(conv.kind === 'spectator') chainEl.appendChild(buildSpectatorSetupEl(conv)); // すぐに選び直せるように
    scrollToBottom();
    renderContactList();
  }
  function renderElimination(conv, text){
    conv.cards.push({ kind:'elimination', text });
    chainEl.appendChild(buildEliminationEl(text));
    scrollToBottom();
    renderContactList();
  }
  // 観戦モードの「対戦相手(帯)を選ぶ」ピッカー。まだ対局を始めていない
  // ときと、1本終わった後(もう一度選び直せるように)の両方で使う。
  function buildSpectatorSetupEl(conv){
    const wrap = document.createElement('div');
    wrap.className = 'spectator-setup';
    const title = document.createElement('div');
    title.className = 'spectator-setup-title';
    title.textContent = conv.gameOver ? 'もう一度、対戦相手を選ぶ' : '対戦相手を選んでください';
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'spectator-setup-row';
    const selA = document.createElement('select');
    const selB = document.createElement('select');
    for(const f of BELT_FIGHTERS){
      const label = f.belt + 'AI(' + STRENGTH_LABELS[f.strength] + ')';
      const optA = document.createElement('option'); optA.value = f.id; optA.textContent = label;
      selA.appendChild(optA);
      const optB = document.createElement('option'); optB.value = f.id; optB.textContent = label;
      selB.appendChild(optB);
    }
    selA.value = conv.lastPickA || BELT_FIGHTERS[0].id;
    selB.value = conv.lastPickB || BELT_FIGHTERS[BELT_FIGHTERS.length - 1].id;
    const vs = document.createElement('span');
    vs.className = 'spectator-setup-vs';
    vs.textContent = 'VS';
    row.appendChild(selA); row.appendChild(vs); row.appendChild(selB);
    wrap.appendChild(row);

    const note = document.createElement('div');
    note.className = 'spectator-setup-note';
    note.textContent = '同じ帯同士の対戦もできます。';
    wrap.appendChild(note);

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'spectator-setup-start';
    startBtn.textContent = 'この対局を見る';
    startBtn.addEventListener('click', () => startSpectatorMatch(conv, selA.value, selB.value));
    wrap.appendChild(startBtn);
    return wrap;
  }
  // 選ばれた2つの帯からAI2体を組み立て、観戦の会話を一から始める。
  // ボタンは会話を見ている間しか押せないので、activeId=conv自身のIDとして
  // 良い(usedReadingsショートカットの張り替えなどをそのまま行える)。
  function startSpectatorMatch(conv, idA, idB){
    const defA = BELT_FIGHTERS.find(f => f.id === idA) || BELT_FIGHTERS[0];
    const defB = BELT_FIGHTERS.find(f => f.id === idB) || BELT_FIGHTERS[BELT_FIGHTERS.length - 1];
    conv.lastPickA = defA.id; conv.lastPickB = defB.id;
    const pA = { id:'fighterA', kind:'ai', name: defA.belt + 'AI(先手)', strength: defA.strength, beltClass: defA.beltClass, aiTurnCount:0 };
    const pB = { id:'fighterB', kind:'ai', name: defB.belt + 'AI(後手)', strength: defB.strength, beltClass: defB.beltClass, aiTurnCount:0 };
    conv.participants = [pA, pB];
    conv.order = ['fighterA', 'fighterB'];
    conv.turnCursor = 0;
    conv.eliminated = new Set();
    conv.winnerId = null;
    conv.usedReadings = new Set();
    conv.requiredKana = null;
    conv.gameOver = false;
    conv.cards = [];
    conv.started = true;
    usedReadings = conv.usedReadings; // アクティブな会話のショートカット参照を新しいSetに張り替える
    renderChainFromHistory(conv);
    updateMedallion();
    renderContactList();
    scheduleSpectatorStep(activeId);
  }
  // 会話を切り替えたとき、保存しておいた履歴からチャットログを丸ごと再構築する。
  function renderChainFromHistory(conv){
    chainEl.innerHTML = '';
    if(conv.kind === 'spectator' && !conv.started){
      chainEl.appendChild(buildSpectatorSetupEl(conv));
      return;
    }
    if(conv.cards.length === 0){
      const hint = conv.kind === 'group'
        ? '<div class="kanban-mini">— 対局開始 —</div>ひらがな・カタカナで、ことばを入力してください。自分の番になると入力欄が使えます。<br>読みが「ん」で終わったら、その場で脱落です。'
        : '<div class="kanban-mini">— 対局開始 —</div>ひらがな・カタカナで、ことばを入力してください。<br>読みが「ん」で終わったら、その場で負けです。';
      chainEl.innerHTML = '<div class="empty-hint" id="emptyHint">' + hint + '</div>';
      return;
    }
    for(const item of conv.cards){
      let el;
      if(item.kind === 'card') el = buildCardEl(item);
      else if(item.kind === 'elimination') el = buildEliminationEl(item.text);
      else el = item.multi ? buildMultiGameOverEl(item) : buildGameOverEl(item);
      chainEl.appendChild(el);
    }
    if(conv.kind === 'spectator' && conv.gameOver) chainEl.appendChild(buildSpectatorSetupEl(conv));
    scrollToBottom();
  }

  // ---------------- 連絡先(トーク)一覧 ----------------
  function contactPreview(conv){
    if(conv.kind === 'spectator' && !conv.started) return '対戦相手を選んでください';
    for(let i = conv.cards.length - 1; i >= 0; i--){
      const item = conv.cards[i];
      if(item.kind === 'gameover'){
        if(item.multi) return item.winnerName ? (item.winnerName + 'の勝ち') : '引き分け';
        return item.winner === 'user' ? 'あなたの勝ち' : '辞書番の勝ち';
      }
      if(item.kind === 'card' && !item.invalid){
        const label = item.by === 'user' ? 'あなた' : (item.senderName || '辞書番');
        return label + ': ' + item.word;
      }
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
      avatar.className = 'contact-avatar ' + (c.kind === 'duel' ? 'belt-' + c.beltClass : 'special-' + c.beltClass);
      avatar.textContent = c.kind === 'duel' ? '辞' : c.avatarChar;

      const info = document.createElement('div');
      info.className = 'contact-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'contact-name-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'contact-name';
      nameEl.textContent = c.name;
      const badge = document.createElement('span');
      badge.className = 'contact-badge';
      badge.textContent = c.kind === 'duel' ? STRENGTH_LABELS[c.strength] : (c.kind === 'group' ? '3人' : '観戦');
      nameRow.appendChild(nameEl); nameRow.appendChild(badge);

      const meta = document.createElement('div');
      meta.className = 'contact-meta';
      meta.textContent = c.kind === 'duel'
        ? (c.timerOn ? '持ち時間60秒' : '持ち時間なし')
        : (c.kind === 'group' ? 'あなた + AI2体' : 'AI2体の対局を観戦');

      const preview = document.createElement('div');
      preview.className = 'contact-preview';
      preview.textContent = contactPreview(conv);

      info.appendChild(nameRow); info.appendChild(meta); info.appendChild(preview);
      row.appendChild(avatar); row.appendChild(info);
      row.addEventListener('click', () => selectContact(c.id));
      contactsEl.appendChild(row);
    }
  }
  // 観戦(AI同士)は会話を離れている間、自動進行を止める(戻ってきたときに
  // resumeSpectatorIfNeededで再開する)。停止済みのタイマーを二重にクリアしても
  // 害は無いので、離れる会話がobservationか気にせず毎回呼んでよい。
  function pauseSpectatorAutoplay(conv){
    if(conv.autoplayTimer){ clearTimeout(conv.autoplayTimer); conv.autoplayTimer = null; }
  }
  function resumeSpectatorIfNeeded(id, conv){
    // startedがfalse(まだ対戦相手を選んでいない)ときは自動進行しない
    // (ピッカーUIでの選択・「この対局を見る」を待つ)。
    if(conv.kind === 'spectator' && conv.started && !conv.gameOver) scheduleSpectatorStep(id);
  }
  function selectContact(id){
    if(busy) return; // ターン処理中の切り替えは禁止(処理中の会話が宙に浮くのを避ける)
    if(id !== activeId){
      pauseTurnTimer();
      const leaving = active();
      leaving.turnRemaining = turnRemaining; // 現在の残り時間を出て行く会話側に保存
      pauseSpectatorAutoplay(leaving);

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
      resumeSpectatorIfNeeded(id, conv);
    }
    showScreen('chat');
    inputEl.focus();
  }
  function restartAll(){
    if(busy) return;
    pauseTurnTimer();
    for(const conv of conversations.values()) pauseSpectatorAutoplay(conv);
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
    resumeSpectatorIfNeeded(activeId, conv);
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

  // requiredKanaがまだ無い「自由な一手目」をAIが打つ場合の手選び(グループ/観戦で、
  // 巡回順の先頭がAIになりうる観戦モード用)。1手目は先読みするような危険が無いので
  // pickAiMoveの複雑な分岐は使わず、語彙(強さ)フィルタ+重み付き抽選だけで選ぶ。
  function pickAiOpeningMove(strength){
    let pool = WORDS.filter(e => !usedReadings.has(e.r));
    if(strength === 'easy') pool = pool.filter(EASY_VOCAB);
    else if(strength === 'normal') pool = pool.filter(NORMAL_VOCAB);
    if(pool.length === 0) return null;
    const scored = pool.map(e => {
      const end = analyzeEnding(e.r);
      return { e, end, isN: end.isN };
    });
    const safe = scored.filter(s => !s.isN);
    return weightedPick(safe.length ? safe : scored);
  }

  // ---------------- グループチャット/観戦の共通エンジン ----------------
  // 参加者(2人以上)が固定の順番で手番を回し、「ん」で終わった・持ち駒が尽きた
  // 参加者はその場で脱落、最後の1人が残るまで続ける。1対1(duel)は従来通り
  // 専用のhandleSubmitで扱うため、ここは触らない。
  function participantById(conv, id){
    return conv.participants.find(p => p.id === id);
  }
  function currentParticipant(conv){
    return participantById(conv, conv.order[conv.turnCursor]);
  }
  function advanceTurn(conv){
    const n = conv.order.length;
    for(let i = 0; i < n; i++){
      conv.turnCursor = (conv.turnCursor + 1) % n;
      if(!conv.eliminated.has(conv.order[conv.turnCursor])) return;
    }
  }
  function eliminateParticipant(conv, participant){
    conv.eliminated.add(participant.id);
    const remaining = conv.participants.filter(p => !conv.eliminated.has(p.id));
    if(remaining.length <= 1){
      conv.gameOver = true;
      conv.winnerId = remaining[0] ? remaining[0].id : null;
    }
  }
  // 脱落が出た直後の共通処理: それで決着が付けば勝敗カードを、まだ複数人
  // 残っていれば「脱落しました」の小さな通知カードを出して手番を進める。
  function finishMultiTurnAfterElimination(conv, reasonText){
    if(conv.gameOver){
      renderMultiGameOver(conv, participantById(conv, conv.winnerId), reasonText);
    }else{
      renderElimination(conv, reasonText);
      advanceTurn(conv);
    }
  }
  // resolved({word,reading,meaning})を参加者participantの一手として場に適用する。
  // 人間の入力・AIの手のどちらから呼んでも同じ脱落/進行ロジックを通る。
  function applyMultiMove(conv, participant, resolved){
    usedReadings.add(resolved.reading);
    const who = participant.kind === 'user' ? 'あなた' : participant.name;
    renderCard({
      word: resolved.word, reading: resolved.reading, meaning: resolved.meaning,
      by: participant.id, senderName: participant.kind === 'user' ? null : participant.name,
      requiredWasSet: !!conv.requiredKana,
    });
    const ending = analyzeEnding(resolved.reading);
    if(ending.isN){
      eliminateParticipant(conv, participant);
      finishMultiTurnAfterElimination(conv, who + 'の言葉の読みが「ん」で終わりました。');
      return;
    }
    conv.requiredKana = ending.kana;
    advanceTurn(conv);
  }
  // AI参加者1人分の手番をまるごと処理する(考え中表示→手を選ぶ→反映)。
  async function runOneAiTurn(conv, participant){
    renderThinking('ai', participant.name);
    await new Promise(r => setTimeout(r, 900));
    removeThinking();
    participant.aiTurnCount = (participant.aiTurnCount || 0) + 1;
    const move = conv.requiredKana
      ? pickAiMove(conv.requiredKana, participant.strength, participant.aiTurnCount)
      : pickAiOpeningMove(participant.strength);
    if(!move){
      eliminateParticipant(conv, participant);
      finishMultiTurnAfterElimination(conv, participant.name + 'の持ち駒が尽きました。');
      return;
    }
    usedReadings.add(move.e.r);
    applyMultiMove(conv, participant, { word: move.e.w, reading: move.e.r, meaning: entryMeaning(move.e) });
  }
  // 自分の手番が終わった後、次がAIの間は自動で打たせ続け、自分の番が
  // 回ってくる(か対局が終わる)まで待つ(グループチャット用)。
  async function continueGroupLoop(conv){
    while(!conv.gameOver){
      const p = currentParticipant(conv);
      if(!p || p.kind === 'user') break;
      await runOneAiTurn(conv, p);
      updateMedallion();
    }
  }
  async function handleGroupSubmit(){
    const conv = active();
    if(conv.kind !== 'group' || busy || conv.gameOver) return;
    const participant = currentParticipant(conv);
    if(!participant || participant.kind !== 'user') return; // 自分の番でなければ何もしない(念のため)
    const val = inputEl.value.trim();
    if(!val) return;
    inputEl.value = '';
    setBusy(true);
    renderThinking('user');
    await new Promise(r => setTimeout(r, 200));
    removeThinking();

    const resolved = resolveUserWord(val);
    if(!resolved){
      renderCard({word: val, invalid:true, reason:'読みが特定できません。ひらがな/カタカナで入力してください', by:'user'});
      setBusy(false); return;
    }
    if(conv.requiredKana && !acceptableStartKana(conv.requiredKana).includes(startKana(resolved.reading))){
      const opts = acceptableStartKana(conv.requiredKana).map(k => '「'+k+'」').join('か');
      renderCard({word: resolved.word, invalid:true, reason: opts+'から始まっていません', by:'user'});
      setBusy(false); return;
    }
    if(usedReadings.has(resolved.reading)){
      renderCard({word: resolved.word, invalid:true, reason:'その言葉はすでに使われています', by:'user'});
      setBusy(false); return;
    }

    applyMultiMove(conv, participant, resolved);
    updateMedallion();
    if(!conv.gameOver) await continueGroupLoop(conv);
    updateMedallion();
    setBusy(false);
    if(!conv.gameOver) inputEl.focus();
  }

  // 観戦モード: 自分の入力を待たず、一定間隔で自動的にAI同士の手番を進め続ける。
  // このタブを見ている間だけ進行し、離れたら止まる(selectContact側でpause/resume)。
  function scheduleSpectatorStep(id){
    const conv = conversations.get(id);
    if(!conv || !conv.started || conv.gameOver) return;
    pauseSpectatorAutoplay(conv);
    conv.autoplayTimer = setTimeout(() => runSpectatorStep(id), 700);
  }
  async function runSpectatorStep(id){
    if(activeId !== id) return; // その間に別のトークへ移動していたら何もしない
    const conv = conversations.get(id);
    if(!conv || !conv.started || conv.gameOver) return;
    setBusy(true);
    const p = currentParticipant(conv);
    await runOneAiTurn(conv, p);
    updateMedallion();
    setBusy(false);
    if(activeId === id && !conv.gameOver) scheduleSpectatorStep(id);
  }

  // 持ち時間の制御はここでは行わない(呼び出し側で意図に応じて
  // startTurnTimer/pauseTurnTimer/resumeTurnTimer/clearTurnTimerを使い分ける)。
  // グループチャットでは自分の番のときだけ、観戦では常に入力欄を無効にする。
  function setBusy(v){
    busy = v;
    const conv = active();
    const gameOver = conv.gameOver;
    let humanTurn = true;
    if(conv.kind === 'group') humanTurn = !!currentParticipant(conv) && currentParticipant(conv).kind === 'user';
    else if(conv.kind === 'spectator') humanTurn = false;
    const disabled = v || gameOver || !humanTurn;
    inputEl.disabled = disabled;
    submitBtn.disabled = disabled;
    inputEl.placeholder = conv.kind === 'spectator'
      ? (conv.started ? 'AI同士が対局中です(観戦専用)' : '対戦相手を選んでください(観戦専用)')
      : (conv.kind === 'group' && !gameOver && !humanTurn ? (currentParticipant(conv).name + 'の番です…') : 'ことばを入力…');
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
    setBusy(false); // gameOver自体がinputを無効化するので、busyは戻して他トークへの移動を可能にする
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
      setBusy(false); clearTurnTimer(); return; // gameOver自体がinputを無効化するので、busyは戻して他トークへの移動を可能にする
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
      conv.gameOver = true; updateMedallion(); setBusy(false); clearTurnTimer(); return;
    }
    usedReadings.add(move.e.r);
    renderCard({word: move.e.w, reading: move.e.r, meaning: entryMeaning(move.e), by:'ai', requiredWasSet:true});

    // 辞書番の言葉が「ん」で終わっていれば、辞書番の即負け
    if(move.isN){
      conv.gameOver = true; updateMedallion();
      renderGameOver('user', '辞書番が読みが「ん」で終わる言葉を選ばざるを得ませんでした。');
      setBusy(false); clearTurnTimer(); return;
    }
    conv.requiredKana = move.end.kana;
    updateMedallion();
    setBusy(false);
    startTurnTimer(); // ここからがあなたの新しい手番なので、持ち時間を60秒に戻す
    inputEl.focus();
  }
  // 送信ボタン/Enterの実処理を、今アクティブな会話の種類ごとに振り分ける。
  function handleSubmitDispatch(){
    const conv = active();
    if(conv.kind === 'group') return handleGroupSubmit();
    if(conv.kind === 'spectator') return; // 観戦モードは入力欄自体が常に無効(念のためのガード)
    return handleSubmit();
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
    resumeSpectatorIfNeeded(activeId, active());
  }

  submitBtn.addEventListener('click', handleSubmitDispatch);
  // IME変換確定のEnterでも submit してしまわないよう、変換中(isComposing/keyCode 229)は無視する。
  // これにより「変換確定のEnter」と「送信のEnter」が別の操作として扱われる。
  inputEl.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    if(e.isComposing || e.keyCode === 229) return;
    handleSubmitDispatch();
  });
  restartAllBtn.addEventListener('click', restartAll);
  backBtn.addEventListener('click', () => showScreen('list'));

  init();
})();
