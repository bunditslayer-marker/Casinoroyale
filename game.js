// The poker table: all of the Texas Hold'em rules live here.
// The server is the dealer — players only ever see their own hole cards.

const crypto = require('crypto');
const { bestHand } = require('./evaluator');

const MAX_SEATS = 8;
const BETTING = ['preflop', 'flop', 'turn', 'river'];
const TURN_OPTIONS = [0, 15, 20, 30, 45, 60, 90];

const DELAY = {
  runoutStreet: 1400, // pause between streets when everyone is all-in
  nextHand: 6500, // time to admire the showdown before the next deal
  autoStart: 2000, // restart after someone joins or rebuys
};

function newDeck() {
  const deck = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function int(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_SETTINGS = {
  startingChips: 1000, smallBlind: 10, bigBlind: 20, ante: 0, turnSeconds: 30,
  felt: '#0f4a37', // table colour
  room: '#2b0f15', // background colour around the table
};
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function normalizeSettings(s = {}, base = {}) {
  const prev = { ...DEFAULT_SETTINGS, ...base };
  const merged = { ...prev, ...s };
  const bigBlind = Math.min(Math.max(int(merged.bigBlind, prev.bigBlind), 1), 100000);
  const smallBlind = Math.min(Math.max(int(merged.smallBlind, Math.ceil(bigBlind / 2)), 1), bigBlind);
  const ante = Math.min(Math.max(int(merged.ante, 0), 0), bigBlind);
  const startingChips = Math.min(Math.max(int(merged.startingChips, prev.startingChips), bigBlind * 2), 10000000);
  let turnSeconds = int(merged.turnSeconds, 30);
  if (!TURN_OPTIONS.includes(turnSeconds)) turnSeconds = 30;
  const felt = isHex(merged.felt) ? merged.felt.toLowerCase() : prev.felt;
  const room = isHex(merged.room) ? merged.room.toLowerCase() : prev.room;
  return { startingChips, smallBlind, bigBlind, ante, turnSeconds, felt, room };
}

class TableError extends Error {}

class Table {
  constructor(code, settings, opts = {}) {
    this.code = code;
    this.settings = normalizeSettings(settings);
    this.seats = Array(MAX_SEATS).fill(null);
    this.players = new Map();
    this.hostId = null;
    this.started = false;
    this.stage = 'waiting';
    this.handNumber = 0;
    this.dealerSeat = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.community = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastFullBet = 0;
    this.toAct = -1;
    this.actionId = 0;
    this.turnDeadline = null;
    this.results = null;
    this.log = [];
    this.logId = 0;

    this.onChange = opts.onChange || (() => {});
    this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel || ((h) => clearTimeout(h));
    this.now = opts.now || (() => Date.now());
    this.makeDeck = opts.newDeck || newDeck;
    this.turnTimer = null;
    this.flowTimer = null;
  }

  // ---------- helpers ----------

  get live() {
    return this.seats.filter((p) => p && p.inHand && !p.folded);
  }

  get pot() {
    let sum = 0;
    for (const p of this.players.values()) sum += p.total;
    return sum;
  }

  inBetting() {
    return BETTING.includes(this.stage);
  }

  nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (((from + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if (p && pred(p)) return s;
    }
    return -1;
  }

  addLog(text, kind = 'info', extra = {}) {
    this.log.push({ id: ++this.logId, text, kind, ...extra });
    if (this.log.length > 80) this.log.shift();
  }

  changed() {
    this.onChange(this);
  }

  setFlowTimer(fn, ms) {
    if (this.flowTimer) this.cancel(this.flowTimer);
    this.flowTimer = this.schedule(() => {
      this.flowTimer = null;
      fn();
      this.changed();
    }, ms);
  }

  clearTimers() {
    if (this.turnTimer) this.cancel(this.turnTimer);
    if (this.flowTimer) this.cancel(this.flowTimer);
    this.turnTimer = null;
    this.flowTimer = null;
  }

  // ---------- players ----------

  addPlayer(id, rawName, { founder = false } = {}) {
    if (this.players.has(id)) return this.players.get(id);
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new TableError('This table is full (8 players max).');

    let name = rawName;
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${rawName.slice(0, 12)} ${n}`;

    const p = {
      id, name, seat,
      chips: this.settings.startingChips,
      buyIns: 1,
      hole: [], hand: null,
      inHand: false, folded: false, allIn: false,
      bet: 0, total: 0,
      acted: false, lastActedFullBet: -1,
      lastAction: null,
      sittingOut: false, connected: true, timeouts: 0,
      leaving: false, shown: false,
      founder: !!founder,
    };
    this.seats[seat] = p;
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    this.addLog(founder ? `${name}, the founder, has arrived` : `${name} sat down`, founder ? 'founder' : 'join');
    this.maybeAutoStart();
    this.changed();
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.leaving = true;
    this.addLog(`${p.name} left the table`, 'join');

    if (p.inHand && this.inBetting()) {
      const wasTurn = this.seats[this.toAct] === p;
      if (!p.folded) {
        p.folded = true;
        p.lastAction = 'Fold';
      }
      if (wasTurn) this.advance(p.seat);
      else if (this.live.length === 1) this.winUncontested(this.live[0]);
      // Otherwise they stay seated (folded) until the hand ends.
    } else {
      this.detach(p);
    }
    this.changed();
  }

  detach(p) {
    this.seats[p.seat] = null;
    this.players.delete(p.id);
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((x) => !x.leaving);
      this.hostId = next ? next.id : null;
      if (next) this.addLog(`${next.name} is now the admin`, 'settings');
    }
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    if (this.inBetting() && this.seats[this.toAct] === p && !this.settings.turnSeconds) this.armTurnTimer();
    this.changed();
  }

  sitOut(id, value) {
    const p = this.players.get(id);
    if (!p) return;
    p.sittingOut = !!value;
    if (!value) p.timeouts = 0;
    this.addLog(value ? `${p.name} is sitting out` : `${p.name} is back`, 'info');
    this.maybeAutoStart();
    this.changed();
  }

  rebuy(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.chips > 0) throw new TableError('You still have chips.');
    if (p.inHand && this.inBetting() && !p.folded) throw new TableError('Wait for this hand to finish.');
    p.chips = this.settings.startingChips;
    p.buyIns += 1;
    p.sittingOut = false;
    p.timeouts = 0;
    this.addLog(`${p.name} rebought for ${p.chips}`, 'info');
    this.maybeAutoStart();
    this.changed();
  }

  chat(id, text) {
    const p = this.players.get(id);
    if (!p) return;
    this.addLog(text, 'chat', { from: p.name });
    this.changed();
  }

  updateSettings(id, s) {
    if (id !== this.hostId) throw new TableError('Only the admin can change settings.');
    const before = this.settings;
    this.settings = normalizeSettings(s, before);
    const st = this.settings;
    const rules = [];
    if (st.smallBlind !== before.smallBlind || st.bigBlind !== before.bigBlind) rules.push(`blinds ${st.smallBlind}/${st.bigBlind}`);
    if (st.ante !== before.ante) rules.push(st.ante ? `ante ${st.ante}` : 'no ante');
    if (st.startingChips !== before.startingChips) rules.push(`starting chips ${st.startingChips}`);
    if (st.turnSeconds !== before.turnSeconds) rules.push(st.turnSeconds ? `${st.turnSeconds}-second turn timer` : 'no turn timer');
    const parts = [];
    if (rules.length) parts.push(rules.join(', ') + (this.inBetting() ? ' from next hand' : ''));
    if (st.felt !== before.felt || st.room !== before.room) parts.push('new table colours');
    if (parts.length) this.addLog(`Admin update: ${parts.join('. Also ')}`, 'settings');
    this.changed();
  }

  // ---------- game flow ----------

  start(id) {
    if (id !== this.hostId) throw new TableError('Only the admin can start the game.');
    if (this.started && this.stage !== 'waiting') return;
    if (this.eligible().length < 2) throw new TableError('You need at least 2 players with chips.');
    this.started = true;
    this.startHand();
    this.changed();
  }

  eligible() {
    return this.seats.filter((p) => p && p.chips > 0 && !p.sittingOut && !p.leaving);
  }

  maybeAutoStart() {
    if (this.started && this.stage === 'waiting' && !this.flowTimer && this.eligible().length >= 2) {
      this.setFlowTimer(() => {
        if (this.stage === 'waiting') this.startHand();
      }, DELAY.autoStart);
    }
  }

  startHand() {
    const eligible = this.eligible();
    this.community = [];
    for (const p of this.players.values()) {
      Object.assign(p, {
        inHand: eligible.length >= 2 && eligible.includes(p), hole: [], hand: null, folded: false, allIn: false,
        bet: 0, total: 0, acted: false, lastActedFullBet: -1, lastAction: null, shown: false,
      });
    }
    if (eligible.length < 2) {
      this.stage = 'waiting';
      this.toAct = -1;
      this.turnDeadline = null;
      this.addLog('Waiting for more players with chips…', 'info');
      return false;
    }

    this.handNumber += 1;
    this.deck = this.makeDeck();
    this.results = null;

    const inHand = (p) => p.inHand;
    this.dealerSeat = this.nextSeat(this.dealerSeat, inHand);
    if (eligible.length === 2) {
      // Heads-up: the dealer posts the small blind and acts first before the flop.
      this.sbSeat = this.dealerSeat;
      this.bbSeat = this.nextSeat(this.dealerSeat, inHand);
    } else {
      this.sbSeat = this.nextSeat(this.dealerSeat, inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, inHand);
    }

    this.addLog(`— Hand #${this.handNumber} —`, 'hand');
    const { ante } = this.settings;
    if (ante > 0) {
      // Everyone dealt in puts the ante in the middle. It counts toward the pot, not toward calling.
      for (const p of eligible) {
        const a = Math.min(ante, p.chips);
        p.chips -= a;
        p.total += a;
        if (p.chips === 0) { p.allIn = true; p.lastAction = 'All-in'; }
      }
      this.addLog(`Everyone antes ${ante}`, 'info');
    }
    this.post(this.seats[this.sbSeat], this.settings.smallBlind, 'SB');
    this.post(this.seats[this.bbSeat], this.settings.bigBlind, 'BB');

    for (let round = 0; round < 2; round++) {
      let s = this.dealerSeat;
      for (let i = 0; i < eligible.length; i++) {
        s = this.nextSeat(s, inHand);
        this.seats[s].hole.push(this.deck.pop());
      }
    }

    this.stage = 'preflop';
    this.currentBet = this.settings.bigBlind;
    this.minRaise = this.settings.bigBlind;
    this.lastFullBet = this.settings.bigBlind;
    this.advance(this.bbSeat);
    return true;
  }

  post(p, amount, label) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = p.allIn ? 'All-in' : label;
  }

  canAct(p) {
    return p.inHand && !p.folded && !p.allIn;
  }

  needsToAct(p) {
    return this.canAct(p) && (!p.acted || p.bet < this.currentBet);
  }

  canRaise(p) {
    const toCall = this.currentBet - p.bet;
    if (p.chips <= toCall) return false;
    const opponentsWhoCanRespond = this.live.filter((x) => x !== p && !x.allIn).length;
    if (opponentsWhoCanRespond === 0) return false;
    return !p.acted || p.lastActedFullBet < this.lastFullBet;
  }

  // Decide what happens after someone acts (or after the blinds go in).
  advance(fromSeat) {
    const live = this.live;
    if (live.length === 1) return this.winUncontested(live[0]);

    const actors = live.filter((p) => !p.allIn);
    let next = this.nextSeat(fromSeat, (p) => this.needsToAct(p));
    if (actors.length === 0 || (actors.length === 1 && actors[0].bet >= this.currentBet)) next = -1;

    if (next === -1) return this.endStreet();
    this.setTurn(next);
  }

  setTurn(seat) {
    this.toAct = seat;
    this.actionId += 1;
    this.armTurnTimer();
  }

  armTurnTimer() {
    const id = this.actionId;
    if (this.turnTimer) this.cancel(this.turnTimer);
    this.turnTimer = null;
    const p = this.seats[this.toAct];
    let secs = this.settings.turnSeconds;
    // Even with the timer off, don't let a disconnected player freeze the table.
    if (!secs && p && !p.connected) secs = 30;
    if (secs > 0) {
      this.turnDeadline = this.now() + secs * 1000;
      this.turnTimer = this.schedule(() => {
        this.turnTimer = null;
        if (this.actionId === id && this.inBetting()) {
          this.timeout();
          this.changed();
        }
      }, secs * 1000);
    } else {
      this.turnDeadline = null;
    }
  }

  timeout() {
    const p = this.seats[this.toAct];
    if (!p) return;
    p.timeouts += 1;
    const type = this.currentBet - p.bet > 0 ? 'fold' : 'check';
    this.act(p.id, type, 0, { auto: true });
    if (p.timeouts >= 2 && !p.sittingOut) {
      p.sittingOut = true;
      this.addLog(`${p.name} timed out twice and is now sitting out`, 'info');
    }
  }

  act(id, type, amount = 0, { auto = false } = {}) {
    if (!this.inBetting()) throw new TableError('No hand in progress.');
    const p = this.players.get(id);
    if (!p || this.seats[this.toAct] !== p) throw new TableError("It's not your turn.");

    const toCall = this.currentBet - p.bet;
    const maxTo = p.bet + p.chips;
    let text;

    if (type === 'allin') {
      if (maxTo > this.currentBet && this.canRaise(p)) { type = 'raise'; amount = maxTo; }
      else type = toCall > 0 ? 'call' : 'check';
    }
    if (type === 'bet') type = 'raise';
    if (type === 'call' && toCall <= 0) type = 'check';

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        text = `${p.name} folds`;
        break;
      case 'check':
        if (toCall > 0) throw new TableError(`You need to call ${Math.min(toCall, p.chips)} or fold.`);
        p.lastAction = 'Check';
        text = `${p.name} checks`;
        break;
      case 'call': {
        const a = Math.min(toCall, p.chips);
        this.move(p, a);
        p.lastAction = p.allIn ? 'All-in' : 'Call';
        text = p.allIn ? `${p.name} calls ${a} and is all-in` : `${p.name} calls ${a}`;
        break;
      }
      case 'raise': {
        if (!this.canRaise(p)) throw new TableError("You can't raise right now.");
        let target = Math.min(int(amount, 0), maxTo);
        const minTo = this.currentBet + this.minRaise;
        if (target <= this.currentBet) throw new TableError(`Raise must be more than ${this.currentBet}.`);
        if (target < minTo && target < maxTo) throw new TableError(`Minimum is ${Math.min(minTo, maxTo)}.`);
        const isBet = this.currentBet === 0;
        const raiseSize = target - this.currentBet;
        this.move(p, target - p.bet);
        if (raiseSize >= this.minRaise) {
          this.minRaise = raiseSize;
          this.lastFullBet = target;
        }
        this.currentBet = target;
        p.lastAction = p.allIn ? 'All-in' : isBet ? 'Bet' : 'Raise';
        text = p.allIn
          ? `${p.name} goes all-in for ${target}`
          : isBet ? `${p.name} bets ${target}` : `${p.name} raises to ${target}`;
        break;
      }
      default:
        throw new TableError('Unknown action.');
    }

    if (!auto) p.timeouts = 0;
    else text += ' (timed out)';
    p.acted = true;
    p.lastActedFullBet = this.lastFullBet;
    this.addLog(text, 'action');
    this.advance(p.seat);
    this.changed();
  }

  move(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allIn = true;
  }

  // Give back the part of a bet nobody could match.
  returnUncalled() {
    const contributors = [...this.players.values()].filter((p) => p.total > 0);
    if (!contributors.length) return;
    contributors.sort((a, b) => b.total - a.total);
    const top = contributors[0];
    const second = contributors[1] ? contributors[1].total : 0;
    const extra = top.total - second;
    if (extra > 0) {
      top.total -= extra;
      top.bet = Math.max(0, top.bet - extra);
      top.chips += extra;
      if (top.chips > 0) top.allIn = false;
    }
  }

  endStreet() {
    if (this.turnTimer) this.cancel(this.turnTimer);
    this.turnTimer = null;
    this.toAct = -1;
    this.turnDeadline = null;
    this.returnUncalled();

    for (const p of this.players.values()) {
      p.bet = 0;
      p.acted = false;
      p.lastActedFullBet = -1;
      if (p.inHand && !p.folded && !p.allIn) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.lastFullBet = 0;

    if (this.stage === 'river') return this.showdown();

    this.deck.pop(); // burn a card
    if (this.stage === 'preflop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.stage = 'flop';
    } else if (this.stage === 'flop') {
      this.community.push(this.deck.pop());
      this.stage = 'turn';
    } else {
      this.community.push(this.deck.pop());
      this.stage = 'river';
    }
    this.addLog(`${this.stage[0].toUpperCase() + this.stage.slice(1)}: ${this.community.join(' ')}`, 'board');

    const actors = this.live.filter((p) => !p.allIn);
    if (actors.length <= 1) {
      // Everyone is all-in: show both hands and run out the board.
      for (const p of this.live) p.shown = true;
      this.setFlowTimer(() => this.endStreet(), DELAY.runoutStreet);
      return;
    }
    this.advance(this.dealerSeat);
  }

  buildPots() {
    const all = [...this.players.values()].filter((p) => p.total > 0);
    const live = this.live;
    const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of all) amount += Math.max(0, Math.min(p.total, level) - prev);
      const eligible = live.filter((p) => p.total >= level);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    let leftover = 0;
    for (const p of all) leftover += Math.max(0, p.total - prev);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  // Seat order starting left of the dealer — used to hand out odd chips.
  orderFromDealer(players) {
    const dist = (p) => (p.seat - this.dealerSeat - 1 + MAX_SEATS) % MAX_SEATS;
    return [...players].sort((a, b) => dist(a) - dist(b));
  }

  showdown() {
    this.stage = 'showdown';
    this.toAct = -1;
    const live = this.live;
    for (const p of live) {
      p.hand = bestHand([...p.hole, ...this.community]);
      p.shown = true;
    }

    const won = new Map();
    const pots = this.buildPots().map((pot, i) => {
      const best = Math.max(...pot.eligible.map((p) => p.hand.score));
      const winners = this.orderFromDealer(pot.eligible.filter((p) => p.hand.score === best));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const w of winners) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd -= 1;
        w.chips += amt;
        won.set(w.id, (won.get(w.id) || 0) + amt);
      }
      return {
        label: i === 0 ? 'Main pot' : `Side pot ${i}`,
        amount: pot.amount,
        winners: winners.map((w) => w.id),
        handName: winners[0].hand.name,
      };
    });

    for (const p of this.players.values()) p.total = 0;

    const winners = [...won.entries()].map(([id, amount]) => {
      const p = this.players.get(id);
      return { id, name: p.name, amount, handName: p.hand.name, cards: p.hand.cards };
    });
    for (const w of winners) this.addLog(`${w.name} wins ${w.amount} with ${w.handName}`, 'win');
    this.results = { uncontested: false, pots, winners };
    this.finishHand();
  }

  winUncontested(p) {
    if (this.turnTimer) this.cancel(this.turnTimer);
    this.turnTimer = null;
    this.returnUncalled();
    const amount = this.pot;
    p.chips += amount;
    for (const x of this.players.values()) { x.total = 0; x.bet = 0; }
    this.stage = 'showdown';
    this.toAct = -1;
    this.turnDeadline = null;
    this.results = {
      uncontested: true,
      pots: [{ label: 'Pot', amount, winners: [p.id], handName: null }],
      winners: [{ id: p.id, name: p.name, amount, handName: null, cards: [] }],
    };
    this.addLog(`${p.name} wins ${amount}`, 'win');
    this.finishHand();
  }

  finishHand() {
    for (const p of [...this.players.values()]) {
      if (p.leaving) this.detach(p);
      else if (p.chips === 0) this.addLog(`${p.name} is out of chips — tap Rebuy to get back in`, 'info');
    }
    this.setFlowTimer(() => this.startHand(), DELAY.nextHand);
  }

  // ---------- what each player is allowed to see ----------

  allowedActions(p) {
    if (!this.inBetting() || this.seats[this.toAct] !== p) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.chips);
    const maxTo = p.bet + p.chips;
    const raise = this.canRaise(p)
      ? { min: Math.min(this.currentBet + this.minRaise, maxTo), max: maxTo, isBet: this.currentBet === 0 }
      : null;
    return { toCall, canCheck: toCall <= 0, raise, currentBet: this.currentBet, myBet: p.bet, chips: p.chips };
  }

  viewFor(id) {
    const me = this.players.get(id) || null;
    const showCards = (p) => p.id === id || p.shown;
    return {
      code: this.code,
      you: id,
      hostId: this.hostId,
      settings: this.settings,
      started: this.started,
      stage: this.stage,
      handNumber: this.handNumber,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      dealerSeat: this.dealerSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      toAct: this.toAct,
      turnEndsIn: this.turnDeadline ? Math.max(0, this.turnDeadline - this.now()) : null,
      turnSeconds: this.settings.turnSeconds,
      seats: this.seats.map((p) =>
        p && {
          id: p.id,
          name: p.name,
          seat: p.seat,
          chips: p.chips,
          bet: p.bet,
          inHand: p.inHand,
          folded: p.folded,
          allIn: p.allIn,
          lastAction: p.lastAction,
          sittingOut: p.sittingOut,
          connected: p.connected,
          founder: p.founder,
          net: p.chips + p.total - p.buyIns * this.settings.startingChips,
          // Your own cards, or cards shown at showdown. Everyone else sees card backs.
          cards: !p.inHand || !p.hole.length ? null
            : p.id === id ? p.hole
            : p.folded ? null
            : showCards(p) ? p.hole : ['??', '??'],
          handName: p.shown && p.hand ? p.hand.name : null,
        },
      ),
      yourHand: me && me.inHand && me.hole.length ? bestHand([...me.hole, ...this.community]).name : null,
      actions: me ? this.allowedActions(me) : null,
      canRebuy: !!me && me.chips === 0 && !(me.inHand && this.inBetting() && !me.folded),
      results: this.results,
      log: this.log.slice(-40),
    };
  }
}

module.exports = { Table, TableError, normalizeSettings, DEFAULT_SETTINGS, MAX_SEATS, DELAY };
