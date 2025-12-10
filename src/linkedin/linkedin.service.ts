// src/linkedin/linkedin.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightMcpService } from '../mcp/playwright-mcp.service';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { StreamService } from '../stream/stream.service';

@Injectable()
export class LinkedinService {
  private readonly logger = new Logger(LinkedinService.name);
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

  private extractTools(resp: any): any[] {
    return (
      resp?.tools ??
      resp?.result?.tools ??
      resp?.data?.tools ??
      resp?.payload?.tools ??
      []
    );
  }
 private buildReadChatCode(
  profileUrl: string,
  limit: number,
  threadHint?: string,
) {
  return `
const profileUrl = ${JSON.stringify(profileUrl)};
const limit = ${JSON.stringify(limit)};
const threadHint = ${JSON.stringify(threadHint ?? '')};

const debug = (msg) => console.log('[read-chat]', msg, 'url=', page.url());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------
// 1) Ir al perfil (más corto)
// -----------------------------
await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(800);
await debug('Perfil cargado');

const main = page.locator('main').first();
const topCard = main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
const scope = (await topCard.count()) ? topCard : main;

// -----------------------------
// 2) Encontrar CTA mensaje
// -----------------------------
const findMessageButton = async () => {
  let loc = scope.locator(
    'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
  ).first();
  if (await loc.count()) return loc;

  loc = main.locator(
    'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
  ).first();
  if (await loc.count()) return loc;

  loc = scope.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
  if (await loc.count()) return loc;

  loc = main.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
  if (await loc.count()) return loc;

  return null;
};

let messageBtn = await findMessageButton();

// -----------------------------
// 3) Overflow "Más" si no hay CTA
// -----------------------------
if (!messageBtn) {
  await debug('CTA mensaje no encontrado. Probando overflow del perfil');

  const moreBtn = scope.locator(
    'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
    'button[data-view-name="profile-overflow-button"][aria-label="More"]'
  ).first();

  if (await moreBtn.count()) {
    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click({ timeout: 8000, force: true });
    await page.waitForTimeout(200);

    const msgItem = page.getByRole('menuitem', { name: /enviar mensaje|mensaje|message/i }).first();
    if (await msgItem.count()) {
      await msgItem.click({ timeout: 8000 });
    } else {
      throw new Error('No se encontró opción de mensaje en el menú Más del perfil.');
    }
  } else {
    throw new Error('No se encontró CTA de mensaje ni overflow del perfil.');
  }
} else {
  const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
  if (/para negocios|for business/i.test(aria)) {
    throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
  }

  await debug('Click CTA Enviar mensaje');
  await messageBtn.scrollIntoViewIfNeeded();
  await messageBtn.click({ timeout: 8000, force: true });
}

// -----------------------------
// 4) Esperar wrapper del overlay (TU estructura real)
// -----------------------------
await page.waitForTimeout(500);

const overlayWrapper = page
  .locator('.msg-overlay-conversation-bubble__content-wrapper')
  .last();

const inlineList = page
  .locator('.msg-s-message-list')
  .last();

// Espera rápida y con fallback
let root = null;

try {
  await overlayWrapper.waitFor({ state: 'visible', timeout: 6000 });
  root = overlayWrapper;
  await debug('Overlay wrapper detectado');
} catch {
  await inlineList.waitFor({ state: 'visible', timeout: 6000 });
  root = inlineList;
  await debug('Inline message list detectado');
}

if (!root) throw new Error('No se detectó contenedor de conversación.');

// -----------------------------
// 5) Extracción rápida por eventos
// -----------------------------
const payload = await root.evaluate(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();

  // El UL vive dentro de .msg-s-message-list
  const events = Array.from(
    document.querySelectorAll('li.msg-s-message-list__event')
  );

  // Cap duro para evitar timeouts por DOM gigante
  const capped = events.slice(0, 160);

  const msgs = [];

  for (const li of capped) {
    const nameEl = li.querySelector('.msg-s-message-group__name');
    const timeEl = li.querySelector('time.msg-s-message-group__timestamp');
    const bodyEl = li.querySelector('p.msg-s-event-listitem__body');

    const text = norm(bodyEl?.textContent);
    if (!text) continue;

    // El link suele ser ancestor del span name
    const linkEl =
      nameEl?.closest('a') ||
      li.querySelector('a.msg-s-message-group__profile-link') ||
      li.querySelector('a[data-test-app-aware-link]');

    msgs.push({
      senderName: norm(nameEl?.textContent) || null,
      senderProfileUrl: linkEl?.getAttribute('href') || null,
      time: norm(timeEl?.textContent) || null,
      text,
    });
  }

  // Dedupe simple
  const seen = new Set();
  const deduped = [];
  for (const m of msgs) {
    const key = [m.senderName ?? '', m.time ?? '', m.text ?? ''].join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  // Detectar si el contenedor está “column-reversed”
  const reversed = !!document.querySelector('.msg-s-message-list-container--column-reversed');

  const ordered = reversed ? deduped.reverse() : deduped;

  return {
    ok: true,
    totalFound: ordered.length,
    reversed,
    messages: ordered,
  };
});

let msgs = Array.isArray(payload?.messages) ? payload.messages : [];
if (msgs.length > limit) msgs = msgs.slice(-limit);

const result = {
  ok: true,
  limit,
  totalFound: payload?.totalFound ?? msgs.length,
  reversed: payload?.reversed ?? false,
  extractedAt: new Date().toISOString(),
  threadHint: threadHint || undefined,
  messages: msgs,
};

return JSON.stringify(result);
`;
}


