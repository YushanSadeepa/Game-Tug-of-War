/**
 * ==========================================================================
 *  Online Tug-of-War (කඹ ඇදීමේ තරගය) — Backend Server
 * ==========================================================================
 *  Stack   : Node.js + Express + Socket.io + CORS
 *  Purpose : Authoritative game server, deployed independently from the
 *            frontend (which now lives in its own /frontend folder and is
 *            served from a different origin/port). CORS is enabled so the
 *            browser is allowed to open a cross-origin Socket.io connection
 *            to this server.
 *
 *  Responsibilities:
 *    - Room/Lobby management: the first 2 connecting sockets are assigned to
 *      the Red and Blue teams; every socket after that becomes a Spectator.
 *    - Once BOTH Red and Blue are connected, a 3-2-1 countdown is triggered
 *      automatically and the round begins.
 *    - Simulates rope physics (position -100..100), detects win conditions.
 *    - Handles full game lifecycle: waiting -> countdown -> playing -> finished.
 *    - Resets the room and promotes a waiting spectator if an active player
 *      disconnects mid-game.
 * ==========================================================================
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();

// --------------------------------------------------------------------------
// CORS CONFIGURATION
// --------------------------------------------------------------------------
// The frontend is now a completely separate app (its own folder, its own
// port/origin), so we must explicitly allow cross-origin requests.
// Adjust `origin` to a specific frontend URL in production instead of '*'.
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
};

app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);

// Socket.io needs its own CORS configuration — it does not inherit Express's.
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// Simple health-check / info route since this backend no longer serves any
// static frontend files.
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Online Tug-of-War backend',
    socketIoPath: '/socket.io/socket.io.js',
    room: room.id,
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: process.uptime() });
});

// --------------------------------------------------------------------------
// GAME CONSTANTS
// --------------------------------------------------------------------------
const MIN_POSITION = -100; // Rope fully pulled to RED side  -> Red wins
const MAX_POSITION = 100; // Rope fully pulled to BLUE side -> Blue wins
const PULL_IMPULSE = 3; // How far one "pull" moves the rope
const PULL_COOLDOWN_MS = 55; // Per-player anti-spam debounce
const COUNTDOWN_SECONDS = 3; // 3, 2, 1, ආරම්භය!
const PULL_FLAG_RESET_MS = 220; // How long the "isPulling" animation flag lasts
const RESTART_DELAY_MS = 350; // Small delay before a fresh round begins

// --------------------------------------------------------------------------
// ROOM / LOBBY STATE
// --------------------------------------------------------------------------
// This demo runs a single shared room/lobby. The structure is intentionally
// self-contained so it could be lifted into a Map<roomId, Room> to support
// many simultaneous matches without touching the game logic itself.
function createRoom() {
  return {
    id: 'main-room',
    state: 'waiting', // 'waiting' | 'countdown' | 'playing' | 'finished'
    position: 0, // -100 .. 100
    winner: null, // 'red' | 'blue' | null
    wins: { red: 0, blue: 0 }, // persists across rounds (resets on server restart)
    players: { red: null, blue: null }, // holds socket.id or null
    spectators: new Set(), // set of socket.id
    lastPullAt: { red: 0, blue: 0 }, // debounce timestamps
    pulling: { red: false, blue: false }, // drives client-side pull animation
    pullingTimeouts: { red: null, blue: null },
    countdownValue: COUNTDOWN_SECONDS,
    countdownTimer: null,
  };
}

const room = createRoom();

function bothPlayersConnected() {
  return Boolean(room.players.red) && Boolean(room.players.blue);
}

// Snapshot sent to all clients on every state change.
function publicState() {
  return {
    state: room.state,
    position: room.position,
    winner: room.winner,
    wins: room.wins,
    countdownValue: room.countdownValue,
    pulling: room.pulling,
    players: {
      redConnected: Boolean(room.players.red),
      blueConnected: Boolean(room.players.blue),
    },
    spectatorCount: room.spectators.size,
    serverTime: Date.now(),
  };
}

function broadcastState() {
  io.to(room.id).emit('state', publicState());
}

function clearCountdown() {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
}

function resetRound(nextState) {
  clearCountdown();
  room.position = 0;
  room.winner = null;
  room.pulling.red = false;
  room.pulling.blue = false;
  room.countdownValue = COUNTDOWN_SECONDS;
  room.state = nextState;
}

// --- Lobby rule: auto-trigger the 3-2-1 countdown once both seats are filled
function maybeStartCountdown() {
  if (bothPlayersConnected() && room.state === 'waiting') {
    startCountdown();
  }
}

function startCountdown() {
  clearCountdown();
  room.state = 'countdown';
  room.countdownValue = COUNTDOWN_SECONDS;
  broadcastState();

  room.countdownTimer = setInterval(() => {
    room.countdownValue -= 1;

    if (room.countdownValue <= 0) {
      clearCountdown();
      // Safety check: if someone left during the countdown, abort to waiting.
      if (!bothPlayersConnected()) {
        resetRound('waiting');
        broadcastState();
        return;
      }
      room.state = 'playing';
      room.position = 0;
      broadcastState();
    } else {
      broadcastState();
    }
  }, 1000);
}

function endGame(winnerColor) {
  room.state = 'finished';
  room.winner = winnerColor;
  room.wins[winnerColor] += 1;
  clearCountdown();
  broadcastState();
}

// Core physics: one authoritative pull impulse per valid request.
function handlePull(socket, color) {
  if (room.state !== 'playing') return;
  if (room.players[color] !== socket.id) return; // spoof / stale-role guard

  const now = Date.now();
  if (now - room.lastPullAt[color] < PULL_COOLDOWN_MS) return;
  room.lastPullAt[color] = now;

  // Red pulls the rope toward negative territory (their side, left).
  // Blue pulls the rope toward positive territory (their side, right).
  const direction = color === 'red' ? -1 : 1;
  room.position += direction * PULL_IMPULSE;
  room.position = Math.max(MIN_POSITION, Math.min(MAX_POSITION, room.position));

  // Flag this color as "actively pulling" for a brief window so clients can
  // trigger the leaning/pulling animation and sound effect.
  room.pulling[color] = true;
  if (room.pullingTimeouts[color]) clearTimeout(room.pullingTimeouts[color]);
  room.pullingTimeouts[color] = setTimeout(() => {
    room.pulling[color] = false;
    broadcastState();
  }, PULL_FLAG_RESET_MS);

  if (room.position <= MIN_POSITION) {
    room.position = MIN_POSITION;
    endGame('red');
    return;
  }
  if (room.position >= MAX_POSITION) {
    room.position = MAX_POSITION;
    endGame('blue');
    return;
  }

  broadcastState();
}

// Disconnect handling: free the slot, reset the round (per spec), and try to
// immediately promote a waiting spectator into the empty seat.
function freeSlotAndMaybePromote(color) {
  room.players[color] = null;

  resetRound('waiting');

  const nextSpectator = room.spectators.values().next();
  if (!nextSpectator.done) {
    const promotedId = nextSpectator.value;
    room.spectators.delete(promotedId);
    room.players[color] = promotedId;
    const promotedSocket = io.sockets.sockets.get(promotedId);
    if (promotedSocket) {
      promotedSocket.emit('role', { role: color });
    }
  }

  broadcastState();
  maybeStartCountdown();
}

// --------------------------------------------------------------------------
// SOCKET.IO CONNECTION HANDLING
// --------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.join(room.id);

  // --- Room/Lobby: dynamic role assignment -------------------------------
  // First socket -> Red, second socket -> Blue, everyone else -> Spectator.
  let assignedRole = 'spectator';
  if (!room.players.red) {
    room.players.red = socket.id;
    assignedRole = 'red';
  } else if (!room.players.blue) {
    room.players.blue = socket.id;
    assignedRole = 'blue';
  } else {
    room.spectators.add(socket.id);
    assignedRole = 'spectator';
  }

  socket.emit('role', { role: assignedRole });
  broadcastState();

  // Lobby rule: as soon as both Red and Blue are present, auto-start countdown.
  maybeStartCountdown();

  // --- Gameplay events -----------------------------------------------------
  socket.on('pull', (data) => {
    const color = data && data.role;
    if (color === 'red' || color === 'blue') {
      handlePull(socket, color);
    }
  });

  socket.on('restart', () => {
    if (room.state !== 'finished') return;
    setTimeout(() => {
      resetRound('waiting');
      broadcastState();
      maybeStartCountdown();
    }, RESTART_DELAY_MS);
  });

  // --- Disconnects -----------------------------------------------------
  socket.on('disconnect', () => {
    if (room.players.red === socket.id) {
      freeSlotAndMaybePromote('red');
    } else if (room.players.blue === socket.id) {
      freeSlotAndMaybePromote('blue');
    } else {
      room.spectators.delete(socket.id);
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`🏆  Online Tug-of-War backend running on http://localhost:${PORT}`);
  console.log(`    CORS enabled — frontend can connect from any origin.`);
});
