// src/linkedin/services/linkedin-connection.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { ConfigService } from '@nestjs/config';
import { StreamService } from '../../stream/stream.service';
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
  ): Promise<boolean> {
    const { base64, mimeType } = await this.captureProfileScreenshot(
      sessionId,
      profileUrl,
    );

    const prompt = `
Analizá esta captura del perfil de LinkedIn.

Objetivo:
Determinar si el usuario LOGUEADO actualmente en LinkedIn ya está conectado con este perfil.

Reglas de salida:
- Respondé SOLO con "true" o "false" (sin comillas).
- true => ya están conectados.
- false => NO están conectados o aparece un CTA que indica que hay que enviar solicitud.
`;

    const resp = await this.openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        {
          role: 'system',
          content:
            'Sos un clasificador estricto. Respondés únicamente true o false.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    const out =
      resp?.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';

    if (out === 'true') return true;
    if (out === 'false') return false;

    const hasTrue = /\btrue\b/i.test(out);
    const hasFalse = /\bfalse\b/i.test(out);

    if (hasTrue && !hasFalse) return true;
    if (hasFalse && !hasTrue) return false;

    this.logger.warn(`checkConnection: salida inesperada del modelo: ${out}`);
    return false;
  }

  // ----------------------------
  // sendConnection multi-sesión
  // ----------------------------
  async sendConnection(
    sessionId: SessionId,
    profileUrl: string,
    note?: string,
  ) {
    // Direct Playwright execution

    // 🔴 IMPORTANTE: el código es una FUNCIÓN async (page) => { ... }
    const code = `
async (page) => {
  const profileUrl = ${JSON.stringify(profileUrl)};
  const note = ${JSON.stringify(note ?? '')};

  const debug = (msg) => {
    console.log('[send-connection:popover]', msg, 'url=', page.url());
  };

  // Limitar tiempos por acción para no pasarnos del timeout global del MCP
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(20000);

  // 1) Ir al perfil
  await debug('Ir al perfil');
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(10000);
  await debug('Perfil cargado');

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
  
  // Multiple selectors for direct "Conectar" button
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
    } catch (e) {
      // Continue to next selector
    }
  }
  
  // If direct button found, click it and return
  if (directConnectBtn) {
    try {
      await debug('Click en botón "Conectar" directo');
      await directConnectBtn.click({ timeout: 6000, force: true });
      await page.waitForTimeout(1000);
      await debug('Flujo de conexión directa finalizado');
      return { ok: true, viaDirect: true, selector: usedSelector, noteLength: note.length };
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

  // 5) Esperar a que se renderice el contenido interno del dropdown
  const dropdownInner = page
    .locator('div.artdeco-dropdown__content-inner')
    .last();

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

  // 7) Pequeña espera para que LinkedIn procese la acción
  await page.waitForTimeout(800);

  await debug('Flujo de conexión por dropdown finalizado');

  // Podrías extender esto para rellenar nota si LinkedIn abre un modal de "Añadir nota".
  // Devolvemos un resultado simple para que aparezca en toolResult.
  return { ok: true, viaPopover: true, noteLength: note.length };
}
`;

    try {
      const result = await this.playwright.runCode(code, sessionId);

      this.logger.debug(
        'browser_run_code result (sendConnection popover): ' +
          JSON.stringify(result, null, 2),
      );

      if (result?.isError) {
        return {
          ok: false,
          error: 'Playwright MCP error en browser_run_code',
          detail: result?.content ?? result,
        };
      }

      const connectionMethod = result?.viaDirect ? 'botón directo "Conectar"' : 'dropdown "Más acciones"';
      const selectorInfo = result?.selector ? ` (selector: ${result.selector})` : '';
      
      return {
        ok: true,
        profileUrl,
        notePreview: (note ?? '').slice(0, 80),
        note: `Solicitud de conexión enviada vía ${connectionMethod}${selectorInfo}.`,
        toolResult: result,
      };
    } catch (e: any) {
      this.logger.warn(`sendConnection (popover) failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }
}