  private async hasTool(name: string) {
    const res = await this.mcp.listTools();
    const tools = this.extractTools(res);
    return tools.some((t: any) => t?.name === name);
  }
  // --------- Helper robusto para leer texto de tool result ---------
  private extractFirstText(result: any): string | null {
    if (!result) return null;

    if (typeof result === 'string') return result;

    const content =
      result?.content ??
      result?.result?.content ??
      result?.data?.content ??
      result?.payload?.content;

    if (Array.isArray(content)) {
      const textPart = content.find(
        (c: any) => c?.type === 'text' && typeof c?.text === 'string',
      );
      if (textPart) return textPart.text;
    }

    if (typeof result?.text === 'string') return result.text;
    if (typeof result?.content === 'string') return result.content;

    return null;
  }

  // ----------------------------
  // 1) Screenshot del perfil
  // ----------------------------
  // ✅ Nueva versión sin browser_run_code
  private async captureProfileScreenshot(profileUrl: string): Promise<{
    base64: string;
    mimeType: string;
  }> {
    // Validamos tool navigate
    const canNavigate = await this.hasTool('browser_navigate');
    if (!canNavigate) {
      throw new Error(
        'Tu servidor MCP no expone browser_navigate. Revisá flags/caps del MCP.',
      );
    }

    // 1) Navegar al perfil
    await this.mcp.callTool('browser_navigate', { url: profileUrl });

    // 2) Espera breve para que la top card cargue
    await new Promise((r) => setTimeout(r, 1200));

    // 3) Tomar screenshot usando el pipeline que ya te funciona
    // Si el stream está activo, esto sigue siendo seguro.
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

  // ----------------------------
  // 2) Check Connection (IA)
  // ----------------------------
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
- false => NO están conectados o aparece un CTA que indica que hay que enviar solicitud
          (por ejemplo: "Conectar", "Connect", "Seguir", "Follow", "Mensaje" sin indicación de conexión, etc.).

Pistas visuales típicas:
- "1er/1st" suele indicar conexión.
- Botón "Conectar/Connect" suele indicar NO conexión.
- "Pendiente/Pending" también debe considerarse false.
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

    // Fallback super conservador
    const hasTrue = /\btrue\b/i.test(out);
    const hasFalse = /\bfalse\b/i.test(out);

    if (hasTrue && !hasFalse) return true;
    if (hasFalse && !hasTrue) return false;

    this.logger.warn(`checkConnection: salida inesperada del modelo: ${out}`);

    // Por seguridad funcional: si no estamos seguros, asumimos NO conectado.
    return false;
  }
  async readChat(profileUrl: string, limit = 30, threadHint?: string) {
    const canRunCode = await this.hasTool('browser_run_code');

    if (!canRunCode) {
      // Fallback opcional: snapshot si existiera
      const canSnapshot = await this.hasTool('browser_snapshot');
      if (!canSnapshot) {
        return {
          ok: false,
          error:
            'Tu servidor MCP no expone browser_run_code ni browser_snapshot. Actualizá @playwright/mcp.',
        };
      }

      // En un primer MVP, si no hay run_code, devolvé error claro.
      return {
        ok: false,
        error:
          'Modo snapshot-only no implementado aún para read-chat. Requiere browser_run_code para abrir la conversación de forma fiable.',
      };
    }

    const code = this.buildReadChatCode(profileUrl, limit, threadHint);

    try {
      const result: any = await this.mcp.callTool('browser_run_code', { code });

      if (result?.isError) {
        return {
          ok: false,
          error: 'Playwright MCP error en browser_run_code',
          detail: result?.content ?? result,
        };
      }

      const txt = this.extractFirstText(result) ?? '';
      let parsed: any = null;

      try {
        parsed = JSON.parse(txt);
      } catch {
        // si el script decidió loguear algo textual
      }

      return {
        ok: true,
        profileUrl,
        limit,
        data: parsed ?? { raw: txt },
        toolResult: result,
      };
    } catch (e: any) {
      this.logger.warn(`readChat failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }

  async sendMessage(profileUrl: string, message: string) {
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
const text = ${JSON.stringify(message)};

const debug = async (msg) => {
  console.log('[send-message]', msg, 'url=', page.url());
};

// 1) Ir al perfil
await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1200);
await debug('Perfil cargado');

// ---------- Helpers ----------
const main = page.locator('main').first();

// Scope preferido: top card / acciones de perfil si existe
// (Saco el data-view-name*="profile" para evitar scopes demasiado chicos)
const topCard =
  main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();

const scope = (await topCard.count()) ? topCard : main;

// ---------- 2) Encontrar CTA "Enviar mensaje" (según tu HTML real) ----------
const findMessageButton = async () => {
  // 1) Más directo: aria-label del botón real
  let loc = scope.locator(
    'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
  ).first();
  if (await loc.count()) return loc;

  // 1.b) Si el scope no lo ve, probar en main
  loc = main.locator(
    'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
  ).first();
  if (await loc.count()) return loc;

  // 2) Por texto visible del botón
  loc = scope.locator('button, a').filter({
    hasText: /enviar mensaje|message/i,
  }).first();
  if (await loc.count()) return loc;

  // 2.b) Fallback en main
  loc = main.locator('button, a').filter({
    hasText: /enviar mensaje|message/i,
  }).first();
  if (await loc.count()) return loc;

  // 3) Por icono real <use href="#send-privately-small">
  const icon = scope.locator(
    'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
    'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
  ).first();

  if (await icon.count()) {
    const btn = icon.locator('xpath=ancestor::button[1]').first();
    if (await btn.count()) return btn;
  }

  // 3.b) Fallback de icono en main
  const icon2 = main.locator(
    'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
    'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
  ).first();

  if (await icon2.count()) {
    const btn = icon2.locator('xpath=ancestor::button[1]').first();
    if (await btn.count()) return btn;
  }

  return null;
};

let messageBtn = await findMessageButton();

// ---------- 3) Fallback controlado: "Más" del perfil ----------
if (!messageBtn) {
  await debug('CTA no encontrado. Probando overflow del perfil');

  const moreBtn = scope.locator(
    'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
    'button[data-view-name="profile-overflow-button"][aria-label="More"]'
  ).first();

  if (await moreBtn.count()) {
    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click({ timeout: 15000, force: true });
    await page.waitForTimeout(250);

    const msgItem = page.getByRole('menuitem', {
      name: /enviar mensaje|mensaje|message/i,
    }).first();

    if (await msgItem.count()) {
      await msgItem.click({ timeout: 15000 });
    } else {
      throw new Error('No se encontró opción de mensaje en el menú Más del perfil.');
    }
  } else {
    throw new Error('No se encontró CTA de mensaje ni overflow del perfil.');
  }
} else {
  // Guard anti-header
  const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
  if (/para negocios|for business/i.test(aria)) {
    throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
  }

  await debug('Click CTA Enviar mensaje');
  await messageBtn.scrollIntoViewIfNeeded();
  await messageBtn.click({ timeout: 15000, force: true });
}

// ---------- 4) Esperar drawer + textbox (según tu textarea real) ----------
const waitForMessageBox = async (timeout = 12000) => {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    let candidate = page
      .locator(
        'div.msg-form__contenteditable[role="textbox"][contenteditable="true"]'
      )
      .first();

    if ((await candidate.count()) && (await candidate.isVisible())) {
      return candidate;
    }

    candidate = page
      .getByRole('textbox', {
        name: /escribe un mensaje|write a message/i,
      })
      .first();

    if ((await candidate.count()) && (await candidate.isVisible())) {
      return candidate;
    }

    await page.waitForTimeout(200);
  }

  return null;
};

await page.waitForTimeout(900);

const box = await waitForMessageBox();
if (!box) {
  throw new Error('No se encontró el textarea de mensajes.');
}

await box.click({ timeout: 15000 });

// contenteditable: priorizar type para disparar eventos reales
await box.type(text, { delay: 5 }).catch(async () => {
  await box.fill(text);
});

await debug('Mensaje escrito');
await page.waitForTimeout(250);

// ---------- 6) Botón Enviar real ----------
const waitEnabled = async (loc, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (
        (await loc.count()) &&
        (await loc.isVisible()) &&
        (await loc.isEnabled())
      ) {
        return true;
      }
    } catch {}
    await page.waitForTimeout(120);
  }
  return false;
};

// 6.1) Intentar obtener el form real desde el textbox
let form = box.locator('xpath=ancestor::form[1]');
if (!(await form.count())) {
  form = page.locator('form.msg-form, form[data-view-name*="message"]').last();
}

// 6.2) Buscar botón Enviar dentro del form
let sendBtn = form.locator('button.msg-form__send-button[type="submit"]').first();

if (!(await sendBtn.count())) {
  sendBtn = form.locator('button[type="submit"]').filter({ hasText: /enviar/i }).first();
}

// 6.3) Si el botón no está habilitado, forzar eventos
if (await sendBtn.count()) {
  const enabled = await waitEnabled(sendBtn, 4000);

  if (!enabled) {
    await debug('Send button parece deshabilitado, forzando input events');

    await box.evaluate((el) => {
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
    });

    await page.waitForTimeout(250);
  }
}

// 6.4) Click con espera más generosa
if (await sendBtn.count()) {
  await sendBtn.scrollIntoViewIfNeeded();
  const ok = await waitEnabled(sendBtn, 8000);

  if (ok) {
    await debug('Click Enviar (form-scoped)');
    await sendBtn.click({ timeout: 15000, force: true });
  } else {
    await debug('Send button no habilitó, fallback Enter');
    await page.keyboard.press('Enter');
  }
} else {
  const globalSend = page.locator('button.msg-form__send-button').last();
  if (await globalSend.count()) {
    await globalSend.scrollIntoViewIfNeeded();
    await globalSend.click({ timeout: 15000, force: true });
  } else {
    await page.keyboard.press('Enter');
  }
}

await page.waitForTimeout(400);
await debug('Acción de envío ejecutada');
`;

    try {
      const result: any = await this.mcp.callTool('browser_run_code', { code });

      this.logger.debug(
        'browser_run_code result: ' + JSON.stringify(result, null, 2),
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
        messagePreview: message.slice(0, 80),
        note: 'Mensaje intentado vía browser_run_code usando el contexto compartido.',
        toolResult: result,
      };
    } catch (e: any) {
      this.logger.warn(`sendMessage failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }

  // ----------------------------
  // NUEVO
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
const noteText = ${JSON.stringify(note ?? '')};

const debug = async (msg) => {
  console.log('[send-connection]', msg, 'url=', page.url());
};

// 1) Ir al perfil
await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1200);
await debug('Perfil cargado');

// ---------- Helpers de scope ----------
const main = page.locator('main');

const topCard =
  main.locator('[data-view-name*="profile"], .pv-top-card, .pv-top-card-v2-ctas').first();

const scope = (await topCard.count()) ? topCard : main;

// Helpers para encontrar clickable desde un icono SVG
const getClickableFromIcon = async (iconLocator) => {
  if (!(await iconLocator.count())) return null;

  const btnAncestor = iconLocator.locator('xpath=ancestor::button[1]');
  if (await btnAncestor.count()) return btnAncestor;

  const linkAncestor = iconLocator.locator('xpath=ancestor::a[1]');
  if (await linkAncestor.count()) return linkAncestor;

  const spanAncestor = iconLocator.locator('xpath=ancestor::span[1]');
  if (await spanAncestor.count()) return spanAncestor;

  const divAncestor = iconLocator.locator('xpath=ancestor::div[1]');
  if (await divAncestor.count()) return divAncestor;

  return null;
};

const findConnectCta = async () => {
  // A) Preferido: icono connect dentro del scope
  const icon = scope.locator('svg#connect-small').first();
  let cta = await getClickableFromIcon(icon);
  if (cta) return cta;

  // B) Fallback por texto dentro del scope (evita header global)
  const byText = scope.locator('button, a').filter({
    hasText: /conectar|connect/i,
  }).first();

  if (await byText.count()) return byText;

  return null;
};

// Estratégia para overflow "tres puntos" variante mobile/web-ios
const clickOverflowAndFindConnect = async () => {
  const overflowIcon = scope.locator('svg#overflow-web-ios-small').first();
  const overflowBtn = await getClickableFromIcon(overflowIcon);

  if (overflowBtn && (await overflowBtn.count())) {
    await debug('Click overflow (overflow-web-ios-small)');
    await overflowBtn.scrollIntoViewIfNeeded();
    await overflowBtn.click({ timeout: 15000, force: true });
    await page.waitForTimeout(250);

    // Buscar item del menú por rol
    let item = page.getByRole('menuitem', {
      name: /conectar|connect/i,
    }).first();

    if (await item.count()) {
      await item.click({ timeout: 15000 });
      return true;
    }

    // Fallback por texto genérico cerca del menú abierto
    item = page.locator('button, a, div, span').filter({
      hasText: /conectar|connect/i,
    }).first();

    if (await item.count()) {
      await item.click({ timeout: 15000, force: true });
      return true;
    }
  }

  return false;
};

// Fallback adicional al overflow clásico del perfil ("Más/More")
const clickProfileMoreAndFindConnect = async () => {
  const moreBtn = scope.locator(
    'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
    'button[data-view-name="profile-overflow-button"][aria-label="More"]'
  ).first();

  if (!(await moreBtn.count())) return false;

  await debug('Click Más/More del perfil');
  await moreBtn.scrollIntoViewIfNeeded();
  await moreBtn.click({ timeout: 15000, force: true });
  await page.waitForTimeout(250);

  let item = page.getByRole('menuitem', {
    name: /conectar|connect/i,
  }).first();

  if (await item.count()) {
    await item.click({ timeout: 15000 });
    return true;
  }

  item = page.locator('button, a, div, span').filter({
    hasText: /conectar|connect/i,
  }).first();

  if (await item.count()) {
    await item.click({ timeout: 15000, force: true });
    return true;
  }

  return false;
};

// 2) Intentar CTA directo
let connectBtn = await findConnectCta();

if (connectBtn) {
  // Guard anti-header (por si el selector se fue de scope)
  const aria = (await connectBtn.getAttribute('aria-label')) ?? '';
  if (/para negocios|for business/i.test(aria)) {
    throw new Error('Selector de Conectar resolvió a un botón del header. Ajustar scope.');
  }

  await debug('Click CTA Conectar (directo)');
  await connectBtn.scrollIntoViewIfNeeded();
  await connectBtn.click({ timeout: 15000, force: true });
} else {
  await debug('CTA directo no encontrado. Probando overflow.');

  const okOverflow = await clickOverflowAndFindConnect();
  if (!okOverflow) {
    await debug('Overflow web-ios no disponible. Probando Más/More del perfil.');
    const okMore = await clickProfileMoreAndFindConnect();

    if (!okMore) {
      throw new Error('No se encontró CTA Conectar ni opciones de overflow del perfil.');
    }
  }
}

// 3) Esperar posible diálogo de invitación
const waitDialog = async (timeout = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const dlg = page.getByRole('dialog').last();
    if ((await dlg.count()) && (await dlg.isVisible())) return dlg;
    await page.waitForTimeout(200);
  }
  return null;
};

await page.waitForTimeout(600);

const dialog = await waitDialog();

// 4) Si hay dialog, opcionalmente añadir nota y enviar
if (dialog) {
  await debug('Dialog de conexión detectado');

  if (noteText && noteText.trim().length) {
    // Intentar botón "Añadir nota"
    const addNoteBtn = dialog.getByRole('button', {
      name: /añadir nota|agregar nota|add a note/i,
    }).first();

    if (await addNoteBtn.count()) {
      await addNoteBtn.click({ timeout: 15000, force: true });
      await page.waitForTimeout(250);

      // Campo de nota (textarea o contenteditable)
      let noteBox = dialog.locator('textarea').first();

      if (!(await noteBox.count())) {
        noteBox = dialog.locator('div[role="textbox"][contenteditable="true"]').first();
      }

      if (await noteBox.count()) {
        await noteBox.click({ timeout: 15000 });
        await noteBox.fill(noteText).catch(async () => {
          await noteBox.type(noteText, { delay: 5 });
        });
        await debug('Nota escrita');
      }
    }
  }

  // Botón Enviar/Send dentro del dialog
  let sendBtn = dialog.getByRole('button', {
    name: /enviar|send/i,
  }).first();

  if (!(await sendBtn.count())) {
    sendBtn = dialog.locator('button').filter({ hasText: /enviar|send/i }).first();
  }

  if (await sendBtn.count()) {
    await sendBtn.scrollIntoViewIfNeeded();
    await debug('Click Enviar invitación');
    await sendBtn.click({ timeout: 15000, force: true });
  } else {
    throw new Error('No se encontró el botón Enviar en el diálogo de conexión.');
  }
} else {
  // 5) Si no hay diálogo, puede haber enviado directo
  await debug('No se detectó diálogo. Verificando estado de invitación.');
}

// 6) Verificación suave de estado
await page.waitForTimeout(800);

const pendingMarkers = page.locator('button, span, div').filter({
  hasText: /pendiente|pending|invitation sent|invitación enviada/i,
}).first();

const maybePending = (await pendingMarkers.count()) ? true : false;

await debug('Flujo de conexión finalizado');

return { ok: true, maybePending };
`;

    try {
      const result: any = await this.mcp.callTool('browser_run_code', { code });

      this.logger.debug(
        'browser_run_code result: ' + JSON.stringify(result, null, 2),
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
        note: 'Solicitud de conexión intentada vía browser_run_code usando el contexto compartido.',
        toolResult: result,
      };
    } catch (e: any) {
      this.logger.warn(`sendConnection failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }
}
