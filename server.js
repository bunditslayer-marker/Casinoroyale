// Black Tie Poker — the server. It runs the tables and deals the cards.
// Start it with:  npm start   (then open http://localhost:3000)

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Table, TableError } = require('./game');
const { isReservedName, checkOwner } = require('./owner');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // close empty tables after 3 hours

const app = express();
// The three files the browser needs. Everything else stays private on the server.
const PAGE_FILES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/client.js': 'client.js' };
for (const [route, file] of Object.entries(PAGE_FILES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, file)));
}
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

const rooms = new Map(); // code -> { table, tokens: Map(token -> playerId), sockets: Set, emptySince }

// ---------- helpers ----------

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (they look like 1 and 0)
function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(raw) {
  const name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return name || 'Player';
}

function cleanText(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
}

// Each player gets their own view: their own cards, nobody else's.
function broadcast(room) {
  if (room.pending) return;
  room.pending = true;
  setImmediate(() => {
    room.pending = false;
    for (const s of room.sockets) {
      if (s.data.playerId) s.emit('state', room.table.viewFor(s.data.playerId));
    }
  });
}

function makeRoom(settings) {
  const code = newCode();
  const room = { code, tokens: new Map(), sockets: new Set(), emptySince: null, pending: false };
  room.table = new Table(code, settings, { onChange: () => broadcast(room) });
  rooms.set(code, room);
  return room;
}

function attach(socket, room, playerId, token) {
  detachSocket(socket);
  socket.data.code = room.code;
  socket.data.playerId = playerId;
  socket.join(room.code);
  room.sockets.add(socket);
  room.emptySince = null;
  room.table.setConnected(playerId, true);
  socket.emit('joined', { code: room.code, playerId, token });
  broadcast(room);
}

function detachSocket(socket) {
  const { code, playerId } = socket.data;
  const room = code && rooms.get(code);
  socket.data.code = null;
  socket.data.playerId = null;
  if (!room) return;
  room.sockets.delete(socket);
  socket.leave(code);
  const stillHere = [...room.sockets].some((s) => s.data.playerId === playerId);
  if (playerId && !stillHere) room.table.setConnected(playerId, false);
  if (room.sockets.size === 0) room.emptySince = Date.now();
}

function current(socket) {
  const room = socket.data.code && rooms.get(socket.data.code);
  if (!room || !room.table.players.has(socket.data.playerId)) throw new TableError('You are not at a table.');
  return { room, table: room.table, id: socket.data.playerId };
}

// The name "Marker" needs the secret code. Returns true if this player is the founder.
class CodeNeeded extends TableError {}
function founderCheck(socket, name, ownerCode) {
  if (!isReservedName(name)) return false;
  if (!ownerCode) throw new CodeNeeded('That name is reserved. Enter the secret code to use it.');
  const ip = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
  const result = checkOwner(ip, ownerCode);
  if (result.ok) return true;
  if (result.locked) throw new CodeNeeded('Too many wrong codes. Try again in 10 minutes, or pick another name.');
  throw new CodeNeeded("That code isn't right.");
}

// Wrap every handler so a bad request sends a friendly error instead of crashing.
function handle(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = fn(payload || {});
      reply({ ok: true, ...(result || {}) });
    } catch (err) {
      if (!(err instanceof TableError)) console.error(event, err);
      reply({
        ok: false,
        error: err instanceof TableError ? err.message : 'Something went wrong.',
        ...(err instanceof CodeNeeded ? { needCode: true } : {}),
      });
    }
  });
}

// ---------- socket events ----------

io.on('connection', (socket) => {
  let lastChat = 0;

  handle(socket, 'create', ({ name, settings, ownerCode }) => {
    const clean = cleanName(name);
    const founder = founderCheck(socket, clean, ownerCode);
    const room = makeRoom(settings);
    const playerId = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    room.table.addPlayer(playerId, clean, { founder });
    room.tokens.set(token, playerId);
    attach(socket, room, playerId, token);
    return { code: room.code };
  });

  handle(socket, 'join', ({ code, name, token, ownerCode }) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) throw new TableError("Can't find that table. Check the code?");
    // Coming back after a refresh or lost connection: same seat, same chips.
    if (token && room.tokens.has(token)) {
      const playerId = room.tokens.get(token);
      if (room.table.players.has(playerId)) {
        attach(socket, room, playerId, token);
        return { code: room.code, rejoined: true };
      }
      room.tokens.delete(token);
    }
    const clean = cleanName(name);
    const founder = founderCheck(socket, clean, ownerCode);
    const playerId = crypto.randomBytes(6).toString('hex');
    const newToken = crypto.randomBytes(16).toString('hex');
    room.table.addPlayer(playerId, clean, { founder });
    room.tokens.set(newToken, playerId);
    attach(socket, room, playerId, newToken);
    return { code: room.code };
  });

  handle(socket, 'action', ({ type, amount }) => {
    const { table, id } = current(socket);
    table.act(id, String(type), Number(amount) || 0);
  });

  handle(socket, 'start', () => {
    const { table, id } = current(socket);
    table.start(id);
  });

  handle(socket, 'settings', (settings) => {
    const { table, id } = current(socket);
    table.updateSettings(id, settings);
  });

  handle(socket, 'sitout', ({ value }) => {
    const { table, id } = current(socket);
    table.sitOut(id, !!value);
  });

  handle(socket, 'rebuy', () => {
    const { table, id } = current(socket);
    table.rebuy(id);
  });

  handle(socket, 'chat', ({ text }) => {
    const { table, id } = current(socket);
    const msg = cleanText(text);
    if (!msg) return;
    if (Date.now() - lastChat < 600) throw new TableError('Slow down a little.');
    lastChat = Date.now();
    table.chat(id, msg);
  });

  handle(socket, 'leave', () => {
    const { room, table, id } = current(socket);
    for (const [tok, pid] of room.tokens) if (pid === id) room.tokens.delete(tok);
    detachSocket(socket);
    table.removePlayer(id);
  });

  socket.on('disconnect', () => detachSocket(socket));
});

// Tidy up tables nobody has used for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sockets.size === 0 && room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      room.table.clearTimers();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Black Tie Poker is running on http://localhost:${PORT}`);
});

module.exports = { server, rooms };
