// src/stream/stream.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightMcpService } from '../mcp/playwright-mcp.service';

type SessionId = string;

type ScreenshotResult = { data: string; mimeType: string };
type CachedScreenshot = ScreenshotResult & { ts: number };

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  private screenshotToolName: string | null = null;

  // Cache por sesión
  private lastFrames = new Map<SessionId, CachedScreenshot>();
  private inFlight = new Map<SessionId, Promise<ScreenshotResult>>();

  constructor(private readonly mcp: PlaywrightMcpService) {}

  private extractTools(resp: any): any[] {
    return (
      resp?.tools ??
      resp?.result?.tools ??
      resp?.data?.tools ??
      resp?.payload?.tools ??
      []
    );
  }

  private async resolveScreenshotToolName(): Promise<string> {
    if (this.screenshotToolName) return this.screenshotToolName;

    let name = 'browser_take_screenshot';

    try {
      // Usamos sesión "default" porque la lista de tools es global
      const res = await this.mcp.listTools();
      const tools = this.extractTools(res);

      const found = tools.find(
        (t: any) =>
          typeof t?.name === 'string' &&
          t.name.toLowerCase().includes('screenshot'),
      );

      if (found?.name) name = found.name;
    } catch {}

    this.screenshotToolName = name;
    this.logger.log(`Using screenshot tool: ${name}`);

    return name;
  }

  private extractImageContent(resp: any): ScreenshotResult | null {
    const content =
      resp?.content ?? resp?.result?.content ?? resp?.data?.content ?? [];

    const img = Array.isArray(content)
      ? content.find(
          (c: any) => c?.type === 'image' && typeof c?.data === 'string',
        )
      : null;

    if (img) {
      return {
        data: img.data,
        mimeType: img.mimeType ?? 'image/png',
      };
    }

    if (typeof resp?.data === 'string') {
      return { data: resp.data, mimeType: 'image/png' };
    }

    return null;
  }

  async getScreenshotBase64(
    sessionId: SessionId = 'default',
  ): Promise<ScreenshotResult> {
    // Evita tormenta de screenshots si hay varios consumidores a la vez
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    const promise = (async () => {
      const toolName = await this.resolveScreenshotToolName();

      const args = {
        type: 'jpeg',
        fullPage: false,
      };

      // IMPORTANT: ahora usamos la sesión específica
      const res = await this.mcp.callTool(sessionId, toolName, args);
      const img = this.extractImageContent(res);

      if (!img) {
        throw new Error('MCP screenshot tool did not return image content');
      }

      this.lastFrames.set(sessionId, { ...img, ts: Date.now() });
      return img;
    })();

    this.inFlight.set(sessionId, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  async getCachedScreenshotBase64(
    sessionId: SessionId = 'default',
    maxAgeMs = 800,
  ): Promise<ScreenshotResult> {
    const last = this.lastFrames.get(sessionId);

    if (last && Date.now() - last.ts <= maxAgeMs) {
      const { data, mimeType } = last;
      return { data, mimeType };
    }

    return this.getScreenshotBase64(sessionId);
  }
}
