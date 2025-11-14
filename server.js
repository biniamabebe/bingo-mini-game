const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.redirect('/public/host.html'));
app.get('/join', (_, res) => res.redirect('/public/player.html'));

const games = new Map();
let activeGameId = null;

function normalizeCode(value) {
  return (value || '').toString().trim().toUpperCase();
}

function createCode(length = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function createCard() {
  const columns = [];
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];

  for (const [min, max] of ranges) {
    const pool = new Set();
    while (pool.size < 5) {
      pool.add(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    columns.push([...pool]);
  }

  const marked = Array.from({ length: 5 }, () => Array(5).fill(false));
  columns[2][2] = 'FREE';
  marked[2][2] = true;

  return { numbers: columns, marked };
}

function hasBingo(marked) {
  for (let r = 0; r < 5; r += 1) {
    if (marked[r].every(Boolean)) return true;
  }
  for (let c = 0; c < 5; c += 1) {
    if (marked.every(row => row[c])) return true;
  }
  if (marked.every((row, idx) => row[idx])) return true;
  if (marked.every((row, idx) => row[4 - idx])) return true;
  return false;
}

function newGameState(code, hostSocketId) {
  return {
    id: code,
    hostSocketId,
    players: new Map(),
    started: false,
    closed: false,
    winner: null,
    numbers: Array.from({ length: 75 }, (_, i) => i + 1),
    drawn: [],
    current: null,
    interval: null
  };
}

function setActiveGame(code) {
  activeGameId = code ? normalizeCode(code) : null;
  io.emit('game:available', { gameId: activeGameId });
}

function emitMeta(game) {
  io.to(game.id).emit('state:meta', {
    started: game.started,
    closed: game.closed,
    winner: game.winner,
    drawnCount: game.drawn.length,
    current: game.current
  });
}

function emitPlayers(game) {
  const players = [...game.players.values()].map(player => ({
    id: player.id,
    name: player.name,
    disqualified: player.disqualified
  }));
  io.to(game.id).emit('state:players', players);
}

function drawNumber(game) {
  const remaining = game.numbers.filter(n => !game.drawn.includes(n));
  if (!remaining.length) return null;
  const selection = remaining[Math.floor(Math.random() * remaining.length)];
  game.drawn.push(selection);
  game.current = selection;
  io.to(game.id).emit('number:drawn', { number: selection, drawn: game.drawn });
  emitMeta(game);
  return selection;
}

function startAutoDraw(game, intervalMs = 3000) {
  if (game.interval) clearInterval(game.interval);
  game.interval = setInterval(() => {
    if (!game.started || game.closed) return;
    if (game.drawn.length >= 75) {
      stopAutoDraw(game);
      return;
    }
    drawNumber(game);
  }, intervalMs);
}

function stopAutoDraw(game) {
  if (game.interval) {
    clearInterval(game.interval);
    game.interval = null;
  }
  game.started = false;
  emitMeta(game);
}

function closeGame(game, winner) {
  game.closed = true;
  game.winner = winner;
  stopAutoDraw(game);
  io.to(game.id).emit('game:winner', winner);
  emitMeta(game);
  setActiveGame(null);
}

app.get('/debug/games', (_, res) => {
  res.json({ games: [...games.keys()] });
});

app.get('/debug/game/:id', (req, res) => {
  const code = normalizeCode(req.params.id);
  const game = games.get(code);
  if (!game) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({
    id: game.id,
    started: game.started,
    closed: game.closed,
    winner: game.winner,
    drawn: game.drawn.length,
    players: [...game.players.values()].map(p => ({ id: p.id, name: p.name, dq: p.disqualified }))
  });
});

io.engine.on('connection_error', err => {
  console.error('[SOCKET.IO CONNECTION ERROR]', err);
});

io.on('error', err => {
  console.error('[SOCKET.IO ERROR]', err);
});

io.on('connection', socket => {
  socket.emit('game:available', { gameId: activeGameId });

  socket.on('host:create', ack => {
    const code = normalizeCode(createCode());
    const game = newGameState(code, socket.id);
    games.set(code, game);
    socket.join(code);
    if (typeof ack === 'function') ack({ ok: true, gameId: code });
    emitMeta(game);
    emitPlayers(game);
    setActiveGame(code);
  });

  socket.on('host:join', ({ gameId }, ack) => {
    const code = normalizeCode(gameId);
    const game = games.get(code);
    if (!game) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Game not found' });
      return;
    }
    game.hostSocketId = socket.id;
    socket.join(code);
    if (typeof ack === 'function') ack({ ok: true, gameId: code });
    emitMeta(game);
    emitPlayers(game);
    if (!game.closed) setActiveGame(code);
  });

  socket.on('host:start', ({ gameId }, ack) => {
    const code = normalizeCode(gameId);
    const game = games.get(code);
    if (!game) return void (typeof ack === 'function' && ack({ ok: false, error: 'Game not found' }));
    if (game.closed) return void (typeof ack === 'function' && ack({ ok: false, error: 'Game already ended' }));
    if (!game.players.size) return void (typeof ack === 'function' && ack({ ok: false, error: 'No players' }));

    game.started = true;
    emitMeta(game);
    setTimeout(() => {
      if (game.started && !game.closed) drawNumber(game);
    }, 400);
    startAutoDraw(game);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('host:stop', ({ gameId }, ack) => {
    const game = games.get(normalizeCode(gameId));
    if (!game) return void (typeof ack === 'function' && ack({ ok: false, error: 'Game not found' }));
    stopAutoDraw(game);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('host:reset', ({ gameId }, ack) => {
    const code = normalizeCode(gameId);
    const current = games.get(code);
    if (!current) return void (typeof ack === 'function' && ack({ ok: false, error: 'Game not found' }));
    if (current.interval) clearInterval(current.interval);
    const fresh = newGameState(code, current.hostSocketId);
    games.set(code, fresh);
    io.to(code).emit('game:reset');
    emitMeta(fresh);
    emitPlayers(fresh);
    if (typeof ack === 'function') ack({ ok: true });
    setActiveGame(code);
  });

  socket.on('player:join', ({ gameId, name }, ack) => {
    const requested = normalizeCode(gameId);
    const resolved = requested || activeGameId;
    const game = resolved ? games.get(resolved) : null;
    if (!game) return void (typeof ack === 'function' && ack({ ok: false, error: 'Waiting for host to start a game' }));
    if (game.closed) return void (typeof ack === 'function' && ack({ ok: false, error: 'Game already ended' }));

    const cleanName = (name || '').trim().slice(0, 20);
    if (!cleanName) return void (typeof ack === 'function' && ack({ ok: false, error: 'Name required' }));
    const duplicate = [...game.players.values()].some(player => player.name.toLowerCase() === cleanName.toLowerCase());
    if (duplicate) return void (typeof ack === 'function' && ack({ ok: false, error: 'Name already taken' }));

    const card = createCard();
    const player = {
      id: socket.id,
      name: cleanName,
      card,
      disqualified: false
    };
    game.players.set(socket.id, player);
    socket.join(game.id);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        card,
        drawn: game.drawn,
        started: game.started,
        closed: game.closed,
        winner: game.winner,
        gameId: game.id
      });
    }
    emitPlayers(game);
    emitMeta(game);
  });

  socket.on('player:mark', ({ gameId, row, col }, ack) => {
    const game = games.get(normalizeCode(gameId));
    if (!game || game.closed || !game.started) return void (typeof ack === 'function' && ack({ ok: false }));
    const player = game.players.get(socket.id);
    if (!player || player.disqualified) return void (typeof ack === 'function' && ack({ ok: false }));

    const value = player.card.numbers[col][row];
    if (value === 'FREE') return void (typeof ack === 'function' && ack({ ok: true }));
    if (!game.drawn.includes(value)) return void (typeof ack === 'function' && ack({ ok: false, error: 'Number not drawn' }));
    if (player.card.marked[row][col]) return void (typeof ack === 'function' && ack({ ok: true }));

    player.card.marked[row][col] = true;
    if (hasBingo(player.card.marked) && !game.closed) {
      const winner = { id: player.id, name: player.name, timeISO: new Date().toISOString() };
      closeGame(game, winner);
    }
    if (typeof ack === 'function') ack({ ok: true });
    emitPlayers(game);
    emitMeta(game);
  });

  socket.on('player:claim', ({ gameId }, ack) => {
    const game = games.get(normalizeCode(gameId));
    if (!game || game.closed || !game.started) return void (typeof ack === 'function' && ack({ ok: false }));
    const player = game.players.get(socket.id);
    if (!player) return void (typeof ack === 'function' && ack({ ok: false }));

    if (hasBingo(player.card.marked)) {
      if (!game.closed) {
        const winner = { id: player.id, name: player.name, timeISO: new Date().toISOString() };
        closeGame(game, winner);
      }
      if (typeof ack === 'function') ack({ ok: true, valid: true, winner: game.winner });
    } else {
      player.disqualified = true;
      emitPlayers(game);
      if (typeof ack === 'function') ack({ ok: true, valid: false, disqualified: true });
    }
  });

  socket.on('disconnect', () => {
    for (const game of games.values()) {
      if (game.players.delete(socket.id)) {
        emitPlayers(game);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.on('error', err => {
  console.error('[HTTP SERVER ERROR]', err);
  if (err.code === 'EADDRINUSE') {
    console.error('Port in use. Set PORT env or stop the other process.');
    process.exit(1);
  }
});

process.on('unhandledRejection', reason => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
});
