// src/stream/stream.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { StreamService } from './stream.service';

@WebSocketGateway({
  namespace: '/stream',
  cors: {
    origin: [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      /^http:\/\/localhost:\d+$/,
    ],
    methods: ['GET', 'POST'],
  },
})
export class StreamGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamGateway.name);

  @WebSocketServer()
  server!: Server;

  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly streamService: StreamService) {}

  handleConnection(client: Socket) {
    // fps por querystring: io(".../stream", { query: { fps: "2" } })
    const rawFps = client.handshake.query?.fps;
    const fpsNum = Array.isArray(rawFps) ? rawFps[0] : rawFps;
    const fps = Math.max(1, Math.min(10, Number(fpsNum ?? 2)));

    const intervalMs = Math.max(200, Math.floor(1000 / fps));

    this.logger.log(`Client connected ${client.id} (fps=${fps})`);
    this.streamService.getScreenshotBase64().catch(() => {});

    const timer = setInterval(async () => {
      try {
        const { data, mimeType } =
          await this.streamService.getScreenshotBase64();
        client.emit('frame', {
          data,
          mimeType,
          ts: Date.now(),
        });
      } catch (err: any) {
        client.emit('frame_error', {
          message: err?.message ?? 'Unknown streaming error',
        });
      }
    }, intervalMs);

    this.timers.set(client.id, timer);
  }

  handleDisconnect(client: Socket) {
    const timer = this.timers.get(client.id);
    if (timer) clearInterval(timer);
    this.timers.delete(client.id);

    this.logger.log(`Client disconnected ${client.id}`);
  }
}
