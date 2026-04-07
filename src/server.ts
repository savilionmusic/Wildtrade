import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { AgentName, SocketPayload, SocketEventType } from '@wildtrade/shared';

let io: SocketIOServer | null = null;

export function createSocketServer(): { httpServer: ReturnType<typeof createServer>; io: SocketIOServer } {
  const httpServer = createServer();
  const port = parseInt(process.env.SOCKET_IO_PORT || '3001', 10);
  const corsOrigin = process.env.SOCKET_IO_CORS_ORIGIN || 'http://localhost:3000';

  io = new SocketIOServer(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`[server] Client connected: ${socket.id}`);

    socket.on('command:status', () => {
      console.log('[server] Status request from client');
    });

    socket.on('disconnect', () => {
      console.log(`[server] Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(port, () => {
    console.log(`[server] Socket.IO listening on port ${port}`);
  });

  return { httpServer, io };
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function broadcast<T>(event: SocketEventType, agent: AgentName, data: T): void {
  if (!io) return;
  const payload: SocketPayload<T> = {
    event,
    agent,
    timestamp: Date.now(),
    data,
  };
  io.emit(event, payload);
}
