// src/mcp/playwright-mcp.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

type McpClient = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class PlaywrightMcpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightMcpService.name);

  private serverProcess?: ChildProcessWithoutNullStreams;
  private client: McpClient | null = null;
  private connected = false;
  private connecting = false;

  // Cache de tools para ayudar a otros servicios
  private toolsCache: any[] | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const managed =
      this.config.get<string>('PLAYWRIGHT_MCP_MANAGED') === 'true';
    const autoConnect =
      this.config.get<string>('PLAYWRIGHT_MCP_AUTO_CONNECT') !== 'false';

    if (managed) {
      await this.startServerProcess();
    }

    if (autoConnect) {
      await this.safeConnectClient();
      // warmup para abrir Chromium / generar página
      await this.warmupBrowser();
    }
  }

  async onModuleDestroy() {
    try {
      if (this.client && this.connected) {
        await this.client.close?.();
      }
    } catch {}
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.toolsCache = null;

    if (this.serverProcess) {
      this.serverProcess.kill();
    }
  }

  private getPort() {
    return Number(this.config.get('PLAYWRIGHT_MCP_PORT') ?? 8931);
  }

  private getBaseUrl() {
    const base =
      this.config.get<string>('PLAYWRIGHT_MCP_BASE_URL') ??
      `http://localhost:${this.getPort()}`;
    return base.replace(/\/$/, '');
  }

  private getHttpUrl() {
    return new URL(`${this.getBaseUrl()}/mcp`);
  }

  private getSseUrl() {
    return new URL(`${this.getBaseUrl()}/sse`);
  }

  private getCaps() {
    // "vision" o "vision,pdf"
    return this.config.get<string>('PLAYWRIGHT_MCP_CAPS') ?? 'vision';
  }

  private getSnapshotMode() {
    // incremental | full | none
    return this.config.get<string>('PLAYWRIGHT_MCP_SNAPSHOT_MODE') ?? 'full';
  }

  private getConsoleLevel() {
    // error | warning | info | debug
    return this.config.get<string>('PLAYWRIGHT_MCP_CONSOLE_LEVEL') ?? 'debug';
  }

  private getTimeoutAction() {
    return Number(this.config.get('PLAYWRIGHT_MCP_TIMEOUT_ACTION') ?? 15000);
  }

  private getTimeoutNavigation() {
    return Number(
      this.config.get('PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION') ?? 90000,
    );
  }

  private getViewportSize() {
    return (
      this.config.get<string>('PLAYWRIGHT_MCP_VIEWPORT_SIZE') ?? '1280x720'
    );
  }

  private getBlockServiceWorkers() {
    return (
      (this.config.get<string>('PLAYWRIGHT_MCP_BLOCK_SW') ?? 'false') === 'true'
    );
  }

  private extractTools(resp: any): any[] {
    return (
      resp?.tools ??
      resp?.result?.tools ??
      resp?.data?.tools ??
      resp?.payload?.tools ??
      []
    );
  }

  private async startServerProcess() {
    const port = this.getPort();

    // IMPORTANTE: por defecto NO fuerces --browser,
    // o usa "chrome" si querés un canal estable.
    const browser =
      this.config.get<string>('PLAYWRIGHT_MCP_BROWSER') ?? 'chrome';

    const headless =
      (this.config.get<string>('PLAYWRIGHT_MCP_HEADLESS') ?? 'false') ===
      'true';

    const userDataDir =
      this.config.get<string>('PLAYWRIGHT_MCP_USER_DATA_DIR') ??
      path.resolve(process.cwd(), '.pw-profile');

    const warmupUrl =
      this.config.get<string>('PLAYWRIGHT_MCP_WARMUP_URL') ??
      'https://www.linkedin.com/';

    const initPagePath = path.resolve(
      process.cwd(),
      'src/mcp/init-linkedin-page.ts',
    );

    const args: string[] = [
      '--yes',
      '@playwright/mcp@latest',

      '--host',
      'localhost',
      '--port',
      String(port),

      '--user-data-dir',
      userDataDir,
      '--shared-browser-context',

      // Capabilities extra
      '--caps',
      this.getCaps(),

      // Mejor observabilidad
      '--console-level',
      this.getConsoleLevel(),

      // Snapshots más útiles para agentes
      '--snapshot-mode',
      this.getSnapshotMode(),

      // Timeouts más realistas para LinkedIn
      '--timeout-action',
      String(this.getTimeoutAction()),
      '--timeout-navigation',
      String(this.getTimeoutNavigation()),

      // Layout estable
      '--viewport-size',
      this.getViewportSize(),

      // Tu init page
      '--init-page',
      initPagePath,

      // Host checks
      '--allowed-hosts',
      'localhost',
      '127.0.0.1',
    ];

    // Opcional: reducir rarezas de SPAs
    if (this.getBlockServiceWorkers()) {
      args.push('--block-service-workers');
    }


    // Solo agregá --browser si querés canal específico
    if (browser) {
      args.push('--browser', browser);
    }

    if (headless) args.push('--headless');

    this.logger.log(`Starting Playwright MCP server: npx ${args.join(' ')}`);

    this.serverProcess = spawn('npx', args, {
      shell: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        PLAYWRIGHT_MCP_WARMUP_URL: warmupUrl,
      },
    });

    this.serverProcess.stdout.on('data', (d) =>
      this.logger.log(`[mcp] ${String(d).trim()}`),
    );
    this.serverProcess.stderr.on('data', (d) =>
      this.logger.warn(`[mcp] ${String(d).trim()}`),
    );
    this.serverProcess.on('exit', (code) =>
      this.logger.warn(`Playwright MCP exited with code ${code}`),
    );

    // un poco más generoso
    await sleep(4000);
  }

  private async safeConnectClient() {
    try {
      await this.connectClientWithRetry();
    } catch {
      this.connected = false;
      this.connecting = false;
      this.client = null;
      this.logger.warn(
        `MCP not available at startup. App will continue. ` +
          `Start MCP or enable managed mode.`,
      );
    }
  }

  private async connectClientWithRetry() {
    const attempts = 4;
    let lastErr: any;

    for (let i = 0; i < attempts; i++) {
      try {
        await this.connectClient();
        if (this.connected) return;
      } catch (e) {
        lastErr = e;
        await sleep(300 * (i + 1));
      }
    }
    throw lastErr ?? new Error('MCP connection failed');
  }

  private async connectClient() {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    try {
      const { Client } =
        await import('@modelcontextprotocol/sdk/client/index.js');

      const client = new Client(
        { name: 'andeshire-playwright-client', version: '0.1.0' },
        { capabilities: {} },
      );

      // 1) Intentar Streamable HTTP -> /mcp
      try {
        const mod =
          await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const transport = new mod.StreamableHTTPClientTransport(
          this.getHttpUrl(),
        );
        await client.connect(transport);

        this.client = client;
        this.connected = true;
        this.logger.log(
          `Connected to Playwright MCP (HTTP) at ${this.getHttpUrl()}`,
        );
        return;
      } catch (httpErr) {
        // 2) Fallback SSE -> /sse
        const mod = await import('@modelcontextprotocol/sdk/client/sse.js');
        const transport = new mod.SSEClientTransport(this.getSseUrl());
        await client.connect(transport);

        this.client = client;
        this.connected = true;
        this.logger.log(
          `Connected to Playwright MCP (SSE) at ${this.getSseUrl()}`,
        );
        return;
      }
    } catch (err) {
      this.client = null;
      this.connected = false;
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private async ensureConnected() {
    if (this.connected) return;
    await this.connectClientWithRetry();
  }

  async listTools() {
    await this.ensureConnected();
    const c: any = this.client!;

    let res: any;
    try {
      // Algunas versiones nuevas aceptan objeto
      res = await c.listTools({});
    } catch {
      // Otras siguen sin args
      res = await c.listTools();
    }

    this.toolsCache = this.extractTools(res);
    return res;
  }

  async callTool(name: string, args: unknown = {}) {
    await this.ensureConnected();
    const c: any = this.client!;

    // Firma nueva preferida
    try {
      return await c.callTool({ name, arguments: args });
    } catch {
      // Fallback firma vieja
      return await c.callTool(name, args);
    }
  }

  private async warmupBrowser() {
    try {
      const res = await this.listTools();
      const tools = this.extractTools(res);

      // Si existe navigate, lo usamos para forzar apertura de ventana
      const hasNavigate = tools.some(
        (t: any) => t?.name === 'browser_navigate',
      );

      if (hasNavigate) {
        const url =
          this.config.get<string>('PLAYWRIGHT_MCP_WARMUP_URL') ??
          'https://www.linkedin.com/';
        await this.callTool('browser_navigate', { url });
        this.logger.log(`Warmup navigate OK -> ${url}`);
      }
    } catch (e: any) {
      this.logger.warn(`Warmup failed: ${e?.message ?? e}`);
    }
  }

  // Helper opcional para otros servicios
  getCachedTools() {
    return this.toolsCache ?? [];
  }
}
