import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { StreamService } from './stream.service';
import type { InputEvent, SessionId } from './stream.types';

@WebSocketGateway({
  namespace: '/api/zion/stream',
  path: '/api/zion/socket.io',
  cors: {
    origin: [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      /^http:\/\/localhost:\d+$/,
      /^https?:\/\/.*$/,
    ],
    methods: ['GET', 'POST'],
  },
})
export class StreamGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamGateway.name);

  @WebSocketServer()
  server!: Server;

  private timers = new Map<string, NodeJS.Timeout>();
  private clientSession = new Map<string, SessionId>();

  constructor(private readonly streamService: StreamService) {}

  handleConnection(client: Socket) {
    const rawFps = client.handshake.query?.fps;
    const fpsNum = Array.isArray(rawFps) ? rawFps[0] : rawFps;
    const fps = Math.max(1, Math.min(10, Number(fpsNum ?? 2)));
    const intervalMs = Math.max(200, Math.floor(1000 / fps));

    const rawSession = client.handshake.query?.sessionId;
    const sessionIdRaw = Array.isArray(rawSession) ? rawSession[0] : rawSession;
    const sessionId: SessionId =
      (sessionIdRaw && String(sessionIdRaw)) || 'default';

    this.clientSession.set(client.id, sessionId);

    this.logger.log(
      `Client connected ${client.id} (fps=${fps}, sessionId=${sessionId})`,
    );

    // ✅ INPUT: the key feature
    client.on('input', async (ev: InputEvent, ack?: (res: any) => void) => {
      const sid = this.clientSession.get(client.id) ?? 'default';
      try {
        await this.streamService.dispatchInput(sid, ev);
        ack?.({ ok: true });
      } catch (err: any) {
        ack?.({ ok: false, message: err?.message ?? 'input failed' });
      }
    });

    // warm first frame
    this.streamService.getScreenshotBase64(sessionId).catch(() => {});

    const timer = setInterval(async () => {
      try {
        const { data, mimeType } =
          await this.streamService.getScreenshotBase64(sessionId);
        client.emit('frame', { data, mimeType, ts: Date.now() });
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
    this.clientSession.delete(client.id);
    this.logger.log(`Client disconnected ${client.id}`);
  }
}
