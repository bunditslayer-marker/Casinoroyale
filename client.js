// Black Tie Poker — what runs in each player's browser.
// It only draws the table and sends your choices; the server deals and checks the rules.

(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CROWN = '<svg class="crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18.5h18L19.6 7.8l-4.8 4.1L12 5.5l-2.8 6.4-4.8-4.1z" fill="currentColor"/><rect x="3" y="19.8" width="18" height="1.8" rx=".9" fill="currentColor"/></svg>';

  // The founder's crown: gold with a ruby, a sapphire, an emerald and pearl tips.
  const FOUNDER_CROWN = `<svg class="crown founder-crown" viewBox="0 0 32 24" aria-hidden="true">
    <path d="M4.2 18.2 2.2 6.6l7.4 5.3L16 2.6l6.4 9.3 7.4-5.3-2 11.6z" fill="url(#goldGrad)" stroke="#6f4e17" stroke-width=".7" stroke-linejoin="round"/>
    <rect x="4" y="18.6" width="24" height="3.6" rx="1.2" fill="url(#goldGrad)" stroke="#6f4e17" stroke-width=".7"/>
    <circle cx="2.2" cy="6.2" r="1.7" fill="#fff8e7"/><circle cx="16" cy="2.2" r="1.9" fill="#fff8e7"/><circle cx="29.8" cy="6.2" r="1.7" fill="#fff8e7"/>
    <ellipse cx="16" cy="13.2" rx="2.3" ry="2.7" fill="#c2142c" stroke="#ffe9a6" stroke-width=".6"/>
    <circle cx="9.8" cy="15" r="1.35" fill="#2366d1" stroke="#ffe9a6" stroke-width=".4"/>
    <circle cx="22.2" cy="15" r="1.35" fill="#169457" stroke="#ffe9a6" stroke-width=".4"/>
    <circle cx="10" cy="20.4" r=".8" fill="#c2142c"/><circle cx="16" cy="20.4" r=".8" fill="#fff8e7"/><circle cx="22" cy="20.4" r=".8" fill="#c2142c"/>
  </svg>`;

  // ---------- table colours ----------

  const FELTS = [
    ['#0f4a37', 'Bottle green'], ['#163f73', 'Royal blue'], ['#7a1622', 'Casino red'],
    ['#3e2061', 'Purple'], ['#0d4f57', 'Teal'], ['#1c2230', 'Midnight'],
  ];
  const ROOMS = [
    ['#2b0f15', 'Oxblood'], ['#0f1a2e', 'Navy'], ['#1d1d1f', 'Charcoal'],
    ['#0f2418', 'Forest'], ['#24122b', 'Plum'], ['#2a2116', 'Walnut'],
  ];

  // Mix a colour toward white (amt > 0) or black (amt < 0).
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const t = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    const mix = (c) => Math.round(c + (t - c) * p);
    const [r, g, b] = [mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)];
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  let themeKey = '';
  function applyTheme(felt, room) {
    const key = felt + room;
    if (key === themeKey) return;
    themeKey = key;
    const root = document.documentElement.style;
    if (!felt) {
      for (const v of ['--felt', '--felt-hi', '--velvet', '--velvet-glow', '--velvet-2', '--plate']) root.removeProperty(v);
      document.querySelector('meta[name=theme-color]').content = '#2b0f15';
      return;
    }
    root.setProperty('--felt', felt);
    root.setProperty('--felt-hi', shade(felt, 0.13));
    root.setProperty('--velvet', room);
    root.setProperty('--velvet-glow', shade(room, 0.07));
    root.setProperty('--velvet-2', shade(room, 0.08));
    root.setProperty('--plate', shade(room, -0.5) + 'e6');
    document.querySelector('meta[name=theme-color]').content = room;
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const tokenKey = (code) => `btp-token-${code}`;

  let state = null;
  let myCode = null;
  let lastLogId = 0;
  let boardSeen = 0;
  let boardHand = 0;
  let deadline = null;
  let lastTurnKey = '';
  let actionsKey = '';
  let raise = null; // { value } while the raise panel is open
  let soundOn = store.get('btp-sound') !== 'off';

  // ---------- sending ----------

  function send(event, data = {}) {
    return new Promise((resolve) => {
      if (!socket.connected) { toast('Reconnecting… try again in a second.'); return resolve({ ok: false }); }
      socket.timeout(8000).emit(event, data, (err, res) => {
        if (err) { toast('No answer from the table. Check your connection.'); return resolve({ ok: false }); }
        if (!res.ok && res.error && !res.needCode) toast(res.error);
        resolve(res);
      });
    });
  }

  // ---------- home screen ----------

  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('t') || '').toUpperCase().slice(0, 4);
  $('#nameInput').value = store.get('btp-name') || '';
  if (urlCode) {
    $('#codeInput').value = urlCode;
    document.body.classList.add('invited');
  }

  function readName() {
    const name = $('#nameInput').value.trim();
    if (!name) { $('#nameInput').focus(); toast('Type your name first.'); return null; }
    store.set('btp-name', name);
    return name;
  }

  $('#createBtn').addEventListener('click', async () => {
    const name = readName();
    if (!name) return;
    unlockAudio();
    const settings = readSettings('opt');
    if (!settings) return;
    await enter('create', { name, settings });
  });

  $('#homeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = readName();
    if (!name) return;
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 4) { $('#codeInput').focus(); toast('Table codes are 4 letters.'); return; }
    unlockAudio();
    await enter('join', { code, name, token: store.get(tokenKey(code)) });
  });

  // ---------- reserved name: the secret code ----------

  let pendingEntry = null;
  async function enter(event, payload, typedCode) {
    const saved = store.get('btp-owner');
    const ownerCode = typedCode || saved || undefined;
    const res = await send(event, { ...payload, ownerCode });
    if (res.ok) {
      if (typedCode && $('#ownerRemember').checked) store.set('btp-owner', typedCode);
      if ($('#codeSheet').open) $('#codeSheet').close();
      return res;
    }
    if (res.needCode) {
      if (!typedCode && saved) store.del('btp-owner'); // the saved code stopped working
      pendingEntry = { event, payload };
      $('#codeErr').textContent = typedCode ? res.error : '';
      if (!$('#codeSheet').open) { $('#ownerInput').value = ''; $('#codeSheet').showModal(); }
      $('#ownerInput').select();
    }
    return res;
  }
  $('#codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#ownerInput').value;
    if (!code || !pendingEntry) return;
    await enter(pendingEntry.event, pendingEntry.payload, code);
  });
  $('#ownerInput').addEventListener('input', () => { $('#codeErr').textContent = ''; });
  $('#codeBack').addEventListener('click', () => {
    $('#codeSheet').close();
    $('#nameInput').select();
  });

  // Reads blinds, ante, chips and timer from the home options (opt) or admin settings (set).
  function readSettings(prefix) {
    const num = (id) => Math.floor(Number($(`#${prefix}${id}`).value));
    const sb = num('SB');
    const bb = num('BB');
    const ante = num('Ante') || 0;
    const chips = num('Chips');
    if (!(bb >= 1) || !(sb >= 1)) { toast('Blinds need to be at least 1.'); return null; }
    if (sb > bb) { toast("The small blind can't be bigger than the big blind."); return null; }
    if (ante < 0 || ante > bb) { toast('The ante can be from 0 up to the big blind.'); return null; }
    if (!(chips >= bb * 2)) { toast(`Starting chips need to be at least ${bb * 2} (two big blinds).`); return null; }
    return { smallBlind: sb, bigBlind: bb, ante, startingChips: chips, turnSeconds: +$(`#${prefix}Timer`).value };
  }

  // Quick blind buttons like 1/2 fill in the small and big blind.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.quick [data-blinds]');
    if (!b) return;
    const prefix = b.closest('.quick').dataset.for;
    const [sb, bb] = b.dataset.blinds.split('/');
    $(`#${prefix}SB`).value = sb;
    $(`#${prefix}BB`).value = bb;
    const ante = $(`#${prefix}Ante`);
    if (+ante.value > +bb) ante.value = bb;
    markQuick(prefix);
  });
  function markQuick(prefix) {
    const val = `${$(`#${prefix}SB`).value}/${$(`#${prefix}BB`).value}`;
    for (const b of document.querySelectorAll(`.quick[data-for=${prefix}] [data-blinds]`)) b.setAttribute('aria-pressed', String(b.dataset.blinds === val));
  }
  for (const prefix of ['opt', 'set']) {
    for (const id of ['SB', 'BB']) $(`#${prefix}${id}`).addEventListener('input', () => markQuick(prefix));
  }
  markQuick('opt');

  function showHome(message) {
    myCode = null;
    state = null;
    applyTheme(null);
    $('#game').hidden = true;
    $('#home').hidden = false;
    document.title = 'Black Tie Poker';
    history.replaceState(null, '', location.pathname);
    document.body.classList.remove('invited');
    if (message) toast(message);
  }

  // ---------- connection ----------

  socket.on('joined', ({ code, token }) => {
    myCode = code;
    store.set(tokenKey(code), token);
    history.replaceState(null, '', `?t=${code}`);
    $('#home').hidden = true;
    $('#game').hidden = false;
    lastLogId = 0;
  });

  socket.on('state', (s) => {
    if (!myCode || s.code !== myCode) return;
    if (!s.seats.some((p) => p && p.id === s.you)) return showHome('You left the table.');
    state = s;
    deadline = s.turnEndsIn != null ? Date.now() + s.turnEndsIn : null;
    render();
  });

  // Rejoin automatically after a refresh or a dropped connection.
  socket.on('connect', () => {
    const code = myCode || urlCode;
    const token = code && store.get(tokenKey(code));
    if (!code || !token) return;
    socket.emit('join', { code, token, name: store.get('btp-name') || 'Player' }, (res) => {
      if (res && !res.ok) {
        store.del(tokenKey(code));
        if (myCode) showHome('That table has closed. Start a new one?');
      }
    });
  });
  socket.on('disconnect', () => { if (myCode) toast('Connection lost. Reconnecting…'); });

  // ---------- drawing the table ----------

  const SUITS = { s: ['♠', 'spades'], h: ['♥', 'hearts'], d: ['♦', 'diamonds'], c: ['♣', 'clubs'] };
  const RANK = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

  function card(c, cls = '') {
    if (!c) return `<div class="card slot ${cls}" aria-hidden="true"></div>`;
    if (c === '??') return `<div class="card back ${cls}" aria-label="Face-down card"></div>`;
    const rank = RANK[c[0]] || c[0];
    const [sym, name] = SUITS[c[1]];
    const red = c[1] === 'h' || c[1] === 'd' ? 'red' : '';
    return `<div class="card ${red} ${cls}" role="img" aria-label="${rank} of ${name}"><span class="r">${rank}</span><span class="s">${sym}</span></div>`;
  }

  function seatsInOrder(s, me) {
    const mine = me ? me.seat : 0;
    return s.seats.filter(Boolean).sort((a, b) => ((a.seat - mine + 8) % 8) - ((b.seat - mine + 8) % 8));
  }

  function render() {
    const s = state;
    const me = s.seats.find((p) => p && p.id === s.you);
    const isHost = s.hostId === s.you;

    if (!$('#settingsSheet').open) applyTheme(s.settings.felt, s.settings.room);
    $('#codeText').textContent = s.code;
    $('#adminBtn').hidden = !isHost;
    $('#blindsText').innerHTML =
      `<span>Blinds ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}</span>` +
      `<span>${[s.handNumber ? `Hand ${s.handNumber}` : '', s.settings.ante ? `ante ${fmt(s.settings.ante)}` : ''].filter(Boolean).join(', ').replace(/^a/, 'A')}</span>`;

    renderTable(s, me);
    renderMe(s, me);
    renderActions(s, me, isHost);
    renderMenu(s, me, isHost);
    handleLog(s);
    handleTurn(s, me);
    tick();
  }

  function renderTable(s, me) {
    const area = $('#tableArea');
    const wide = area.clientWidth > area.clientHeight * 1.05;
    const rx = wide ? 44 : 39;
    const ry = wide ? 39 : 43;
    const players = seatsInOrder(s, me);
    const n = players.length;
    const winners = new Map((s.results ? s.results.winners : []).map((w) => [w.id, w]));
    const winCards = new Set(s.results && !s.results.uncontested && s.results.winners[0] ? s.results.winners[0].cards : []);
    const showdown = winCards.size > 0;

    let html = '';
    players.forEach((p, k) => {
      const th = Math.PI / 2 + (k * 2 * Math.PI) / n;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const x = 50 + rx * cos;
      const y = 50 + ry * sin;
      const isMe = p.id === s.you;
      const acting = s.toAct === p.seat && ['preflop', 'flop', 'turn', 'river'].includes(s.stage);
      const cls = [
        'seat', isMe && 'is-me', s.hostId === p.id && 'admin', p.founder && 'founder', acting && 'acting', p.folded && 'folded',
        (!p.inHand && (p.sittingOut || p.chips === 0)) && 'out', winners.has(p.id) && 'winner', cos > 0.3 && 'right',
      ].filter(Boolean).join(' ');

      let tag = '';
      if (winners.has(p.id)) tag = `<span class="tag won">Wins ${fmt(winners.get(p.id).amount)}</span>`;
      else if (p.handName && !p.folded && !isMe) tag = `<span class="tag hand">${esc(p.handName)}</span>`;
      else if (!p.connected) tag = `<span class="tag">Away</span>`;
      else if (p.lastAction) tag = `<span class="tag ${p.allIn ? 'allin' : ''}">${esc(p.lastAction)}</span>`;
      else if (p.sittingOut) tag = `<span class="tag">Sitting out</span>`;
      else if (p.chips === 0 && !p.inHand) tag = `<span class="tag">Out of chips</span>`;
      if (winners.has(p.id) && p.handName && !isMe) tag += `<span class="tag hand">${esc(p.handName)}</span>`;

      const hole = !isMe && p.cards
        ? `<div class="hole">${p.cards.map((c) => card(c, 'mini' + (showdown && c !== '??' ? (winCards.has(c) ? ' win' : '') : ''))).join('')}</div>`
        : '';

      html += `<div class="${cls}" style="left:${x}%;top:${y}%">
        ${hole}
        <div class="plate">
          ${p.seat === s.dealerSeat && s.handNumber > 0 ? '<span class="dealer" aria-label="Dealer">D</span>' : ''}
          ${p.founder ? '<span class="shine" aria-hidden="true"></span>' : ''}
          <div class="nm">${p.founder
            ? `<span class="founder-mark" title="Founder" aria-label="Founder">${FOUNDER_CROWN}</span>`
            : s.hostId === p.id ? `<span class="admin-mark" title="Admin" aria-label="Admin">${CROWN}</span>` : ''}<span class="nm-text">${esc(p.name)}</span></div>
          <div class="ch">${fmt(p.chips)}</div>
          ${acting ? '<div class="timer"><i></i></div>' : ''}
        </div>
        ${tag}
      </div>`;

      if (p.bet > 0) {
        html += `<div class="bet" style="left:${50 + rx * 0.6 * cos}%;top:${50 + ry * 0.56 * sin}%"><span class="chip"></span>${fmt(p.bet)}</div>`;
      }
    });
    $('#seats').innerHTML = html;

    // Centre of the felt: board, pot, result — or the invite code while waiting.
    if (!s.started) {
      $('#center').innerHTML = `<div class="waiting-note">
        <p>Table code</p>
        <div class="big-code">${esc(s.code)}</div>
        <p>${n === 1 ? 'Invite friends to sit down' : `${n} players seated`}</p>
      </div>`;
      return;
    }

    if (s.handNumber !== boardHand || s.community.length < boardSeen) { boardHand = s.handNumber; boardSeen = 0; }
    let board = '';
    for (let i = 0; i < 5; i++) {
      const c = s.community[i];
      let cls = '';
      if (c && i >= boardSeen) cls += ' deal';
      if (c && showdown) cls += winCards.has(c) ? ' win' : ' dim';
      board += c ? card(c, cls).replace('class="card', `style="animation-delay:${(i - boardSeen) * 90}ms" class="card`) : card(null);
    }
    boardSeen = s.community.length;

    let banner = '';
    if (s.results) {
      const ws = s.results.winners;
      const who = ws.length === 1
        ? `${esc(ws[0].name)} wins ${fmt(ws[0].amount)}`
        : `${ws.map((w) => esc(w.name)).join(' and ')} split the pot`;
      const how = s.results.uncontested ? 'Everyone else folded' : esc(s.results.pots[0].handName || '');
      banner = `<div class="who">${who}</div><div class="how">${how}</div>`;
    } else if (s.stage === 'waiting') {
      banner = `<div class="how">Waiting for at least 2 players with chips</div>`;
    }

    $('#center').innerHTML = `
      <div class="board">${board}</div>
      <div class="pot">${s.pot > 0 ? `<span class="amt">${fmt(s.pot)}</span><span class="lbl">Pot</span>` : ''}</div>
      <div class="banner">${banner}</div>`;
  }

  function renderMe(s, me) {
    const el = $('#mePanel');
    el.className = 'me';
    if (!me) { el.innerHTML = ''; return; }
    const pills = [
      me.founder ? `<span class="founder-pill">${FOUNDER_CROWN}<span>Founder</span></span>` : '',
      s.hostId === s.you ? `<span class="admin-pill">${CROWN}<span>Admin</span></span>` : '',
    ].filter(Boolean);
    const pill = pills.length ? `<div class="pills">${pills.join('')}</div>` : '';
    if (me.cards && me.cards.length) {
      const winCards = new Set(s.results && !s.results.uncontested && s.results.winners[0] ? s.results.winners[0].cards : []);
      if (me.folded) el.classList.add('folded');
      const sub = me.folded ? 'You folded' : me.allIn ? `All-in, ${fmt(me.chips)} behind` : `${fmt(me.chips)} chips`;
      el.innerHTML = `<div class="cards">${me.cards.map((c) => card(c, 'big' + (winCards.has(c) ? ' win' : ''))).join('')}</div>
        <div class="info">${pill}<div class="hand-name">${esc(s.yourHand || '')}</div><div class="sub">${sub}</div></div>`;
      return;
    }
    let text = `${fmt(me.chips)} chips`;
    let sub = '';
    if (!s.started) sub = s.hostId === s.you ? 'Start the game when everyone has sat down.' : 'The admin will start the game.';
    else if (me.chips === 0) sub = "You're out of chips.";
    else if (me.sittingOut) sub = "You're sitting out.";
    else sub = "You'll be dealt in next hand.";
    el.innerHTML = `<div class="info centered">${pill}<div class="hand-name">${text}</div><div class="sub">${sub}</div></div>`;
  }

  function renderActions(s, me, isHost) {
    const el = $('#actions');
    const a = s.actions;
    const key = JSON.stringify([a, s.stage, s.started, isHost, me && me.sittingOut, s.canRebuy, s.toAct, s.seats.filter(Boolean).length, !!raise]);
    if (key === actionsKey) return;
    actionsKey = key;
    if (!a) raise = null;

    if (a && raise) return drawRaise(s, a);

    if (a) {
      const callLabel = a.canCheck ? 'Check' : a.toCall >= a.chips ? `All-in <small>${fmt(a.toCall)}</small>` : `Call <small>${fmt(a.toCall)}</small>`;
      const raiseBtn = a.raise
        ? `<button class="btn brass" data-act="open-raise">${a.raise.isBet ? 'Bet' : 'Raise'}</button>`
        : `<button class="btn quiet" disabled>Raise</button>`;
      el.innerHTML = `<div class="turn-line"><i></i></div><div class="row">
        <button class="btn ghost" data-act="fold">Fold</button>
        <button class="btn quiet" data-act="${a.canCheck ? 'check' : 'call'}">${callLabel}</button>
        ${raiseBtn}
      </div>`;
      return;
    }

    const buttons = [];
    let status = '';
    if (s.canRebuy) buttons.push(`<button class="btn brass" data-act="rebuy">Rebuy ${fmt(s.settings.startingChips)} chips</button>`);
    else if (me && me.sittingOut) buttons.push(`<button class="btn brass" data-act="sit-in">I'm back</button>`);

    if (!s.started) {
      const n = s.seats.filter(Boolean).length;
      if (isHost) {
        buttons.push(`<button class="btn brass" data-act="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Waiting for players' : `Start game with ${n}`}</button>`);
        buttons.push(`<button class="btn ghost" data-act="invite">Invite</button>`);
      } else {
        const host = s.seats.find((p) => p && p.id === s.hostId);
        status = `Waiting for <b>${esc(host ? host.name : 'the admin')}</b> to start the game`;
      }
    } else if (['preflop', 'flop', 'turn', 'river'].includes(s.stage) && s.toAct >= 0) {
      const p = s.seats[s.toAct];
      if (p) status = `<b>${esc(p.name)}</b> is thinking`;
    } else if (s.stage === 'showdown') {
      status = 'Next hand coming up';
    }

    if (buttons.length) el.innerHTML = `<div class="row ${buttons.length === 1 ? 'one' : 'two'}">${buttons.join('')}</div>`;
    else el.innerHTML = `<div class="status">${status}</div>`;
  }

  function potRaise(s, a, fraction) {
    const toCall = a.currentBet - a.myBet;
    return Math.round(a.currentBet + (s.pot + toCall) * fraction);
  }

  function drawRaise(s, a) {
    const r = a.raise;
    const clamp = (v) => Math.max(r.min, Math.min(r.max, Math.round(v)));
    raise.value = clamp(raise.value);
    const verb = r.isBet ? 'Bet' : 'Raise to';
    const half = clamp(potRaise(s, a, 0.5));
    const pot = clamp(potRaise(s, a, 1));
    $('#actions').innerHTML = `<div class="turn-line"><i></i></div><div class="raise-panel">
      <div class="raise-top">
        <button class="step-btn" data-act="minus" aria-label="Less">−</button>
        <div class="amount"><small>${verb}</small><span id="raiseAmt">${fmt(raise.value)}</span></div>
        <button class="step-btn" data-act="plus" aria-label="More">+</button>
      </div>
      <input type="range" id="raiseRange" min="${r.min}" max="${r.max}" step="1" value="${raise.value}" aria-label="${verb} amount">
      <div class="presets">
        <button data-set="${r.min}">Min</button>
        <button data-set="${half}" ${half <= r.min || half >= r.max ? 'disabled' : ''}>½ pot</button>
        <button data-set="${pot}" ${pot <= r.min || pot >= r.max ? 'disabled' : ''}>Pot</button>
        <button data-set="${r.max}">All-in</button>
      </div>
      <div class="row two">
        <button class="btn ghost" data-act="close-raise">Back</button>
        <button class="btn brass" data-act="raise" id="raiseGo">${raise.value >= r.max ? 'All-in' : `${verb} ${fmt(raise.value)}`}</button>
      </div>
    </div>`;
    $('#raiseRange').addEventListener('input', (e) => setRaise(+e.target.value, false));
  }

  function setRaise(v, moveSlider = true) {
    const a = state && state.actions;
    if (!a || !a.raise || !raise) return;
    const r = a.raise;
    raise.value = Math.max(r.min, Math.min(r.max, Math.round(v)));
    $('#raiseAmt').textContent = fmt(raise.value);
    const verb = r.isBet ? 'Bet' : 'Raise to';
    $('#raiseGo').textContent = raise.value >= r.max ? 'All-in' : `${verb} ${fmt(raise.value)}`;
    if (moveSlider) $('#raiseRange').value = raise.value;
  }

  $('#actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.set) return setRaise(+btn.dataset.set);
    const act = btn.dataset.act;
    const a = state && state.actions;
    switch (act) {
      case 'fold': case 'check': case 'call':
        btn.disabled = true;
        await send('action', { type: act });
        break;
      case 'open-raise':
        raise = { value: a.raise.min };
        actionsKey = '';
        render();
        break;
      case 'close-raise':
        raise = null;
        actionsKey = '';
        render();
        break;
      case 'minus': setRaise(raise.value - state.settings.bigBlind); break;
      case 'plus': setRaise(raise.value + state.settings.bigBlind); break;
      case 'raise': {
        const amount = raise.value;
        btn.disabled = true;
        const res = await send('action', { type: 'raise', amount });
        if (res.ok) raise = null;
        else btn.disabled = false;
        break;
      }
      case 'start': await send('start'); break;
      case 'rebuy': await send('rebuy'); break;
      case 'sit-in': await send('sitout', { value: false }); break;
      case 'invite': invite(); break;
    }
  });

  // ---------- timer bars ----------

  function tick() {
    if (!state) return;
    const total = (state.turnSeconds || 30) * 1000;
    const left = deadline ? Math.max(0, deadline - Date.now()) : null;
    const frac = left == null ? 1 : left / total;
    for (const sel of ['.seat.acting .timer', '.turn-line']) {
      const bar = document.querySelector(sel);
      if (!bar) continue;
      bar.querySelector('i').style.transform = `scaleX(${Math.min(1, frac)})`;
      bar.classList.toggle('low', left != null && left < 6000);
    }
  }
  setInterval(tick, 200);

  // ---------- your turn: sound and buzz ----------

  let audio = null;
  function unlockAudio() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  function chime() {
    if (!soundOn || !audio) return;
    const t = audio.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.4);
    });
  }

  function handleTurn(s, me) {
    const mine = !!s.actions;
    const moves = s.log.filter((l) => l.kind !== 'chat');
    const key = mine ? `${s.handNumber}-${s.stage}-${s.currentBet}-${moves.length ? moves[moves.length - 1].id : 0}` : '';
    if (mine && key !== lastTurnKey) {
      chime();
      if (navigator.vibrate) navigator.vibrate(60);
      announce('Your turn');
    }
    lastTurnKey = key;
    document.title = mine ? 'Your turn | Black Tie Poker' : 'Black Tie Poker';
    if (s.results && s.results.winners[0] && me) {
      const w = s.results.winners.find((x) => x.id === s.you);
      if (w) announce(`You win ${w.amount}`);
    }
  }

  function announce(text) { $('#announcer').textContent = text; }

  // ---------- log, chat, menu ----------

  function handleLog(s) {
    const fresh = s.log.filter((l) => l.id > lastLogId);
    if (lastLogId > 0) {
      for (const l of fresh) {
        if (l.kind === 'chat' && !$('#logSheet').open) {
          toast(`${l.from}: ${l.text}`);
          $('#unreadDot').hidden = false;
        } else if (l.kind === 'settings' && s.hostId !== s.you) {
          toast(l.text);
        } else if (l.kind === 'founder') {
          toast(l.text);
        }
      }
    }
    if (s.log.length) lastLogId = s.log[s.log.length - 1].id;
    if ($('#logSheet').open) renderLog();
  }

  function renderLog() {
    const list = $('#logList');
    list.innerHTML = state.log.map((l) =>
      l.kind === 'chat'
        ? `<li class="msg"><b>${esc(l.from)}</b> ${esc(l.text)}</li>`
        : `<li class="${l.kind}">${esc(prettyCards(l.text))}</li>`).join('');
    list.scrollTop = list.scrollHeight;
  }

  function prettyCards(text) {
    // \uFE0E keeps the suit symbols as plain text instead of emoji.
    return text.replace(/\b([2-9TJQKA])([shdc])\b/g, (_, r, su) => (RANK[r] || r) + SUITS[su][0] + '\uFE0E');
  }

  function renderMenu(s, me, isHost) {
    $('#mSettings').hidden = !isHost;
    $('#mSitOut').textContent = me && me.sittingOut ? "I'm back, deal me in" : 'Sit out next hand';
    $('#mSound').textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
    const players = s.seats.filter(Boolean).sort((a, b) => b.chips - a.chips);
    $('#standings').innerHTML = players.map((p) => `<li>
      <span class="who">${p.founder ? `<span class="founder-mark" aria-label="Founder">${FOUNDER_CROWN}</span>` : ''}${s.hostId === p.id ? `<span class="admin-mark" aria-label="Admin">${CROWN}</span>` : ''}${esc(p.name)}${p.id === s.you ? ' (you)' : ''}</span>
      <span class="num">${fmt(p.chips)}</span>
      <span class="${p.net >= 0 ? 'up' : 'down'}">${p.net > 0 ? '+' : ''}${fmt(p.net)}</span>
    </li>`).join('');
  }

  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  }
  const open = (id) => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); $(id).showModal(); };

  $('#menuBtn').addEventListener('click', () => open('#menuSheet'));
  $('#inviteBtn').addEventListener('click', invite);
  $('#mInvite').addEventListener('click', invite);
  $('#mLog').addEventListener('click', () => { open('#logSheet'); $('#unreadDot').hidden = true; renderLog(); });
  $('#mSitOut').addEventListener('click', async () => {
    const me = state.seats.find((p) => p && p.id === state.you);
    await send('sitout', { value: !(me && me.sittingOut) });
    $('#menuSheet').close();
  });
  $('#mSound').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set('btp-sound', soundOn ? 'on' : 'off');
    $('#mSound').textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
    unlockAudio();
  });
  // ---------- admin settings ----------

  let pendingFelt = null;
  let pendingRoom = null;
  let savedSettings = false;

  function swatches(el, list, current, onPick) {
    const known = list.some(([hex]) => hex === current);
    el.innerHTML = list.map(([hex, name]) =>
      `<button type="button" class="swatch" role="radio" aria-checked="${hex === current}" aria-label="${name}" title="${name}" data-hex="${hex}" style="--c:${hex}"></button>`).join('') +
      `<label class="swatch custom" title="Pick any colour" aria-checked="${!known}" style="--c:${known ? 'transparent' : current}">
        <input type="color" value="${current}" aria-label="Pick any colour"><span>Any</span>
      </label>`;
    el.onclick = (e) => {
      const b = e.target.closest('button.swatch');
      if (b) onPick(b.dataset.hex);
    };
    el.querySelector('input[type=color]').oninput = (e) => onPick(e.target.value);
  }

  function drawSwatches() {
    swatches($('#feltSwatches'), FELTS, pendingFelt, (hex) => { pendingFelt = hex; preview(); });
    swatches($('#roomSwatches'), ROOMS, pendingRoom, (hex) => { pendingRoom = hex; preview(); });
  }

  function preview() {
    applyTheme(pendingFelt, pendingRoom);
    // Update the ticks without rebuilding the colour pickers (keeps the picker open on phones).
    for (const [id, cur, list] of [['#feltSwatches', pendingFelt, FELTS], ['#roomSwatches', pendingRoom, ROOMS]]) {
      const known = list.some(([hex]) => hex === cur);
      for (const b of $(id).querySelectorAll('button.swatch')) b.setAttribute('aria-checked', String(b.dataset.hex === cur));
      const custom = $(id).querySelector('.custom');
      custom.setAttribute('aria-checked', String(!known));
      custom.style.setProperty('--c', known ? 'transparent' : cur);
    }
  }

  function openSettings() {
    const st = state.settings;
    $('#setSB').value = st.smallBlind;
    $('#setBB').value = st.bigBlind;
    $('#setAnte').value = st.ante || 0;
    $('#setChips').value = st.startingChips;
    $('#setTimer').value = String(st.turnSeconds);
    markQuick('set');
    pendingFelt = st.felt;
    pendingRoom = st.room;
    savedSettings = false;
    drawSwatches();
    open('#settingsSheet');
  }

  $('#mSettings').addEventListener('click', openSettings);
  $('#adminBtn').addEventListener('click', openSettings);
  // Closing without saving puts the old colours back.
  $('#settingsSheet').addEventListener('close', () => {
    if (!savedSettings && state) { themeKey = ''; applyTheme(state.settings.felt, state.settings.room); }
  });
  $('#saveSettings').addEventListener('click', async () => {
    const settings = readSettings('set');
    if (!settings) return;
    const res = await send('settings', { ...settings, felt: pendingFelt, room: pendingRoom });
    if (res.ok) { savedSettings = true; $('#settingsSheet').close(); toast('Saved. Everyone at the table sees the changes.'); }
  });
  $('#mLeave').addEventListener('click', async () => {
    const code = myCode;
    const res = await send('leave');
    if (res.ok) { store.del(tokenKey(code)); $('#menuSheet').close(); showHome('You left the table.'); }
  });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    const res = await send('chat', { text });
    if (res.ok) $('#chatInput').value = '';
  });

  async function invite() {
    if (!myCode) return;
    const url = `${location.origin}/?t=${myCode}`;
    const text = `Join my poker table on Black Tie Poker. Code ${myCode}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Black Tie Poker', text, url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied. Paste it in your group chat.'); }
    catch { toast(`Send your friends this link: ${url}`); }
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  window.addEventListener('resize', () => { if (state) renderTable(state, state.seats.find((p) => p && p.id === state.you)); });
})();
