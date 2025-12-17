// src/linkedin/services/linkedin-chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { extractFirstText } from '../utils/mcp-utils';

type SessionId = string;

@Injectable()
export class LinkedinChatService {
  private readonly logger = new Logger(LinkedinChatService.name);

  constructor(private readonly playwright: PlaywrightService) {}
  private buildCloseChatCode() {
    return `
async (page) => {
  const debug = (msg) => console.log('[close-chat]', msg, 'url=', page.url());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const firstVisible = async (loc) => {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {}
    }
    return null;
  };

  const iconSel = 'svg[data-test-icon="close-small"], use[href="#close-small"]';

  // Prefer overlay root to avoid clicking random close icons elsewhere
  const overlayRoot = page.locator(
    '.msg-overlay-container, .msg-overlay-list-bubble, .msg-overlay-conversation-bubble'
  ).first();

  // Prefer: last visible bubble (most likely the one we opened)
  const bubble = page.locator('.msg-overlay-conversation-bubble:visible').last();

  // Capture a "before" snapshot of visible bubbles (best-effort)
  const beforeVisibleBubbles = await page.locator('.msg-overlay-conversation-bubble:visible').count().catch(() => 0);

  const candidates = [];

  // 1) Bubble scoped close control with icon
  candidates.push(
    bubble
      .locator('button.msg-overlay-bubble-header__control')
      .filter({ has: bubble.locator(iconSel) })
  );

  // 2) Bubble scoped aria-label (dynamic name)
  candidates.push(
    bubble.locator(
      [
        'button[aria-label^="Cierra tu conversación"]',
        'button[aria-label^="Close your conversation"]',
        'button[aria-label^="Cerrar conversación"]',
        'button[aria-label^="Close conversation"]',
      ].join(', ')
    )
  );

  // 3) Global (but still messaging-related): header control w/ icon
  candidates.push(
    page
      .locator('button.msg-overlay-bubble-header__control')
      .filter({ has: page.locator(iconSel) })
  );

  // 4) Role/name fallback (still specific text)
  candidates.push(
    page.getByRole('button', {
      name: /cierra tu conversación|close your conversation|cerrar conversación|close conversation/i,
    })
  );

  // 5) Icon-only fallback BUT scoped to overlay area only
  candidates.push(
    overlayRoot
      .locator('button')
      .filter({ has: overlayRoot.locator('svg[data-test-icon="close-small"]') })
  );
  candidates.push(
    overlayRoot
      .locator('button')
      .filter({ has: overlayRoot.locator('use[href="#close-small"]') })
  );

  let clicked = false;

  for (const loc of candidates) {
    const btn = await firstVisible(loc);
    if (!btn) continue;

    try {
      await debug('Found close candidate -> clicking');
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 8000, force: true });
      clicked = true;
      break;
    } catch {
      await debug('Click failed, trying next candidate');
    }
  }

  if (!clicked) {
    await debug('No close button found -> ESC fallback');
    try {
      await page.keyboard.press('Escape');
      await sleep(120);
      await page.keyboard.press('Escape');
    } catch {}
  }

  await sleep(250);

  // After-state checks:
  const afterVisibleBubbles = await page.locator('.msg-overlay-conversation-bubble:visible').count().catch(() => beforeVisibleBubbles);

  // Also check if the bubble we targeted is still visible (best-effort)
  const bubbleStillVisible = await bubble.isVisible().catch(() => false);

  // Consider it "closed" if bubble count decreased OR targeted bubble disappeared
  const closed = (!bubbleStillVisible) || (afterVisibleBubbles < beforeVisibleBubbles);

  return { ok: true, clicked, closed, beforeVisibleBubbles, afterVisibleBubbles };
}
`;
  }

  async closeChatOverlay(sessionId: string) {
    const code = this.buildCloseChatCode();
    return this.playwright.runCode(code, sessionId);
  }

  private buildReadChatCode(
    profileUrl: string,
    limit: number,
    threadHint?: string,
  ) {
    return `
    async (page) => {
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
// 4) Esperar wrapper del overlay
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

  const events = Array.from(
    document.querySelectorAll('li.msg-s-message-list__event')
  );

  const capped = events.slice(0, 160);
  const msgs = [];

  for (const li of capped) {
    const nameEl = li.querySelector('.msg-s-message-group__name');
    const timeEl = li.querySelector('time.msg-s-message-group__timestamp');
    const bodyEl = li.querySelector('p.msg-s-event-listitem__body');

    const text = norm(bodyEl?.textContent);
    if (!text) continue;

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

  const seen = new Set();
  const deduped = [];
  for (const m of msgs) {
    const key = [m.senderName ?? '', m.time ?? '', m.text ?? ''].join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

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
  }
`;
  }

