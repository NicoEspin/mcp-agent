// src/linkedin/services/linkedin-sales-navigator-connection.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { ConfigService } from '@nestjs/config';
import { StreamService } from '../../stream/stream.service';
import OpenAI from 'openai';
import { buildEnsureOnUrlSnippet } from '../utils/navigation-snippets';

type SessionId = string;

@Injectable()
export class LinkedinSalesNavigatorConnectionService {
  private readonly logger = new Logger(
    LinkedinSalesNavigatorConnectionService.name,
  );
  private readonly openai: OpenAI;

  constructor(
    private readonly playwright: PlaywrightService,
    private readonly config: ConfigService,
    private readonly stream: StreamService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
    });
  }

  /**
   * Check if user is logged into LinkedIn and log status
   */
  private async checkAndLogLinkedInAuth(
    sessionId: SessionId,
  ): Promise<boolean> {
    const isLoggedIn = await this.playwright.isLinkedInLoggedIn(sessionId);
    const authToken = isLoggedIn
      ? await this.playwright.getLinkedInAuthToken(sessionId)
      : null;

    if (isLoggedIn && authToken) {
      this.logger.log(
        `✅ LinkedIn authenticated for session ${sessionId} (li_at: ${authToken.slice(0, 10)}...)`,
      );
    } else {
      this.logger.warn(
        `❌ LinkedIn NOT authenticated for session ${sessionId} - user needs to login`,
      );
    }

    return isLoggedIn;
  }

  // (compat) session-aware wrapper
  private async hasTool(_sessionId: SessionId, name: string) {
    return this.playwright.hasTool(name);
  }

  /**
   * Igual al arranque de buildSendSalesNavMessageCode:
   * - goto perfil
   * - click overflow "More / Más"
   * - click "View in Sales Navigator"
   *
   * Luego:
   * - click en el "..." (3 dots)
   * - espera popover/menu
   * - extrae menuItems (fallback sin visión)
   */
// ✅ UPDATED: buildOpenSalesNavAndOpenEllipsisMenuCode (reemplaza page.goto por ensureOnUrl)
// src/linkedin/services/linkedin-sales-navigator-connection.service.ts

