import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { GameEngine } from '../engine';
import {
  BetActionMessage,
  ClientToServerEvents,
  ComboSubmitMessage,
  ComboUpdateMessage,
  JoinTableMessage,
  SeatTakeMessage,
  ServerToClientEvents,
} from '../shared/types';

const app = fastify({ logger: false });
const engine = new GameEngine();

const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
  cors: { origin: true },
});

const socketToPlayer = new Map<string, string>();
const playerToSocket = new Map<string, string>();

engine.onBroadcast((event) => {
  switch (event.type) {
    case 'snapshot':
      io.emit('table_snapshot', event.snapshot);
      break;
    case 'private': {
      const socketId = playerToSocket.get(event.playerId);
      if (socketId) {
        io.to(socketId).emit('player_private_state', event.state);
      }
      break;
    }
    case 'result':
      io.emit('hand_result', event.result);
      break;
    case 'error':
      if (event.playerId) {
        const socketId = playerToSocket.get(event.playerId);
        if (socketId) io.to(socketId).emit('error', event.message);
      } else {
        io.emit('error', event.message);
      }
      break;
  }
});

io.on('connection', (socket) => {
  socket.on('join_table', (payload: JoinTableMessage) => {
    if (!payload.username || payload.username.trim().length === 0) {
      socket.emit('error', 'Username required');
      return;
    }
    const playerId = socket.id;
    socketToPlayer.set(socket.id, playerId);
    playerToSocket.set(playerId, socket.id);
    engine.join(playerId, payload.username.trim());
  });

  socket.on('seat_take', (payload: SeatTakeMessage) => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.seatTake(playerId, payload.seatIndex);
  });

  socket.on('seat_leave', () => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.seatLeave(playerId);
  });

  socket.on('start_hand', () => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.startHand(playerId);
  });

  socket.on('bet_action', (payload: BetActionMessage) => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.betAction(playerId, payload);
  });

  socket.on('combo_update', (payload: ComboUpdateMessage) => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.comboUpdate(playerId, payload);
  });

  socket.on('combo_submit', (payload: ComboSubmitMessage) => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.comboSubmit(playerId, payload);
  });

  socket.on('disconnect', () => {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;
    engine.seatLeave(playerId);
    socketToPlayer.delete(socket.id);
    playerToSocket.delete(playerId);
  });
});

app.get('/health', async () => ({ status: 'ok' }));

const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.register(fastifyStatic, {
    root: clientDist,
    prefix: '/',
  });
  app.setNotFoundHandler((_, reply) => {
    reply.type('text/html').send(fs.readFileSync(path.join(clientDist, 'index.html'), 'utf-8'));
  });
}

const PORT = Number(process.env.PORT || 3000);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`Server listening on http://localhost:${PORT}`);
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });
