// Hand evaluator for Texas Hold'em.
// Cards are 2-character strings: rank + suit, e.g. "As" (ace of spades), "Td" (ten of diamonds).

const RANKS = '23456789TJQKA';
const NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};
const plural = (v) => (v === 6 ? 'Sixes' : NAMES[v] + 's');

const value = (card) => RANKS.indexOf(card[0]) + 2;
const suit = (card) => card[1];

// Scores exactly 5 cards. Higher score = better hand.
function score5(cards) {
  const vals = cards.map(value).sort((a, b) => b - a);
  const flush = cards.every((c) => suit(c) === suit(cards[0]));

  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ v: +v, c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);

  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5 "wheel"
  }

  let cat;
  let kick;
  if (straightHigh && flush) { cat = 8; kick = [straightHigh]; }
  else if (groups[0].c === 4) { cat = 7; kick = [groups[0].v, groups[1].v]; }
  else if (groups[0].c === 3 && groups[1].c === 2) { cat = 6; kick = [groups[0].v, groups[1].v]; }
  else if (flush) { cat = 5; kick = vals; }
  else if (straightHigh) { cat = 4; kick = [straightHigh]; }
  else if (groups[0].c === 3) { cat = 3; kick = groups.map((g) => g.v); }
  else if (groups[0].c === 2 && groups[1].c === 2) { cat = 2; kick = groups.map((g) => g.v); }
  else if (groups[0].c === 2) { cat = 1; kick = groups.map((g) => g.v); }
  else { cat = 0; kick = vals; }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (kick[i] || 0);
  return { score, cat, kick };
}

function handName(cat, kick) {
  switch (cat) {
    case 8: return kick[0] === 14 ? 'Royal Flush' : `Straight Flush, ${NAMES[kick[0]]} high`;
    case 7: return `Four of a Kind, ${plural(kick[0])}`;
    case 6: return `Full House, ${plural(kick[0])} over ${plural(kick[1])}`;
    case 5: return `Flush, ${NAMES[kick[0]]} high`;
    case 4: return `Straight, ${NAMES[kick[0]]} high`;
    case 3: return `Three of a Kind, ${plural(kick[0])}`;
    case 2: return `Two Pair, ${plural(kick[0])} and ${plural(kick[1])}`;
    case 1: return `Pair of ${plural(kick[0])}`;
    default: return `${NAMES[kick[0]]} High`;
  }
}

// Best 5-card hand from 5, 6 or 7 cards.
function bestHand(cards) {
  if (cards.length < 5) {
    // Pre-flop: only hole cards. Describe them for beginners.
    const vals = cards.map(value).sort((a, b) => b - a);
    if (vals.length === 2 && vals[0] === vals[1]) return { score: 0, name: `Pocket ${plural(vals[0])}`, cards: [...cards] };
    return { score: 0, name: `${NAMES[vals[0]]} High`, cards: [...cards] };
  }
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(five);
            if (!best || s.score > best.score) best = { ...s, cards: five };
          }
  return { score: best.score, name: handName(best.cat, best.kick), cards: best.cards, cat: best.cat };
}

module.exports = { bestHand, score5, handName, value };
