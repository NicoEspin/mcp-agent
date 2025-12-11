// src/linkedin/services/linkedin-connection.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightMcpService } from '../../mcp/playwright-mcp.service';
import { ConfigService } from '@nestjs/config';
import { StreamService } from '../../stream/stream.service';
import OpenAI from 'openai';
import { extractTools } from '../utils/mcp-utils';

@Injectable()
export class LinkedinConnectionService {
  private readonly logger = new Logger(LinkedinConnectionService.name);
  private readonly openai: OpenAI;

  constructor(
    private readonly mcp: PlaywrightMcpService,
    private readonly config: ConfigService,
    private readonly stream: StreamService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
    });
  }

  private async hasTool(name: string) {
    const res = await this.mcp.listTools();
    const tools = extractTools(res);
    return tools.some((t: any) => t?.name === name);
  }

  private async captureProfileScreenshot(profileUrl: string): Promise<{
    base64: string;
    mimeType: string;
  }> {
    const canNavigate = await this.hasTool('browser_navigate');
    if (!canNavigate) {
      throw new Error(
        'Tu servidor MCP no expone browser_navigate. Revisá flags/caps del MCP.',
      );
    }

    await this.mcp.callTool('browser_navigate', { url: profileUrl });
    await new Promise((r) => setTimeout(r, 1200));

    const { data, mimeType } =
      await this.stream.getCachedScreenshotBase64(1200);

    if (!data) {
      throw new Error('Screenshot vacío desde MCP.');
    }

    return {
      base64: data,
      mimeType: mimeType ?? 'image/png',
    };
  }

  async checkConnection(profileUrl: string): Promise<boolean> {
    const { base64, mimeType } =
      await this.captureProfileScreenshot(profileUrl);

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
  // NUEVO sendConnection robusto
  // ----------------------------
  async sendConnection(profileUrl: string, note?: string) {
    const canRunCode = await this.hasTool('browser_run_code');

    if (!canRunCode) {
      return {
        ok: false,
        error:
          'Tu servidor MCP no expone browser_run_code. Actualizá @playwright/mcp y el SDK.',
      };
    }

    const code = `
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
await page.waitForTimeout(800);
await debug('Perfil cargado');

// 2) Localizar <main> (si hay más de uno, usamos el último)
const mains = page.locator('main');
const mainCount = await mains.count();
if (!mainCount) {
  throw new Error('No se encontró ningún <main> en el perfil.');
}
const main = mainCount > 1 ? mains.last() : mains.first();
await debug('Main elegido, count=' + mainCount);

// 3) Botón "Más acciones" (overflow del perfil)
//    Ej real:
//    <button id="ember77-profile-overflow-action" ... class="artdeco-dropdown__trigger ...">
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
await page.waitForTimeout(400);

// 4) Esperar a que se renderice el contenido interno del dropdown
//    Basado en tu HTML:
//    <div class="artdeco-dropdown__content-inner"> ... <div aria-label="Invita a X a conectar" ...>
const dropdownInner = page
  .locator('div.artdeco-dropdown__content-inner')
  .last();

await dropdownInner.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
  throw new Error('No se abrió el popover de "Más acciones" (artdeco-dropdown__content-inner).');
});

await debug('Popover de "Más acciones" visible');

// 5) Buscar el item "Conectar" dentro del dropdown interno, no en toda la página
//    Ej real que pegaste:
//    <div aria-label="Invita a Nicolás Espin a conectar"
//         role="button"
//         class="artdeco-dropdown__item ...">
let connectItem = dropdownInner
  .locator(
    'div.artdeco-dropdown__item[role="button"][aria-label*="Invita"][aria-label*="onectar"]'
  )
  .first();

// Fallback: cualquier artdeco-dropdown__item con texto visible "Conectar"
if (!(await connectItem.count())) {
  connectItem = dropdownInner
    .locator('div.artdeco-dropdown__item[role="button"] span')
    .filter({ hasText: /conectar/i })
    .first();
}

if (!(await connectItem.count())) {
  throw new Error('No se encontró el item "Conectar" dentro del dropdown de Más acciones.');
}

// 6) Asegurarse de clickear el contenedor clickable .artdeco-dropdown__item
const clickable = connectItem
  .locator('xpath=ancestor::div[contains(@class,"artdeco-dropdown__item")][1]')
  .first();

if (!(await clickable.count())) {
  throw new Error(
    'No se encontró contenedor clickable para "Conectar" (artdeco-dropdown__item).'
  );
}

await debug('Click en "Conectar" dentro del dropdown');
await clickable.click({ timeout: 6000, force: true });

// 7) Pequeña espera para que LinkedIn procese la acción
await page.waitForTimeout(800);

await debug('Flujo de conexión por popover finalizado');
return { ok: true };
`;

    try {
      const result: any = await this.mcp.callTool('browser_run_code', { code });

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

      return {
        ok: true,
        profileUrl,
        notePreview: (note ?? '').slice(0, 80),
        note: 'Solicitud de conexión enviada vía browser_run_code usando el popover de "Más acciones".',
        toolResult: result,
      };
    } catch (e: any) {
      this.logger.warn(`sendConnection (popover) failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }
}