  // -----------------------------
  // readChat multi-sesión
  // -----------------------------
  async readChat(
    sessionId: SessionId,
    profileUrl: string,
    limit = 30,
    threadHint?: string,
  ) {
    const startTime = Date.now();
    const code = this.buildReadChatCode(profileUrl, limit, threadHint);

    const verboseResult = {
      ok: true,
      profileUrl,
      limit,
      threadHint,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_direct_execution',
        codeLength: code.length,
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],
      },
      data: null as any,
      toolResult: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Generated JavaScript code for Playwright execution',
      );
      verboseResult.executionDetails.steps.push(
        `Code length: ${code.length} characters`,
      );
      verboseResult.executionDetails.steps.push(
        'Starting Playwright runCode execution',
      );

      const result = await this.playwright.runCode(code, sessionId);

      verboseResult.executionDetails.steps.push(
        'Playwright execution completed successfully',
      );
      verboseResult.executionDetails.steps.push(
        `Messages extracted: ${result?.messages?.length || 0}`,
      );

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      // Result is already the parsed data from the page evaluation
      verboseResult.data = result;
      verboseResult.toolResult = result;

      this.logger.debug(
        `readChat completed successfully in ${verboseResult.executionDetails.executionTimeMs}ms`,
      );

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

      this.logger.warn(`readChat failed: ${e?.message ?? e}`);

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        limit,
        sessionId,
      };
    }
  }

  // -----------------------------
  // sendMessage multi-sesión
  // -----------------------------
  // -----------------------------
  // sendMessage multi-sesión
  // -----------------------------
  async sendMessage(sessionId: SessionId, profileUrl: string, message: string) {
    const startTime = Date.now();

    const verboseResult = {
      ok: true,
      profileUrl,
      messagePreview: message.slice(0, 80),
      messageLength: message.length,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_direct_execution',
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],
        playwrightLogs: [] as string[],
      },
      note: null as string | null,
      result: null as any,
    };

    // Direct Playwright execution - no tool checking needed
    verboseResult.executionDetails.steps.push('Starting sendMessage execution');
    verboseResult.executionDetails.steps.push(
      `Message length: ${message.length} characters`,
    );
    verboseResult.executionDetails.steps.push(
      'Building Playwright execution code',
    );

    const code = `
async (page) => {
  const profileUrl = ${JSON.stringify(profileUrl)};
  const text = ${JSON.stringify(message)};

  const debug = async (msg) => {
    console.log('[send-message]', msg, 'url=', page.url());
    return msg;
  };

  // 1) Ir al perfil
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  await debug('Perfil cargado');

  // ---------- Helpers ----------
  const main = page.locator('main').first();

  // Scope preferido: top card / acciones de perfil si existe
  const topCard =
    main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();

  const scope = (await topCard.count()) ? topCard : main;

  // ---------- 2) Encontrar CTA "Enviar mensaje" ----------
  const findMessageButton = async () => {
    let loc = scope.locator(
      'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
    ).first();
    if (await loc.count()) return loc;

    loc = main.locator(
      'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
    ).first();
    if (await loc.count()) return loc;

    loc = scope.locator('button, a').filter({
      hasText: /enviar mensaje|message/i,
    }).first();
    if (await loc.count()) return loc;

    loc = main.locator('button, a').filter({
      hasText: /enviar mensaje|message/i,
    }).first();
    if (await loc.count()) return loc;

    const icon = scope.locator(
      'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
      'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
    ).first();

    if (await icon.count()) {
      const btn = icon.locator('xpath=ancestor::button[1]').first();
      if (await btn.count()) return btn;
    }

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
    const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
    if (/para negocios|for business/i.test(aria)) {
      throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
    }

    await debug('Click CTA Enviar mensaje');
    await messageBtn.scrollIntoViewIfNeeded();
    await messageBtn.click({ timeout: 15000, force: true });
  }

  // ---------- 4) Esperar drawer + textbox ----------
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

  await box.type(text, { delay: 5 }).catch(async () => {
    await box.fill(text);
  });

  await debug('Mensaje escrito');
  await page.waitForTimeout(250);

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

  let form = box.locator('xpath=ancestor::form[1]');
  if (!(await form.count())) {
    form = page.locator('form.msg-form, form[data-view-name*="message"]').last();
  }

  let sendBtn = form.locator('button.msg-form__send-button[type="submit"]').first();

  if (!(await sendBtn.count())) {
    sendBtn = form
      .locator('button[type="submit"]')
      .filter({ hasText: /enviar/i })
      .first();
  }

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

  // Devolvés algo simbólico para tener un resultado claro en toolResult
  return { ok: true, sent: true, length: text.length };
}
`;

    try {
      verboseResult.executionDetails.steps.push(
        `Code length: ${code.length} characters`,
      );
      verboseResult.executionDetails.steps.push('Executing Playwright code');

      const result = await this.playwright.runCode(code, sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.steps.push(
        'Playwright execution completed successfully',
      );
      verboseResult.executionDetails.steps.push(
        `Result: ${JSON.stringify(result)}`,
      );

      verboseResult.note = 'Mensaje enviado vía Playwright directo.';
      verboseResult.result = result;

      this.logger.debug(
        'playwright result: ' + JSON.stringify(result, null, 2),
      );

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

      this.logger.warn(`sendMessage failed: ${e?.message ?? 'Unknown error'}`);

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        messagePreview: message.slice(0, 80),
        sessionId,
      };
    }
  }
}