private buildOpenSalesNavAndOpenEllipsisMenuCode(profileUrl: string) {
  return `
async (page) => {
  ${buildEnsureOnUrlSnippet()}

  const profileUrl = ${JSON.stringify(profileUrl)};
  const debug = (msg) => console.log('[salesnav-check-connection]', msg, 'url=', page.url());
  const sleep = (ms) => page.waitForTimeout(ms);

  const stepWait = async (baseMs) => {
    const jitter = Math.floor(Math.random() * 220);
    await sleep(baseMs + jitter);
  };

  page.setDefaultTimeout(14000);
  page.setDefaultNavigationTimeout(35000);

  const firstVisible = async (loc) => {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {}
    }
    return null;
  };

  const clickFirstWorking = async (label, locators, opts = {}) => {
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      const el = await firstVisible(loc);
      if (!el) continue;
      try {
        debug(\`\${label}: candidato \${i} visible -> click\`);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await stepWait(650);
        await el.click({ timeout: 12000, force: true, ...opts });
        await stepWait(900);
        return { ok: true, usedIndex: i };
      } catch (e) {
        debug(\`\${label}: click falló candidato \${i}\`);
      }
    }
    return { ok: false, usedIndex: -1 };
  };

  const waitAnyVisible = async (candidates, timeoutMs = 12000, pollMs = 180) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const c of candidates) {
        try {
          const cnt = await c.count().catch(() => 0);
          if (cnt && (await c.first().isVisible().catch(() => false))) {
            return c.first();
          }
        } catch {}
      }
      await sleep(pollMs);
    }
    return null;
  };

  const looksLikeSalesNav = (url) => /linkedin\\.com\\/sales\\b|sales-navigator/i.test(url);

  const getMainScope = async () => {
    const mains = page.locator('main');
    const c = await mains.count().catch(() => 0);
    const main = c > 1 ? mains.last() : mains.first();

    const topCard = main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
    const scope = (await topCard.count().catch(() => 0)) ? topCard : main;

    return { main, scope };
  };

  // -----------------------------
  // 0) FAST PATH: si ya estamos en Sales Navigator, NO navegamos al perfil
  // -----------------------------
  const alreadySalesNavAtStart =
    looksLikeSalesNav(page.url()) ||
    (await page
      .locator('button[data-anchor-send-inmail], textarea[name="message"]')
      .first()
      .isVisible()
      .catch(() => false));

  let salesPage = page;
  let openedIn = 'same';

  // -----------------------------
  // 1) Ir al perfil (LinkedIn) usando ensureOnUrl (en lugar de goto)
  // -----------------------------
  if (!alreadySalesNavAtStart) {
    debug('ensureOnUrl profile');
    const nav = await ensureOnUrl(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
      settleMs: 1800,      // equivalente a tu stepWait post-goto
      allowSubpaths: false,
    });
    debug('ensureOnUrl -> ' + JSON.stringify(nav));
    await stepWait(900);
    debug('profile ready');

    const { main, scope } = await getMainScope();

    // -----------------------------
    // 2) Click "More / Más" (overflow)
    // -----------------------------
    debug('finding overflow "More actions"');

    const overflowCandidates = [
      // aria-label
      scope.locator('button[aria-label="More actions"]').first(),
      scope.locator('button[aria-label="Más acciones"]').first(),
      scope.locator('button[aria-label*="More actions" i]').first(),
      scope.locator('button[aria-label*="Más acciones" i]').first(),

      // id pattern
      scope.locator('button[id*="profile-overflow-action"]').first(),
      scope.locator('button[id$="-profile-overflow-action"]').first(),
      scope.locator('button.artdeco-dropdown__trigger[id*="profile-overflow-action"]').first(),

      // data-view-name
      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="More"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="Más"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"]').first(),

      // texto
      scope.locator('button').filter({ hasText: /^More$/ }).first(),
      scope.locator('button').filter({ hasText: /^Más$/ }).first(),
      main.locator('button').filter({ hasText: /^More$/ }).first(),
      main.locator('button').filter({ hasText: /^Más$/ }).first(),

      // global fallbacks
      page.locator('button[aria-label="More actions"]').first(),
      page.locator('button[aria-label="Más acciones"]').first(),
      page.locator('button[id*="profile-overflow-action"]').first(),
    ];

    let overflowClicked = false;
    for (let attempt = 0; attempt < 3 && !overflowClicked; attempt++) {
      if (attempt > 0) {
        debug(\`overflow retry attempt \${attempt + 1}\`);
        await stepWait(1600 + attempt * 900);
      }
      const res = await clickFirstWorking('overflow-more', overflowCandidates);
      overflowClicked = res.ok;
    }

    if (!overflowClicked) {
      throw new Error('No se encontró / no se pudo clickear el botón "More / Más acciones" (overflow).');
    }

    // -----------------------------
    // 3) Click "View in Sales Navigator"
    // -----------------------------
    debug('waiting dropdown');
    await stepWait(1200);

    const dropdownRoots = [
      page.locator('div.artdeco-dropdown__content-inner').last(),
      page.locator('.artdeco-dropdown__content').last(),
      page.locator('[role="menu"]').last(),
      page.locator('div[role="menu"]').last(),
    ];

    const dropdownRoot = await waitAnyVisible(dropdownRoots, 14000, 200);
    if (!dropdownRoot) {
      throw new Error('No se detectó el dropdown del overflow (artdeco-dropdown / role=menu).');
    }

    debug('dropdown visible');

    const viewSalesNavRegex = /view in sales navigator|ver en sales navigator|sales navigator/i;

    const itemCandidates = [
      dropdownRoot.locator('div.artdeco-dropdown__item[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('[role="menuitem"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('div[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('button').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('a').filter({ hasText: viewSalesNavRegex }),

      // aria-label
      dropdownRoot.locator('[aria-label*="Sales Navigator" i]'),
      dropdownRoot.locator('div[aria-label*="Sales Navigator" i]'),

      // ícono sales-navigator
      dropdownRoot
        .locator('svg[data-test-icon="sales-navigator-small"], use[href="#sales-navigator-small"]')
        .locator('xpath=ancestor::*[self::div or self::button or self::a][1]'),
    ];

    const ctx = page.context();
    const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);

    const clickedSalesNav = await clickFirstWorking('view-in-sales-nav', itemCandidates);
    if (!clickedSalesNav.ok) {
      throw new Error('No se encontró / no se pudo clickear "View in Sales Navigator" en el dropdown.');
    }

    const popup = await popupPromise;
    await navPromise;

    if (popup) {
      salesPage = popup;
      openedIn = 'popup';
      debug('sales nav opened in new page');
      await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(800);
    } else {
      salesPage = page;
      openedIn = 'same';
      debug('sales nav opened in same page (or navigation completed)');
      await stepWait(1600);
    }
  } else {
    debug('already on Sales Navigator at start -> skip ensureOnUrl + overflow');
    salesPage = page;
    openedIn = 'same';
  }

  // -----------------------------
  // 4) En Sales Navigator: abrir menú "..." (icon)
  // -----------------------------
  debug('sales page url=' + salesPage.url());
  await stepWait(1200);
  await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
  await stepWait(1200);

  const dotsPathPrefix = 'M3 9.5A1.5';

  const ellipsisCandidates = [
    // aria-label típicos
    salesPage.locator('button[aria-label*="More actions" i]').first(),
    salesPage.locator('button[aria-label*="More" i]').first(),
    salesPage.locator('button[aria-label*="Más" i]').first(),
    salesPage.locator('[role="button"][aria-label*="More" i]').first(),

    // data-test / data-control-name frecuentes (fallbacks genéricos)
    salesPage.locator('button[data-control-name*="overflow" i]').first(),
    salesPage.locator('button[data-test-icon*="overflow" i]').first(),

    // Por el span class que mostraste
    salesPage.locator('span._icon_ps32ck').first(),
    salesPage.locator('span[class*="_icon"]').first(),

    // Por SVG path del 3-dots -> subir al elemento clickeable
    salesPage.locator(\`path[d^="\${dotsPathPrefix}"]\`).locator('xpath=ancestor::button[1]'),
    salesPage.locator(\`path[d^="\${dotsPathPrefix}"]\`).locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),
    salesPage.locator(\`svg:has(path[d^="\${dotsPathPrefix}"])\`).locator('xpath=ancestor::button[1]'),
    salesPage.locator(\`svg:has(path[d^="\${dotsPathPrefix}"])\`).locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),

    // Últimos recursos (muy amplios, pero preferimos no fallar)
    salesPage.locator('button').filter({ has: salesPage.locator('svg') }).first(),
  ];

  let openedDots = false;
  let usedEllipsisIndex = -1;

  for (let attempt = 0; attempt < 4 && !openedDots; attempt++) {
    if (attempt > 0) {
      debug(\`ellipsis retry attempt \${attempt + 1}\`);
      await stepWait(900 + attempt * 700);
    }
    const res = await clickFirstWorking('ellipsis-3dots', ellipsisCandidates, { force: true });
    openedDots = res.ok;
    usedEllipsisIndex = res.usedIndex;
  }

  if (!openedDots) {
    throw new Error('No se encontró / no se pudo clickear el menú "..." en Sales Navigator.');
  }

  // Esperar render del popup/menu
  debug('waiting ellipsis popup/menu');
  await stepWait(1200);

  const popupRoots = [
    salesPage.locator('div.artdeco-dropdown__content-inner').last(),
    salesPage.locator('.artdeco-dropdown__content').last(),
    salesPage.locator('[role="menu"]').last(),
    salesPage.locator('div[role="menu"]').last(),
    salesPage.locator('ul[role="menu"]').last(),

    // algunos layouts como dialog/panel flotante
    salesPage.locator('div[role="dialog"]').last(),
    salesPage.locator('section[role="dialog"]').last(),

    // fallback genérico
    salesPage.locator('.artdeco-dropdown').last(),
  ];

  let root = await waitAnyVisible(popupRoots, 12000, 200);
  if (!root) {
    debug('popup root not found, last wait');
    await stepWait(2200);
    root = await waitAnyVisible(popupRoots, 9000, 200);
  }

  const effectiveRoot = root || salesPage.locator('[role="menu"]').last() || salesPage.locator('body');

  // Extraer menu items (fallback sin visión)
  const itemSelectors = [
    'div.artdeco-dropdown__item[role="button"]',
    '[role="menuitem"]',
    'li[role="menuitem"]',
    'button',
    'a',
    'li',
    'div[role="button"]',
    '[data-test-dropdown-item]',
  ];

  let texts = [];

  for (const selector of itemSelectors) {
    try {
      const itemsLoc = effectiveRoot.locator(selector);
      const count = await itemsLoc.count().catch(() => 0);
      if (count > 0) {
        const raw = await itemsLoc.allTextContents().catch(() => []);
        texts = (raw || [])
          .map((t) => (t || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 80);

        if (texts.length > 0) {
          debug(\`menu items extracted: \${texts.length} via \${selector}\`);
          break;
        }
      }
    } catch {}
  }

  if (texts.length === 0) {
    try {
      const allText = await effectiveRoot.textContent().catch(() => '');
      if (allText && allText.trim()) {
        texts = [allText.replace(/\\s+/g, ' ').trim()];
        debug('fallback: extracted root text');
      }
    } catch {}
  }

  return {
    ok: true,
    openedIn,
    usedEllipsisIndex,
    url: salesPage.url(),
    menuItems: texts,
  };
}
`;
}

  async checkConnectionSalesNavigator(
    sessionId: SessionId,
    profileUrl: string,
  ): Promise<any> {
    const startTime = Date.now();

    type ConnStatus = 'connected' | 'pending' | 'not_connected' | 'unknown';

    const verboseResult = {
      ok: true,
      result: false, // compat: isConnected
      status: 'unknown' as ConnStatus,
      pending: false,

      profileUrl,
      sessionId,

      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'openai_vision_salesnav_after_ellipsis_menu',
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],

        playwright: {
          usedRunCode: false,
          openSalesNavResult: null as any,
          menuItems: [] as string[],
        },

        openaiDetails: {
          model: 'gpt-5-nano',
          prompt: null as string | null,
          response: null as any,
          rawText: null as string | null,
          parsed: null as any,
          usage: null as any,
        },
      },
    };

    const safeJsonParse = (text: string): any | null => {
      try {
        return JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
          return JSON.parse(m[0]);
        } catch {
          return null;
        }
      }
    };

    const normalizeStatus = (s: any): ConnStatus => {
      const v = String(s ?? '').toLowerCase().trim();
      if (v === 'connected') return 'connected';
      if (v === 'pending') return 'pending';
      if (v === 'not_connected' || v === 'notconnected') return 'not_connected';
      return 'unknown';
    };

    const inferFromMenuItems = (items: string[]): ConnStatus => {
      const joined = items.join(' | ').toLowerCase();

      // pending
      if (
        /withdraw invitation|cancel invitation|cancelar invitación|retirar invitación|pending|pendiente|invitación enviada|invitation sent|invited/.test(
          joined,
        )
      ) {
        return 'pending';
      }

      // connected
      if (
        /remove connection|remove from my network|eliminar conexión|quitar conexión|disconnect|desconectar/.test(
          joined,
        )
      ) {
        return 'connected';
      }

      // not_connected
      if (
        /connect|conectar|invite|invitar|send invitation|enviar invitación|enviar conexión/.test(
          joined,
        )
      ) {
        return 'not_connected';
      }

      return 'unknown';
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Starting checkConnectionSalesNavigator process',
      );
      verboseResult.executionDetails.steps.push(
        'Checking LinkedIn authentication status',
      );

      const isAuthenticated = await this.checkAndLogLinkedInAuth(sessionId);
      if (!isAuthenticated) {
        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.ok = false;
        verboseResult.result = false;
        verboseResult.status = 'unknown';
        verboseResult.pending = false;
        verboseResult.executionDetails.errors.push({
          message: 'User not authenticated',
          timestamp: endTime,
        });
        verboseResult.executionDetails.steps.push(
          'User not logged into LinkedIn - aborting',
        );
        return verboseResult;
      }

      // 1) runCode: abrir SalesNav + abrir "..." menu
      verboseResult.executionDetails.steps.push(
        'Opening Sales Navigator and ellipsis menu before taking screenshot',
      );

      const canRunCode = await this.hasTool(sessionId, 'browser_run_code');
      if (!canRunCode) {
        verboseResult.executionDetails.fallbackAttempts += 1;
        verboseResult.executionDetails.steps.push(
          'browser_run_code no disponible -> fallback: navegar al perfil y capturar (menos confiable)',
        );

        await this.playwright.navigate(profileUrl, sessionId);
        await new Promise((r) => setTimeout(r, 1200));
      } else {
        verboseResult.executionDetails.playwright.usedRunCode = true;

        const code = this.buildOpenSalesNavAndOpenEllipsisMenuCode(profileUrl);
        const openSalesNavResult = await this.playwright.runCode(code, sessionId);

        verboseResult.executionDetails.playwright.openSalesNavResult =
          openSalesNavResult;

        const menuItems = Array.isArray(openSalesNavResult?.menuItems)
          ? openSalesNavResult.menuItems
          : [];

        verboseResult.executionDetails.playwright.menuItems = menuItems;

        verboseResult.executionDetails.steps.push(
          `Ellipsis menu opened. Extracted menu items: ${menuItems.length}`,
        );
      }

      // 2) Screenshot (con el menú abierto)
      verboseResult.executionDetails.steps.push(
        'Capturing screenshot after menu render',
      );

      const shot = await this.stream.forceScreenshotBase64(sessionId);
      const base64 = shot?.data;
      const mimeType = shot?.mimeType ?? 'image/jpeg';

      if (!base64) {
        throw new Error('Screenshot vacío desde MCP (forceScreenshotBase64).');
      }

      verboseResult.executionDetails.steps.push(
        `Screenshot captured: ${mimeType}, size: ${base64.length} chars`,
      );

      // 3) OpenAI Vision
      const prompt = `
Analizá esta captura de LinkedIn Sales Navigator (perfil con un menú de acciones abierto, típicamente el de "..." / overflow).

Objetivo:
Determinar el estado de conexión ENTRE el usuario LOGUEADO y el perfil.

Clasificá en uno de estos estados:
- "connected": ya están conectados (ej: aparece "Remove connection" / "Eliminar conexión" o señales claras de conexión).
- "pending": hay solicitud enviada pendiente (ej: "Pending" / "Pendiente" / "Invitation sent" / "Withdraw invitation" / "Retirar invitación").
- "not_connected": NO están conectados (ej: aparece "Connect" / "Conectar" / "Invite" / "Invitar" / "Send invitation").
- "unknown": no se puede determinar con confianza (login/captcha/imagen incompleta/no se ve el menú).

Reglas de salida:
Respondé SOLO con JSON válido (sin markdown, sin texto extra) con este formato exacto:
{
  "status": "connected" | "pending" | "not_connected" | "unknown",
  "confidence": number,
  "signals": string[]
}

Notas:
- "confidence" entre 0 y 1.
- "signals" son pistas textuales visibles (palabras como "Connect", "Pending", "Remove connection", etc).
`.trim();

      verboseResult.executionDetails.openaiDetails.prompt = prompt;
      verboseResult.executionDetails.steps.push(
        'Sending screenshot to OpenAI vision model',
      );

      const resp = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          {
            role: 'system',
            content:
              'Sos un clasificador estricto de UI. Respondés únicamente JSON válido con el formato solicitado.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}` },
              },
            ],
          },
        ],
      });

      verboseResult.executionDetails.openaiDetails.response = resp;
      verboseResult.executionDetails.openaiDetails.usage = resp.usage;

      const rawText = resp?.choices?.[0]?.message?.content?.trim() ?? '';
      verboseResult.executionDetails.openaiDetails.rawText = rawText;

      const parsed = safeJsonParse(rawText) ?? {};
      verboseResult.executionDetails.openaiDetails.parsed = parsed;

      let status = normalizeStatus(parsed?.status);

      // Fallback: inferir por menuItems si OpenAI no pudo
      if (status === 'unknown') {
        const menuStatus = inferFromMenuItems(
          verboseResult.executionDetails.playwright.menuItems ?? [],
        );
        if (menuStatus !== 'unknown') {
          status = menuStatus;
          verboseResult.executionDetails.steps.push(
            `OpenAI status=unknown -> inferred from menuItems: ${menuStatus}`,
          );
        }
      }

      verboseResult.status = status;
      verboseResult.pending = status === 'pending';
      verboseResult.result = status === 'connected';

      verboseResult.executionDetails.steps.push(
        `Final status: ${status} (isConnected=${verboseResult.result}, pending=${verboseResult.pending})`,
      );

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.ok = false;
      verboseResult.result = false;
      verboseResult.status = 'unknown';
      verboseResult.pending = false;

      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Error occurred: ${e?.message ?? 'Unknown error'}`,
      );

      return verboseResult;
    }
  }
}
