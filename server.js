const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname)));

const rooms = {};
let nextRoomId = 1;
const OBSTACLE_EMOJIS = ['🌵','🚧','🪨','🛢️','🗑️'];

function createRoom() {
  const id = 'room_' + (nextRoomId++);
  rooms[id] = {
    players: [null, null],
    objects: [],
    speed: 1.2,
    distance: 0,
    spawnTimer: 60,
    coinTimer: 80,
    running: false,
    loopHandle: null,
    lastTick: 0
  };
  return id;
}

function findRoomWithSlot() {
  for (const id in rooms) {
    const r = rooms[id];
    if (r.players[0] === null || r.players[1] === null) return id;
  }
  return createRoom();
}

function createObject(type) {
  const t = type || (Math.random() < 0.65 ? 'obstacle' : 'coin');
  const emoji = t === 'coin' ? '🪙'
    : OBSTACLE_EMOJIS[Math.floor(Math.random() * OBSTACLE_EMOJIS.length)];
  const size = t === 'coin' ? 40 : 64;
  return {
    id: Math.random().toString(36).slice(2, 10),
    type: t, emoji,
    lane: Math.floor(Math.random() * 3),
    y: -90, w: size, h: size
  };
}

function startLoop(roomId) {
  const room = rooms[roomId];
  if (!room || room.loopHandle) return;
  room.lastTick = Date.now();

  const tick = () => {
    const r = rooms[roomId];
    if (!r) return;

    const now = Date.now();
    const dt = Math.min(50, now - r.lastTick) / 16.67;
    r.lastTick = now;

    if (r.running) {
      r.speed = Math.min(4, 1.2 + r.distance * 0.008);
      r.spawnTimer -= dt;
      r.coinTimer -= dt;
      if (r.spawnTimer <= 0) {
        r.objects.push(createObject('obstacle'));
        r.spawnTimer = Math.max(110, 200 - r.distance * 0.2) + Math.random() * 60;
      }
      if (r.coinTimer <= 0 && Math.random() < 0.3) {
        r.objects.push(createObject('coin'));
        r.coinTimer = 60 + Math.random() * 60;
      }
      r.objects.forEach(o => { o.y += r.speed * dt; });
      r.objects = r.objects.filter(o => o.y < 2000);
      r.distance += r.speed * dt * 0.06;
    }

    io.to(roomId).emit('state', {
      objects: r.objects,
      speed: r.speed,
      distance: Math.floor(r.distance),
      players: r.players.map(p => p ? {
        lane: p.lane, jumping: p.jumping, coins: p.coins, alive: p.alive
      } : null)
    });

    // 同步频率从 33ms 降到 50ms，减轻网络和服务端压力
    r.loopHandle = setTimeout(tick, 50);
  };
  tick();
}

io.on('connection', (socket) => {
  socket.on('join', () => {
    const roomId = findRoomWithSlot();
    const room = rooms[roomId];
    const slot = room.players[0] === null ? 0 : 1;
    room.players[slot] = {
      id: socket.id, lane: 1, jumping: false, coins: 0, alive: true
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.slot = slot;
    socket.emit('joined', { roomId, slot });

    const filled = room.players.filter(p => p).length;
    if (filled === 2) {
      room.running = true;
      io.to(roomId).emit('ready');
      startLoop(roomId);
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('move', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[socket.slot];
    if (!p) return;
    p.lane = data.lane;
    p.jumping = data.jumping;
  });

  socket.on('eat-coin', (coinId) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[socket.slot];
    if (!p) return;
    const idx = room.objects.findIndex(o => o.id === coinId);
    if (idx >= 0) {
      room.objects.splice(idx, 1);
      p.coins += 1;
    }
  });

  socket.on('hit-obstacle', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.running) return;
    const p = room.players[socket.slot];
    if (!p || !p.alive) return;
    p.alive = false;
    room.running = false;
    io.to(socket.roomId).emit('gameover', {
      byPlayer: socket.slot,
      distance: Math.floor(room.distance),
      coins: room.players.map(pp => pp ? pp.coins : 0)
    });
  });

  socket.on('restart', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.objects = [];
    room.speed = 1.2;
    room.distance = 0;
    room.spawnTimer = 60;
    room.coinTimer = 80;
    room.players.forEach(p => {
      if (p) { p.coins = 0; p.alive = true; p.jumping = false; p.lane = 1; }
    });
    room.running = true;
    room.lastTick = Date.now();
    io.to(socket.roomId).emit('restart');
    if (!room.loopHandle) startLoop(socket.roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      socket.to(roomId).emit('partner-left');
      for (let i = 0; i < 2; i++) {
        if (room.players[i] && room.players[i].id === socket.id) room.players[i] = null;
      }
      if (!room.players[0] && !room.players[1]) {
        if (room.loopHandle) clearTimeout(room.loopHandle);
        delete rooms[roomId];
      } else {
        room.running = false;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('服务器运行在端口 ' + PORT);
});
