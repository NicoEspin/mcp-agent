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

type SessionId = string;

interface McpSession {
  client: McpClient | null;
  connected: boolean;
  connecting: boolean;
  lastUsedAt: number;
}

@Injectable()
export class PlaywrightMcpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightMcpService.name);

  // Sesión por defecto (compat con tu código actual)
  private readonly DEFAULT_SESSION_ID: SessionId = 'default';

  // 🧠 Ahora manejamos múltiples sesiones
  private sessions = new Map<SessionId, McpSession>();

  private callSignature: 'old' | 'new' = 'old';
  private serverProcess?: ChildProcessWithoutNullStreams;

  // Cache de tools para el servidor (compartido entre sesiones)
  private toolsCache: any[] | null = null;

  constructor(private readonly config: ConfigService) {}

  // ----------------------------------------------------
  // Ciclo de vida Nest
  // ----------------------------------------------------
  async onModuleInit() {
    const managed =
      this.config.get<string>('PLAYWRIGHT_MCP_MANAGED') === 'true';
    const autoConnect =
      this.config.get<string>('PLAYWRIGHT_MCP_AUTO_CONNECT') !== 'false';

    if (managed) {
      await this.startServerProcess();
    }

    if (autoConnect) {
      // 🔥 Conectamos y calentamos la sesión por defecto
      await this.safeConnectSession(this.DEFAULT_SESSION_ID);
      await this.warmupBrowser(this.DEFAULT_SESSION_ID);
    }
  }

  async onModuleDestroy() {
    // Cerramos todos los clientes MCP existentes
    for (const [id, session] of this.sessions.entries()) {
      try {
        if (session.client && session.connected) {
          await session.client.close?.();
        }
      } catch {
        // ignoramos errores en shutdown
      }
    }

    this.sessions.clear();
    this.toolsCache = null;

    if (this.serverProcess) {
      this.serverProcess.kill();
    }
  }

  // ----------------------------------------------------
  // Helpers de configuración
  // ----------------------------------------------------
  private getPort() {
    return Number(this.config.get('PLAYWRIGHT_MCP_PORT') ?? 8931);
  }

  private getBaseUrl() {
    const port = this.getPort();
    const host = this.getHost();

    const base =
      this.config.get<string>('PLAYWRIGHT_MCP_BASE_URL') ??
      this.config.get<string>('PLAYWRIGHT_MCP_BASE') ??
      `http://${host}:${port}`;

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
    return Number(this.config.get('PLAYWRIGHT_MCP_TIMEOUT_ACTION') ?? 45000);
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

  private getAllowedHosts() {
    return this.config.get<string>('PLAYWRIGHT_MCP_ALLOWED_HOSTS') ?? '*';
  }

  private getHost() {
    return this.config.get<string>('PLAYWRIGHT_MCP_HOST') ?? '127.0.0.1';
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

  // ----------------------------------------------------
  // Lanzar servidor MCP (1 solo proceso para todos)
  // ----------------------------------------------------
  private async startServerProcess() {
    const port = this.getPort();
    const host = this.getHost();

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
      host,
      '--port',
      String(port),

      '--user-data-dir',
      userDataDir,
      '--shared-browser-context', // ⬅️ opcional quitar si querés contextos totalmente aislados

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
      this.getAllowedHosts(),
    ];

    if (this.getBlockServiceWorkers()) {
      args.push('--block-service-workers');
    }

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

    await sleep(10000);
  }

  // ----------------------------------------------------
  // Gestión de sesiones (múltiples clientes MCP)
  // ----------------------------------------------------
  private async safeConnectSession(sessionId: SessionId) {
    try {
      await this.connectClientWithRetry(sessionId);
    } catch {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        this.sessions.set(sessionId, {
          ...existing,
          client: null,
          connected: false,
          connecting: false,
          lastUsedAt: Date.now(),
        });
      }
      this.logger.warn(
        `MCP not available at startup for session "${sessionId}". App will continue. ` +
          `Start MCP or enable managed mode.`,
      );
    }
  }

  private async connectClientWithRetry(sessionId: SessionId) {
    const attempts = 4;
    let lastErr: any;

    for (let i = 0; i < attempts; i++) {
      try {
        await this.connectClient(sessionId);
        const session = this.sessions.get(sessionId);
        if (session?.connected) return;
      } catch (e) {
        lastErr = e;
        await sleep(300 * (i + 1));
      }
    }
    throw lastErr ?? new Error('MCP connection failed');
  }

  private async connectClient(sessionId: SessionId) {
    const existing = this.sessions.get(sessionId);
    if (existing && (existing.connected || existing.connecting)) {
      return;
    }

    let session: McpSession =
      existing ??
      ({
        client: null,
        connected: false,
        connecting: false,
        lastUsedAt: Date.now(),
      } as McpSession);

    session.connecting = true;
    session.lastUsedAt = Date.now();
    this.sessions.set(sessionId, session);

    try {
      const { Client } =
        await import('@modelcontextprotocol/sdk/client/index.js');

      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const { SSEClientTransport } =
        await import('@modelcontextprotocol/sdk/client/sse.js');

      const client = new Client(
        { name: `andeshire-playwright-client-${sessionId}`, version: '0.1.0' },
        { capabilities: {} },
      );

      const httpUrl = this.getHttpUrl();
      const sseUrl = this.getSseUrl();

      this.logger.log(
        `Attempting MCP HTTP connect (session=${sessionId}) -> ${httpUrl.toString()}`,
      );

      try {
        const transport = new StreamableHTTPClientTransport(httpUrl);
        await client.connect(transport);

        session = {
          client,
          connected: true,
          connecting: false,
          lastUsedAt: Date.now(),
        };
        this.sessions.set(sessionId, session);

        this.logger.log(
          `Connected to Playwright MCP (HTTP, session=${sessionId}) at ${httpUrl.toString()}`,
        );
        return;
      } catch (e) {
        this.logger.warn(
          `HTTP transport failed (session=${sessionId}), trying SSE -> ${sseUrl.toString()}`,
        );
        const transport = new SSEClientTransport(sseUrl);
        await client.connect(transport);

        session = {
          client,
          connected: true,
          connecting: false,
          lastUsedAt: Date.now(),
        };
        this.sessions.set(sessionId, session);

        this.logger.log(
          `Connected to Playwright MCP (SSE, session=${sessionId}) at ${sseUrl.toString()}`,
        );
        return;
      }
    } catch (err) {
      session = {
        client: null,
        connected: false,
        connecting: false,
        lastUsedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
      throw err;
    }
  }

  private async ensureConnected(sessionId: SessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.connected) {
      session.lastUsedAt = Date.now();
      this.sessions.set(sessionId, session);
      return;
    }
    await this.connectClientWithRetry(sessionId);
  }

  // ----------------------------------------------------
  // Tools & helpers públicos (multi-sesión + compat)
  // ----------------------------------------------------

  async listToolDefs(
    force = false,
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<any[]> {
    await this.ensureConnected(sessionId);

    if (!force && this.toolsCache) return this.toolsCache;

    const res = await this.listTools(sessionId); // ya setea cache internamente
    const tools = this.extractTools(res);

    this.toolsCache = tools;
    return tools;
  }

  // hasTool(name)
  // hasTool(sessionId, name)
  async hasTool(name: string): Promise<boolean>;
  async hasTool(sessionId: SessionId, name: string): Promise<boolean>;
  async hasTool(a: string, b?: string): Promise<boolean> {
    let sessionId: SessionId = this.DEFAULT_SESSION_ID;
    let name: string;

    if (b !== undefined) {
      sessionId = a;
      name = b;
    } else {
      name = a;
    }

    const tools = await this.listToolDefs(false, sessionId);
    return tools.some((t: any) => t?.name === name);
  }

  // listTools()
  // listTools(sessionId)
  async listTools(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<any> {
    await this.ensureConnected(sessionId);

    const session = this.sessions.get(sessionId);
    if (!session?.client) {
      throw new Error(`MCP client not initialized for session "${sessionId}"`);
    }

    const c: any = session.client;

    let res: any;
    try {
      res = await c.listTools({}); // firma nueva
      this.callSignature = 'new';
    } catch {
      res = await c.listTools(); // firma vieja
      this.callSignature = 'old';
    }

    this.toolsCache = this.extractTools(res);
    return res;
  }

  // callTool(name, args?) -> usa sesión "default"
  // callTool(sessionId, name, args?) -> usa la sesión indicada
  async callTool(name: string, args?: unknown): Promise<any>;
  async callTool(
    sessionId: SessionId,
    name: string,
    args?: unknown,
  ): Promise<any>;
  async callTool(a: string, b?: any, c?: any): Promise<any> {
    let sessionId: SessionId = this.DEFAULT_SESSION_ID;
    let name: string;
    let args: unknown;

    if (c !== undefined) {
      // callTool(sessionId, name, args)
      sessionId = a;
      name = b;
      args = c;
    } else {
      // callTool(name, args)
      name = a;
      args = b;
    }

    await this.ensureConnected(sessionId);

    const session = this.sessions.get(sessionId);
    if (!session?.client) {
      throw new Error(`MCP client not initialized for session "${sessionId}"`);
    }

    const cClient: any = session.client;
    const safeArgs = args && typeof args === 'object' ? args : {};

    // Asegura que ya descubrimos firma al menos una vez
    if (!this.toolsCache) {
      try {
        await this.listTools(sessionId);
      } catch {}
    }

    if (this.callSignature === 'old') {
      return await cClient.callTool(name, safeArgs);
    }

    return await cClient.callTool({ name, arguments: safeArgs });
  }

  private async warmupBrowser(sessionId: SessionId = this.DEFAULT_SESSION_ID) {
    try {
      const res = await this.listTools(sessionId);
      const tools = this.extractTools(res);

      const hasNavigate = tools.some(
        (t: any) => t?.name === 'browser_navigate',
      );

      if (hasNavigate) {
        const url =
          this.config.get<string>('PLAYWRIGHT_MCP_WARMUP_URL') ??
          'https://www.linkedin.com/';
        await this.callTool(sessionId, 'browser_navigate', { url });
        this.logger.log(`Warmup navigate OK (session=${sessionId}) -> ${url}`);
      }
    } catch (e: any) {
      this.logger.warn(
        `Warmup failed (session=${sessionId}): ${e?.message ?? e}`,
      );
    }
  }

  // Helper opcional para otros servicios
  getCachedTools() {
    return this.toolsCache ?? [];
  }
}
