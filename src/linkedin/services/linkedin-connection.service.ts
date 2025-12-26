// src/linkedin/services/linkedin-connection.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { ConfigService } from '@nestjs/config';
import { StreamService } from '../../stream/stream.service';
import { buildEnsureOnUrlSnippet } from '../utils/navigation-snippets';
import OpenAI from 'openai';

type SessionId = string;

@Injectable()
export class LinkedinConnectionService {
  private readonly logger = new Logger(LinkedinConnectionService.name);
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

  // session-aware
  private async hasTool(sessionId: SessionId, name: string) {
    return this.playwright.hasTool(name);
  }

  private async captureProfileScreenshot(
    sessionId: SessionId,
    profileUrl: string,
  ): Promise<{
    base64: string;
    mimeType: string;
  }> {
    await this.playwright.navigate(profileUrl, sessionId);
    await new Promise((r) => setTimeout(r, 1200));

    const { data, mimeType } = await this.stream.getCachedScreenshotBase64(
      sessionId,
      1200,
    );

    if (!data) {
      throw new Error('Screenshot vacío desde MCP.');
    }

    return {
      base64: data,
      mimeType: mimeType ?? 'image/png',
    };
  }

  async checkConnection(
    sessionId: SessionId,
    profileUrl: string,
  ): Promise<any> {
    const startTime = Date.now();

    type ConnStatus = 'connected' | 'pending' | 'not_connected' | 'unknown';

    const verboseResult = {
      ok: true,
      // ✅ compat: antes era boolean -> lo mantenemos como "isConnected"
      result: false,
      // ✅ nuevo: estado 3-way (+ unknown)
      status: 'unknown' as ConnStatus,
      pending: false,

      profileUrl,
      sessionId,

      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'openai_vision_after_overflow_menu',
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],

        playwright: {
          usedRunCode: false,
          openOverflowResult: null as any,
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
      const v = String(s ?? '')
        .toLowerCase()
        .trim();
      if (v === 'connected') return 'connected';
      if (v === 'pending') return 'pending';
      if (v === 'not_connected' || v === 'notconnected') return 'not_connected';
      return 'unknown';
    };

    const inferFromMenuItems = (items: string[]): ConnStatus => {
      const joined = items.join(' | ').toLowerCase();

      // pending: retirar/cancelar invitación, withdraw invitation, etc.
      if (
        /retirar invitación|retirar la invitación|withdraw invitation|cancel invitation|cancelar invitación|cancelar solicitud|anular invitación|pending|pendiente|invited|invitación enviada/.test(
          joined,
        )
      ) {
        return 'pending';
      }

      // connected: eliminar/quitar conexión, remove connection, etc.
      if (
        /eliminar conexión|quitar conexión|remove connection|remove from my network|desconectar/.test(
          joined,
        )
      ) {
        return 'connected';
      }

      // not_connected: conectar/invitar/enviar invitación
      if (
        /conectar|connect|invitar|invite|enviar invitación|send invitation|enviar conexión/.test(
          joined,
        )
      ) {
        return 'not_connected';
      }

      return 'unknown';
    };

    // --- abre overflow ("Más") y devuelve textos del menú ---
    // ✅ UPDATED: buildOpenOverflowCode (reemplaza page.goto por ensureOnUrl)
    // (esto es el builder local dentro de checkConnection, como lo tenés hoy)
    const buildOpenOverflowCode = (url: string) => `
async (page) => {
  ${buildEnsureOnUrlSnippet()}

  const profileUrl = ${JSON.stringify(url)};
  const debug = (msg) => console.log('[check-connection]', msg, 'url=', page.url());

  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(30000);

  await debug('Ir al perfil (ensureOnUrl)');
  const nav = await ensureOnUrl(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
    settleMs: 2500,
    allowSubpaths: false,
  });
  await debug('ensureOnUrl -> ' + JSON.stringify(nav));

  // Wait for LinkedIn's dynamic content to load (mantenemos tu wait extra)
  await page.waitForTimeout(3000);

  const main = page.locator('main').first();

  // scope preferido: top card si existe
  const topCard =
    main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();

  const scope = (await topCard.count()) ? topCard : main;

  // Enhanced candidate selectors with more fallbacks
  const candidates = [
    // Primary selectors from the example
    scope.locator('button[aria-label="Más acciones"]').first(),
    scope.locator('button[id*="ember"][id*="profile-overflow-action"]').first(),
    scope.locator('button.artdeco-dropdown__trigger:has(span:text("Más"))').first(),

    // Original working selectors
    scope.locator('button[id$="-profile-overflow-action"].artdeco-dropdown__trigger').first(),
    scope.locator('button[aria-label*="Más acciones" i], button[aria-label*="More actions" i]').first(),

    // Additional selectors based on the provided example
    scope.locator('button.artdeco-dropdown__trigger.artdeco-button--secondary.artdeco-button--muted').first(),
    scope.locator('button.artdeco-button--secondary:has(span:text("Más"))').first(),
    scope.locator('button[aria-expanded="false"]:has(span:text("Más"))').first(),
    scope.locator('button.ember-view:has(span:text("Más"))').first(),

    // Botón "Más" (texto "Más"/"More") que abre menú
    scope.locator(
      'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
      'button[data-view-name="profile-overflow-button"][aria-label="More"]'
    ).first(),

    // More comprehensive text-based selectors
    scope.locator('button:has-text("Más")').first(),
    scope.locator('button >> text="Más"').first(),

    // Fallback global selectors
    main.locator('button[aria-label="Más acciones"]').first(),
    main.locator('button[id*="ember"][id*="profile-overflow-action"]').first(),
    main.locator('button[id$="-profile-overflow-action"].artdeco-dropdown__trigger').first(),
    main.locator('button[aria-label*="Más acciones" i], button[aria-label*="More actions" i]').first(),
    main.locator('button.artdeco-dropdown__trigger.artdeco-button--secondary.artdeco-button--muted').first(),
    main.locator(
      'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
      'button[data-view-name="profile-overflow-button"][aria-label="More"]'
    ).first(),
    main.locator('button:has-text("Más")').first(),
  ];

  let moreBtn = null;
  let used = null;
  let retryCount = 0;
  const maxRetries = 3;

  // Retry logic with progressive delays
  while (!moreBtn && retryCount < maxRetries) {
    if (retryCount > 0) {
      await debug(\`Intento \${retryCount + 1}/\${maxRetries} - esperando más tiempo\`);
      await page.waitForTimeout(2000 + (retryCount * 1500)); // 2s, 3.5s, 5s
    }

    for (let i = 0; i < candidates.length; i++) {
      const btn = candidates[i];
      const ok = await btn.isVisible().catch(() => false);
      if (ok) {
        // Double-check the button is actually clickable
        const isEnabled = await btn.isEnabled().catch(() => false);
        if (isEnabled) {
          moreBtn = btn;
          used = i;
          await debug(\`Botón encontrado en intento \${retryCount + 1} con selector index \${i}\`);
          break;
        }
      }
    }
    retryCount++;
  }

  if (!moreBtn) {
    // Final fallback: wait longer and try one more time
    await debug('Último intento - esperando 5 segundos más');
    await page.waitForTimeout(5000);

    for (let i = 0; i < candidates.length; i++) {
      const btn = candidates[i];
      const ok = await btn.isVisible().catch(() => false);
      if (ok) {
        const isEnabled = await btn.isEnabled().catch(() => false);
        if (isEnabled) {
          moreBtn = btn;
          used = i;
          await debug(\`Botón encontrado en último intento con selector index \${i}\`);
          break;
        }
      }
    }
  }

  if (!moreBtn) {
    throw new Error('No se encontró botón "Más / Más acciones" en el perfil después de múltiples intentos.');
  }

  await debug(\`Click en overflow (Más/Más acciones) - usando selector \${used}\`);
  await moreBtn.scrollIntoViewIfNeeded().catch(() => {});
  
  // Wait before clicking to ensure element is stable
  await page.waitForTimeout(1000);
  
  await moreBtn.click({ timeout: 12000, force: true });
  
  // Increased wait for dropdown to appear
  await page.waitForTimeout(1500);

  // Enhanced dropdown waiting logic with multiple fallbacks
  const dropdownInner = page.locator('div.artdeco-dropdown__content-inner').last();
  const menuRole = page.locator('[role="menu"]').last();
  const dropdownContent = page.locator('.artdeco-dropdown__content').last();

  let root = null;
  let dropdownRetries = 0;
  const maxDropdownRetries = 3;

  while (!root && dropdownRetries < maxDropdownRetries) {
    try {
      if (dropdownRetries > 0) {
        await debug(\`Dropdown intento \${dropdownRetries + 1}/\${maxDropdownRetries}\`);
        await page.waitForTimeout(1000 + (dropdownRetries * 1000));
      }

      // Try multiple dropdown selectors
      await dropdownInner.waitFor({ state: 'visible', timeout: 8000 });
      root = dropdownInner;
      await debug('Dropdown inner visible');
      break;
    } catch {
      try {
        await menuRole.waitFor({ state: 'visible', timeout: 8000 });
        root = menuRole;
        await debug('Role=menu visible');
        break;
      } catch {
        try {
          await dropdownContent.waitFor({ state: 'visible', timeout: 8000 });
          root = dropdownContent;
          await debug('Dropdown content visible');
          break;
        } catch {
          await debug(\`Dropdown no visible en intento \${dropdownRetries + 1}\`);
        }
      }
    }
    dropdownRetries++;
  }

  if (!root) {
    // Final fallback attempt
    await debug('Último intento para dropdown - esperando 3 segundos más');
    await page.waitForTimeout(3000);

    const anyDropdown = page.locator('.artdeco-dropdown, .dropdown, [role="menu"], [role="listbox"]').last();
    const anyDropdownVisible = await anyDropdown.isVisible().catch(() => false);

    if (anyDropdownVisible) {
      root = anyDropdown;
      await debug('Fallback dropdown encontrado');
    } else {
      throw new Error('No se pudo abrir el dropdown de "Más acciones" después de múltiples intentos.');
    }
  }

  // Enhanced menu item extraction with multiple selectors
  const itemSelectors = [
    'div.artdeco-dropdown__item[role="button"]',
    '[role="menuitem"]',
    'div.artdeco-dropdown__item',
    '.dropdown-item',
    'button',
    'a',
    '[data-test-dropdown-item]',
    '.menu-item'
  ];

  let texts = [];

  for (const selector of itemSelectors) {
    try {
      const itemsLoc = root.locator(selector);
      const count = await itemsLoc.count();
      if (count > 0) {
        const textsRaw = await itemsLoc.allTextContents().catch(() => []);
        texts = (textsRaw || [])
          .map((t) => (t || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 60);

        if (texts.length > 0) {
          await debug(\`Extraídos \${texts.length} items con selector: \${selector}\`);
          break;
        }
      }
    } catch (e) {
      await debug(\`Error con selector \${selector}: \${e?.message || e}\`);
    }
  }

  // If no items found, try to get any text content
  if (texts.length === 0) {
    try {
      const allText = await root.textContent().catch(() => '');
      if (allText && allText.trim()) {
        texts = [allText.replace(/\\s+/g, ' ').trim()];
        await debug('Fallback: extraído texto general del dropdown');
      }
    } catch (e) {
      await debug(\`Error extrayendo texto general: \${e?.message || e}\`);
    }
  }

  return {
    ok: true,
    usedCandidateIndex: used,
    retryAttempts: retryCount,
    dropdownRetryAttempts: dropdownRetries,
    url: page.url(),
    menuItems: texts,
  };
}
`;

    try {
      verboseResult.executionDetails.steps.push(
        'Starting checkConnection process',
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

      // 1) Abrir overflow como en sendConnection
      verboseResult.executionDetails.steps.push(
        'Opening overflow menu (Más/Más acciones) before taking screenshot',
      );

      const canRunCode = await this.hasTool(sessionId, 'browser_run_code');
      if (!canRunCode) {
        verboseResult.executionDetails.fallbackAttempts += 1;
        verboseResult.executionDetails.steps.push(
          'browser_run_code no disponible -> fallback: screenshot del perfil (menos confiable)',
        );

        // fallback: navegar al perfil igual
        await this.playwright.navigate(profileUrl, sessionId);
        await new Promise((r) => setTimeout(r, 900));
      } else {
        verboseResult.executionDetails.playwright.usedRunCode = true;

        const openOverflowCode = buildOpenOverflowCode(profileUrl);
        const openOverflowResult = await this.playwright.runCode(
          openOverflowCode,
          sessionId,
        );

        verboseResult.executionDetails.playwright.openOverflowResult =
          openOverflowResult;

        const menuItems = Array.isArray(openOverflowResult?.menuItems)
          ? openOverflowResult.menuItems
          : [];

        verboseResult.executionDetails.playwright.menuItems = menuItems;

        verboseResult.executionDetails.steps.push(
          `Overflow menu opened. Extracted menu items: ${menuItems.length}`,
        );
      }

      // 2) Screenshot (con el dropdown ya abierto)
      verboseResult.executionDetails.steps.push(
        'Capturing screenshot after menu render',
      );

      // ✅ importante: forzamos captura para no depender de cache
      const shot = await this.stream.forceScreenshotBase64(sessionId);
      const base64 = shot?.data;
      const mimeType = shot?.mimeType ?? 'image/jpeg';

      if (!base64) {
        throw new Error('Screenshot vacío desde MCP (forceScreenshotBase64).');
      }

      verboseResult.executionDetails.steps.push(
        `Screenshot captured: ${mimeType}, size: ${base64.length} chars`,
      );

      // 3) OpenAI Vision: clasificar 3 estados
      const prompt = `
Analizá esta captura de LinkedIn (perfil) donde puede verse el menú de "Más / Más acciones" y/o el módulo de conexión ("Conecta si os conocéis").

Objetivo: determinar el estado de conexión ENTRE el usuario LOGUEADO y este perfil.

⚠️ MUY IMPORTANTE:
- IGNORÁ señales no confiables como: "Enviar mensaje", "Seguir/Following", "Ir a mi sitio web", "Guardar en PDF", "Denunciar/bloquear", "Acerca de este perfil".
- La decisión debe basarse SOLO en señales de CONEXIÓN (botón Conectar/Pendiente o acciones de conexión en el menú).

Estados válidos:
- "pending": existe invitación/solicitud enviada pendiente.
- "connected": ya están conectados (1er grado) o aparece acción de eliminar/quitar conexión.
- "not_connected": no están conectados y aparece opción de conectar/invitar.
- "unknown": no se ve ninguna señal clara (imagen incompleta, login/captcha, menú no visible).

Reglas de decisión (prioridad estricta):
1) Si ves cualquiera de estas señales => status="pending"
   Señales fuertes (ES/EN):
   - Botón: "Pendiente", "Pending"
   - Menú: "Retirar invitación", "Retirar la invitación", "Withdraw invitation", "Cancelar invitación", "Cancel invitation", "Cancel request"
   - Textos: "Invitación enviada", "Invitation sent", "Invited"

2) Si NO es pending, y ves cualquiera de estas señales => status="connected"
   Señales fuertes (ES/EN):
   - Menú: "Eliminar contacto", "Eliminar conexión", "Quitar conexión", "Remove connection", "Remove contact", "Remove from my network", "Disconnect"
   - Cualquier variante clara de “quitar/eliminar conexión”

3) Si NO es pending ni connected, y ves cualquiera de estas señales => status="not_connected"
   Señales fuertes (ES/EN):
   - Botón: "Conectar", "Connect"
   - Menú: "Conectar", "Connect", "Invitar", "Invite", "Enviar invitación", "Send invitation", "Enviar conexión", "Add to network"

4) Si no aparece NINGUNA señal anterior con claridad => status="unknown"

Confianza:
- 0.9–1.0 si encontrás una señal fuerte explícita (palabra exacta o muy cercana).
- 0.6–0.85 si se entiende pero está parcialmente cortado/borroso.
- <0.6 si hay dudas.

Salida:
Respondé SOLO con JSON válido (sin markdown, sin texto extra) con este formato exacto:
{
  "status": "connected" | "pending" | "not_connected" | "unknown",
  "confidence": number,
  "signals": string[]
}

En "signals" incluí las palabras/frases EXACTAS que viste y usaste para decidir (ej: ["Eliminar contacto"], ["Conectar"], ["Pendiente"], ["Retirar invitación"]).
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
              'Sos un clasificador estricto de UI. Seguís reglas de prioridad. Respondés únicamente JSON válido con el formato solicitado.',
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

      // si el modelo devolvió basura, inferimos por menú (si lo tenemos)
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

  // ----------------------------
  // sendConnection multi-sesión
  // ----------------------------
  async sendConnection(
    sessionId: SessionId,
    profileUrl: string,
    note?: string,
  ) {
    const startTime = Date.now();

    const verboseResult = {
      ok: true,
      profileUrl,
      notePreview: (note ?? '').slice(0, 80),
      noteLength: note?.length ?? 0,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_execution_with_fallbacks',
        fallbackAttempts: 0,
        methodsAttempted: [] as string[],
        steps: [] as string[],
        errors: [] as any[],
        playwrightDetails: {
          codeLength: null as number | null,
          humanLikeDelays: true,
          selectors: [] as string[],
        },
      },
      note: null as string | null,
      toolResult: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Starting sendConnection process',
      );

      // Check LinkedIn authentication status before proceeding
      verboseResult.executionDetails.steps.push(
        'Checking LinkedIn authentication status',
      );
      const isAuthenticated = await this.checkAndLogLinkedInAuth(sessionId);
      if (!isAuthenticated) {
        verboseResult.executionDetails.steps.push(
          'User not authenticated - returning error',
        );

        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.executionDetails.errors.push({
          message: 'User not logged into LinkedIn',
          timestamp: endTime,
        });

        return {
          ok: false,
          error: 'User not logged into LinkedIn',
          detail:
            'Please login to LinkedIn first before attempting to send connections',
          executionDetails: verboseResult.executionDetails,
          profileUrl,
          sessionId,
        };
      }

      verboseResult.executionDetails.steps.push(
        'User authenticated, building Playwright execution code',
      );

      // Direct Playwright execution

      // 🔴 IMPORTANTE: el código es una FUNCIÓN async (page) => { ... }
      const code = `
async (page) => {
  ${buildEnsureOnUrlSnippet()}

  const profileUrl = ${JSON.stringify(profileUrl)};
  const note = ${JSON.stringify(note ?? '')};

  const debug = (msg) => {
    console.log('[send-connection]', msg, 'url=', page.url());
  };

  // Function to handle note modal with human-like behavior
  const handleNoteModal = async (page, note, debug) => {
    try {
      await debug('Verificando si apareció modal de nota');

      await page.waitForTimeout(7000 + Math.random() * 3000);

      const modalSelectors = [
        '[data-test-modal-id="send-invite-modal"]',
        '.send-invite',
        'div[role="dialog"]',
        '.artdeco-modal',
        '[aria-labelledby*="invite" i]',
        '.artdeco-modal-overlay'
      ];

      let modal = null;
      for (const selector of modalSelectors) {
        const modalEl = page.locator(selector).first();
        const isVisible = await modalEl.isVisible().catch(() => false);
        if (isVisible) {
          modal = modalEl;
          await debug('Modal encontrado con selector: ' + selector);
          break;
        }
      }

      if (!modal) {
        await debug('No se encontró modal de nota, conexión enviada sin nota');
        return false;
      }

      if (note && note.trim()) {
        await debug('Procesando nota personalizada');

        await debug('Buscando botón "Añadir una nota"');

        const addNoteButtonSelectors = [
          'button[aria-label*="Añadir una nota" i]',
          'button[aria-label*="Add a note" i]',
          'button:has-text("Añadir una nota")',
          'button:has-text("Add a note")',
          'button.artdeco-button--secondary:has-text("Añadir")',
          'button.artdeco-button--secondary:has(span:text("Añadir una nota"))',
          '[id*="ember"] button:has-text("Añadir una nota")'
        ];

        let addNoteButton = null;
        for (const selector of addNoteButtonSelectors) {
          const btnEl = modal.locator(selector).first();
          const isVisible = await btnEl.isVisible().catch(() => false);
          if (isVisible) {
            addNoteButton = btnEl;
            await debug('Botón "Añadir una nota" encontrado: ' + selector);
            break;
          }
        }

        if (addNoteButton) {
          await debug('Haciendo click en "Añadir una nota"');
          await page.waitForTimeout(7000 + Math.random() * 5000);

          await addNoteButton.hover();
          await page.waitForTimeout(2000 + Math.random() * 2000);

          await addNoteButton.click({ timeout: 5000 });
          await page.waitForTimeout(8000 + Math.random() * 4000);
        }

        await debug('Buscando campo de texto para la nota');

        const textareaSelectors = [
          'textarea[name="message"]',
          'textarea#custom-message',
          'textarea[id*="custom-message"]',
          'textarea[placeholder*="Por ejemplo" i]',
          'textarea[placeholder*="Nos conocimos" i]',
          'textarea.connect-button-send-invite__custom-message',
          'textarea.ember-text-area',
          'textarea[aria-label*="message" i]',
          'textarea[aria-label*="nota" i]',
          'textarea[placeholder*="message" i]',
          'textarea[minlength="1"]',
          'textarea'
        ];

        let textarea = null;
        for (const selector of textareaSelectors) {
          const textEl = modal.locator(selector).first();
          const isVisible = await textEl.isVisible().catch(() => false);
          if (isVisible) {
            textarea = textEl;
            await debug('Textarea encontrado con selector: ' + selector);
            break;
          }
        }

        if (textarea) {
          await debug('Escribiendo nota personalizada');

          await page.waitForTimeout(7000 + Math.random() * 8000);

          await textarea.hover();
          await page.waitForTimeout(2000 + Math.random() * 3000);

          await textarea.click();
          await page.waitForTimeout(1000 + Math.random() * 2000);

          await textarea.fill(note);
          await page.waitForTimeout(1000);

          await debug('Nota añadida: ' + note.slice(0, 50) + '...');
        } else {
          await debug('No se encontró textarea para la nota');
        }
      }

      await debug('Buscando botón de envío');

      await page.waitForTimeout(7000 + Math.random() * 5000);

      const hasNote = !!(note && note.trim());

      const waitUntilEnabled = async (loc, timeoutMs = 12000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const vis = await loc.isVisible().catch(() => false);
          if (!vis) {
            await page.waitForTimeout(250);
            continue;
          }
          const en = await loc.isEnabled().catch(() => false);
          if (en) return true;
          await page.waitForTimeout(250);
        }
        return false;
      };

      const robustClick = async (loc, label) => {
        await debug('Intentando click: ' + label);
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(600 + Math.random() * 700);
        await loc.hover().catch(() => {});
        await page.waitForTimeout(500 + Math.random() * 700);

        // 1) normal click
        try {
          await loc.click({ timeout: 5000 });
          return true;
        } catch {}

        // 2) force click
        try {
          await loc.click({ timeout: 5000, force: true });
          return true;
        } catch {}

        // 3) DOM click fallback
        try {
          await loc.evaluate((el) => el && (el).click && (el).click());
          return true;
        } catch {}

        return false;
      };

      const findFirstClickableInScopes = async (scopes, selectors, roleNameRegex) => {
        // A) getByRole is usually the most stable
        if (roleNameRegex) {
          for (const scope of scopes) {
            try {
              const byRole = scope.getByRole('button', { name: roleNameRegex }).first();
              const okEnabled = await waitUntilEnabled(byRole, 9000);
              if (okEnabled) return { loc: byRole, how: 'getByRole(' + roleNameRegex + ')' };
            } catch {}
          }
        }

        // B) selector fallbacks
        for (const sel of selectors) {
          for (const scope of scopes) {
            try {
              const candidate = scope.locator(sel).first();
              const okEnabled = await waitUntilEnabled(candidate, 7000);
              if (okEnabled) return { loc: candidate, how: sel };
            } catch {}
          }
        }

        return { loc: null, how: '' };
      };

      // We try inside modal first, then page as fallback (some UIs mount footer buttons outside the dialog node)
      const scopes = [modal, page];

      // ✅ Case 1: NO NOTE => must click "Enviar sin nota"
      if (!hasNote) {
        await debug('Caso SIN nota: buscando botón "Enviar sin nota"');

        const sendWithoutNoteSelectors = [
          // exact / aria-label
          'button[aria-label="Enviar sin nota"]',
          'button[aria-label*="enviar sin nota" i]',
          'button[aria-label*="sin nota" i]',

          // text-based
          'button:has-text("Enviar sin nota")',
          'button:has(span.artdeco-button__text:has-text("Enviar sin nota"))',
          'button.artdeco-button--primary:has-text("Enviar sin nota")',
          'button.artdeco-button--primary:has(span.artdeco-button__text:has-text("Enviar sin nota"))',

          // English fallbacks (in case account/UI is EN)
          'button[aria-label*="send without" i]',
          'button:has-text("Send without a note")',
          'button:has-text("Send without note")',
          'button:has-text("Send without a message")',

          // generic but safer-ish (last resort inside this branch)
          'button[data-control-name*="send" i]',
        ];

        const found = await findFirstClickableInScopes(
          scopes,
          sendWithoutNoteSelectors,
          /enviar sin nota/i
        );

        if (found.loc) {
          await debug('Botón "Enviar sin nota" encontrado vía: ' + found.how);

          await page.waitForTimeout(1200 + Math.random() * 1200);

          const clicked = await robustClick(found.loc, 'Enviar sin nota (' + found.how + ')');
          if (clicked) {
            await page.waitForTimeout(7000 + Math.random() * 5000);
            await debug('Conexión enviada (sin nota)');
            return true;
          }

          await debug('Falló el click en "Enviar sin nota", intentando fallback general...');
        } else {
          await debug('No se encontró "Enviar sin nota" con fallbacks, intentando fallback general...');
        }
      }

      // ✅ Case 2: WITH NOTE (or fallback if no-note path failed) => click "Enviar"/"Send"
      await debug('Buscando botón de envío estándar ("Enviar"/"Send")');

      const sendButtonSelectors = [
        // Prefer exact-ish "Enviar" first
        'button[aria-label="Enviar"]',
        'button[aria-label*="send invite" i]',
        'button[data-control-name="send_invite"]',

        // Text-based
        'button:has(span.artdeco-button__text:text("Enviar"))',
        'button:has-text("Enviar")',
        'button:has-text("Send")',
        'button:has-text("Send invitation")',
        'button:has-text("Enviar invitación")',

        // Generic fallbacks (keep them late)
        'button[type="submit"]',
        'button.artdeco-button--primary',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Enviar" i]',
        '.artdeco-button--primary:has-text("Enviar")'
      ];

      let sendButton = null;
      let sendHow = '';

      const foundStandard = await findFirstClickableInScopes(
        scopes,
        sendButtonSelectors,
        /^(enviar|send)$/i
      );

      if (foundStandard.loc) {
        sendButton = foundStandard.loc;
        sendHow = foundStandard.how;
      }

      if (sendButton) {
        await debug('Botón de envío encontrado: ' + sendHow);

        await debug('Preparando envío de conexión');

        await page.waitForTimeout(8000 + Math.random() * 7000);

        const clicked = await robustClick(sendButton, 'Send standard (' + sendHow + ')');
        if (clicked) {
          await page.waitForTimeout(7000 + Math.random() * 5000);

          await debug('Conexión enviada con modal completado');
          return true;
        }

        await debug('No se pudo clickear el botón de envío estándar');
        return false;
      } else {
        await debug('No se encontró botón de envío válido');
        // Try to close modal and proceed
        const closeButtons = modal.locator('[aria-label*="dismiss" i], [aria-label*="close" i], button:has-text("×")');
        const closeBtn = closeButtons.first();
        const closeVisible = await closeBtn.isVisible().catch(() => false);
        if (closeVisible) {
          await closeBtn.click().catch(() => {});
        }
        return false;
      }

    } catch (error) {
      await debug('Error manejando modal de nota: ' + (error?.message || error));
      return false;
    }
  };

  // Limitar tiempos por acción para no pasarnos del timeout global del MCP
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(20000);

  // ✅ 1) Ir al perfil (ensureOnUrl)
  await debug('Ir al perfil (ensureOnUrl)');
  const nav = await ensureOnUrl(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
    settleMs: 10000, // equivalente a tu waitForTimeout(10000)
    allowSubpaths: false,
  });
  await debug('ensureOnUrl -> ' + JSON.stringify(nav));
  await debug('Perfil listo');

  // 2) Localizar <main> (si hay más de uno, usamos el último)
  const mains = page.locator('main');
  const mainCount = await mains.count();
  if (!mainCount) {
    throw new Error('No se encontró ningún <main> en el perfil.');
  }
  const main = mainCount > 1 ? mains.last() : mains.first();
  await debug('Main elegido, count=' + mainCount);

  // 3) FIRST: Try to find direct "Conectar" button with multiple selectors
  await debug('Buscando botón "Conectar" directo');

  const directConnectSelectors = [
    // By aria-label containing "conectar"
    'button[aria-label*="conectar" i]',
    'button[aria-label*="Invita" i][aria-label*="conectar" i]',
    
    // By class and text content
    'button.artdeco-button--primary:has-text("Conectar")',
    'button.artdeco-button--2.artdeco-button--primary:has-text("Conectar")',
    
    // By SVG icon and text
    'button:has(svg[data-test-icon="connect-small"]) >> text="Conectar"',
    'button:has(use[href="#connect-small"]) >> text="Conectar"',
    
    // By button text with various classes
    'button:has(span.artdeco-button__text >> text="Conectar")',
    'button.artdeco-button:has(span >> text="Conectar")',
    
    // By ID pattern (ember IDs)
    'button[id^="ember"]:has-text("Conectar")',
    
    // Generic fallbacks
    'button >> text="Conectar"',
    'button:text("Conectar")'
  ];

  let directConnectBtn = null;
  let usedSelector = '';

  for (const selector of directConnectSelectors) {
    try {
      const btn = main.locator(selector).first();
      const isVisible = await btn.isVisible().catch(() => false);
      if (isVisible) {
        directConnectBtn = btn;
        usedSelector = selector;
        await debug('Encontrado botón Conectar directo con selector: ' + selector);
        break;
      }
    } catch {}
  }

  if (directConnectBtn) {
    try {
      await debug('Click en botón "Conectar" directo');
      await directConnectBtn.click({ timeout: 6000, force: true });
      await page.waitForTimeout(2000);

      const noteHandled = await handleNoteModal(page, note, debug);

      await debug('Flujo de conexión directa finalizado');
      return {
        ok: true,
        viaDirect: true,
        selector: usedSelector,
        noteLength: note.length,
        noteAdded: noteHandled
      };
    } catch (clickError) {
      await debug('Error al hacer click en botón directo: ' + (clickError?.message || clickError));
      // Fall through to dropdown approach
    }
  }

  // 4) FALLBACK: Use "Más acciones" dropdown approach
  await debug('No se encontró botón directo o falló click, usando dropdown "Más acciones"');

  let moreBtn = main
    .locator(
      [
        'button[id$="-profile-overflow-action"].artdeco-dropdown__trigger',
        'button[aria-label*="Más acciones"]',
        'button[aria-label*="More actions"]'
      ].join(', ')
    )
    .first();

  const moreVisible = await moreBtn.isVisible().catch(() => false);
  if (!moreVisible) {
    throw new Error('No se encontró el botón "Más acciones" (profile-overflow-action).');
  }

  await debug('Click en botón "Más acciones" / overflow del perfil');
  await moreBtn.click({ timeout: 6000, force: true });
  await page.waitForTimeout(500);

  const dropdownInner = page.locator('div.artdeco-dropdown__content-inner').last();

  await dropdownInner.waitFor({ state: 'visible', timeout: 7000 }).catch(() => {
    throw new Error('No se abrió el popover de "Más acciones" (artdeco-dropdown__content-inner).');
  });

  await debug('Popover de "Más acciones" visible');

  // Log de items del dropdown para debug
  try {
    const items = dropdownInner.locator('div.artdeco-dropdown__item[role="button"]');
    const labels = await items.allTextContents();
    debug('Items en dropdown: ' + JSON.stringify(labels));
  } catch (e) {
    debug('No se pudieron loguear los items del dropdown: ' + (e?.message || e));
  }

  // 6) Buscar el item "Conectar" dentro del dropdown interno por TEXTO VISIBLE
  const connectButton = dropdownInner
    .locator('div.artdeco-dropdown__item[role="button"]')
    .filter({ hasText: /conectar/i })
    .first();

  await connectButton.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {
    throw new Error('No se encontró el item "Conectar" dentro del dropdown de Más acciones.');
  });

  await debug('Click en "Conectar" dentro del dropdown');
  await connectButton.click({ timeout: 6000, force: true });

  await page.waitForTimeout(2000);

  const noteHandled = await handleNoteModal(page, note, debug);

  await debug('Flujo de conexión por dropdown finalizado');

  return {
    ok: true,
    viaPopover: true,
    noteLength: note.length,
    noteAdded: noteHandled
  };
}
`;

      try {
        verboseResult.executionDetails.playwrightDetails.codeLength =
          code.length;
        verboseResult.executionDetails.steps.push(
          `Generated Playwright code: ${code.length} characters`,
        );
        verboseResult.executionDetails.steps.push(
          'Executing Playwright code with human-like behavior',
        );

        const result = await this.playwright.runCode(code, sessionId);

        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.executionDetails.steps.push(
          'Playwright execution completed',
        );

        this.logger.debug(
          'browser_run_code result (sendConnection popover): ' +
            JSON.stringify(result, null, 2),
        );

        if (result?.isError) {
          verboseResult.executionDetails.errors.push({
            message: 'Playwright MCP error',
            detail: result?.content ?? result,
            timestamp: endTime,
          });
          verboseResult.executionDetails.steps.push(
            `Error in Playwright execution: ${result?.content ?? result}`,
          );

          return {
            ok: false,
            error: 'Playwright MCP error en browser_run_code',
            detail: result?.content ?? result,
            executionDetails: verboseResult.executionDetails,
            profileUrl,
            sessionId,
          };
        }

        // Track which method was used
        const connectionMethod = result?.viaDirect
          ? 'botón directo "Conectar"'
          : 'dropdown "Más acciones"';
        const selectorInfo = result?.selector
          ? ` (selector: ${result.selector})`
          : '';

        verboseResult.executionDetails.methodsAttempted.push(connectionMethod);
        verboseResult.executionDetails.steps.push(
          `Connection sent via: ${connectionMethod}${selectorInfo}`,
        );

        if (result?.viaDirect) {
          verboseResult.executionDetails.playwrightDetails.selectors.push(
            result.selector || 'unknown',
          );
        }

        if (result?.noteAdded) {
          verboseResult.executionDetails.steps.push(
            `Custom note added: ${note?.slice(0, 50)}...`,
          );
        }

        verboseResult.note = `Solicitud de conexión enviada vía ${connectionMethod}${selectorInfo}.`;
        verboseResult.toolResult = result;

        return verboseResult;
      } catch (e: any) {
        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.executionDetails.errors.push({
          message: e?.message ?? 'Unknown error',
          stack: e?.stack,
          timestamp: endTime,
        });
        verboseResult.executionDetails.steps.push(
          `Error occurred: ${e?.message ?? 'Unknown error'}`,
        );

        this.logger.warn(`sendConnection (popover) failed: ${e?.message ?? e}`);

        return {
          ok: false,
          error: e?.message ?? 'Unknown error',
          executionDetails: verboseResult.executionDetails,
          profileUrl,
          sessionId,
        };
      }
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Outer error: ${e?.message ?? 'Unknown error'}`,
      );

      this.logger.warn(`sendConnection failed: ${e?.message ?? e}`);

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        sessionId,
      };
    }
  }
}
