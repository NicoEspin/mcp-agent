// src/linkedin/services/linkedin-sales-navigator.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';

type SessionId = string;

@Injectable()
export class LinkedinSalesNavigatorService {
  private readonly logger = new Logger(LinkedinSalesNavigatorService.name);

  constructor(private readonly playwright: PlaywrightService) {}

  private buildSendSalesNavMessageCode(
    profileUrl: string,
    message: string,
    subject?: string,
  ) {
    return `
async (page) => {
  const profileUrl = ${JSON.stringify(profileUrl)};
  const text = ${JSON.stringify(message)};
  const providedSubjectRaw = ${JSON.stringify(subject ?? '')};

  const debug = (msg) => console.log('[salesnav-send-message]', msg, 'url=', page.url());
  const sleep = (ms) => page.waitForTimeout(ms);

  // Esperas "entre pasos" (deterministas + mini jitter)
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
        await debug(\`\${label}: candidato \${i} visible -> click\`);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await stepWait(650);
        await el.click({ timeout: 12000, force: true, ...opts });
        await stepWait(900);
        return { ok: true, usedIndex: i };
      } catch (e) {
        await debug(\`\${label}: click falló candidato \${i}\`);
      }
    }
    return { ok: false, usedIndex: -1 };
  };

  const waitAnyVisible = async (candidates, timeoutMs = 12000, pollMs = 180) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const c of candidates) {
        try {
          if ((await c.count().catch(() => 0)) && (await c.first().isVisible().catch(() => false))) {
            return c.first();
          }
        } catch {}
      }
      await sleep(pollMs);
    }
    return null;
  };

  const findOptionalVisible = async (candidates, timeoutMs = 2200, pollMs = 160) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const c of candidates) {
        try {
          const cnt = await c.count().catch(() => 0);
          if (!cnt) continue;
          const f = c.first();
          if (await f.isVisible().catch(() => false)) return f;
        } catch {}
      }
      await sleep(pollMs);
    }
    return null;
  };

  const waitEnabled = async (loc, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if ((await loc.count()) && (await loc.isVisible()) && (await loc.isEnabled())) return true;
      } catch {}
      await sleep(180);
    }
    return false;
  };

  const looksLikeSalesNav = (url) => /linkedin\\.com\\/sales\\b|sales-navigator/i.test(url);

  const deriveSubject = (msg) => {
    const s = String(msg || '').replace(/\\s+/g, ' ').trim();
    if (!s) return 'Hello';
    // Tomamos un resumen corto, evitando que quede vacío
    const cut = s.slice(0, 64).trim();
    return cut || 'Hello';
  };

  const safeFill = async (loc, value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await stepWait(250);
      await loc.click({ timeout: 8000 }).catch(() => {});
      await stepWait(150);
      try { await loc.fill(''); } catch {}
      await stepWait(120);
      try {
        await loc.type(v, { delay: 6 });
      } catch {
        await loc.fill(v);
      }
      await stepWait(200);
      return true;
    } catch {
      return false;
    }
  };

  const getMainScope = async () => {
    const mains = page.locator('main');
    const c = await mains.count().catch(() => 0);
    const main = c > 1 ? mains.last() : mains.first();

    const topCard = main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
    const scope = (await topCard.count().catch(() => 0)) ? topCard : main;
    return { main, scope };
  };

  // -----------------------------
  // 1) Ir al perfil (LinkedIn)
  // -----------------------------
  await debug('goto profile');
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await stepWait(1800);
  await debug('profile loaded');

  const { main, scope } = await getMainScope();

  // Si ya estamos en Sales Navigator por alguna razón, saltamos el overflow.
  const alreadySalesNav =
    looksLikeSalesNav(page.url()) ||
    (await page.locator('button[data-anchor-send-inmail], textarea[name="message"]').first().isVisible().catch(() => false));

  let salesPage = page;

  if (!alreadySalesNav) {
    // -----------------------------
    // 2) Click "More / Más" (overflow)
    // -----------------------------
    await debug('finding overflow "More actions"');

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
        await debug(\`overflow retry attempt \${attempt + 1}\`);
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
    await debug('waiting dropdown');
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

    await debug('dropdown visible');

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
      await debug('sales nav opened in new page');
      await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(800);
    } else {
      salesPage = page;
      await debug('sales nav opened in same page (or navigation completed)');
      await stepWait(1600);
    }
  } else {
    await debug('already on Sales Navigator context, skipping overflow');
  }

  // -----------------------------
  // 4) En Sales Navigator: click "Message"
  // -----------------------------
  await debug('sales page url=' + salesPage.url());
  await stepWait(1600);

  await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
  await stepWait(1200);

  const messageBtnCandidates = [
    // data-anchor
    salesPage.locator('button[data-anchor-send-inmail]').first(),
    salesPage.locator('button[data-anchor-send-inmail=""]').first(),

    // rol
    salesPage.getByRole('button', { name: /message|mensaje/i }).first(),

    // texto
    salesPage.locator('button').filter({ hasText: /^Message$/i }).first(),
    salesPage.locator('button').filter({ hasText: /^Mensaje$/i }).first(),

    // clases SN
    salesPage.locator('button._message-cta_1xow7n, button._cta_1xow7n').first(),
    salesPage.locator('button[class*="_message-cta"]').first(),
    salesPage.locator('button[class*="message"][class*="cta"]').first(),

    // aria-label
    salesPage.locator('button[aria-label*="Message" i], button[aria-label*="Mensaje" i]').first(),
  ];

  let messageClicked = false;
  for (let attempt = 0; attempt < 3 && !messageClicked; attempt++) {
    if (attempt > 0) await stepWait(1400 + attempt * 900);
    const res = await clickFirstWorking('salesnav-message-cta', messageBtnCandidates);
    messageClicked = res.ok;
  }

  if (!messageClicked) {
    throw new Error('No se encontró / no se pudo clickear el botón "Message" en Sales Navigator.');
  }

  // -----------------------------
  // 4.5) Detectar compose root (para scoped selectors)
  // -----------------------------
  await debug('waiting compose container');
  await stepWait(900);

  const composeRoots = [
    salesPage.locator('form[id*="compose-form"]').last(),
    salesPage.locator('form').filter({ has: salesPage.locator('textarea[name="message"], textarea[id*="compose-form-text"], [role="textbox"][contenteditable="true"]') }).last(),
    salesPage.locator('div[role="dialog"]').last(),
    salesPage.locator('section[role="dialog"]').last(),
    salesPage.locator('div').filter({ has: salesPage.locator('input[id*="compose-form-subject"], input[aria-label*="Subject" i], textarea[name="message"]') }).last(),
  ];

  const composeRoot = (await waitAnyVisible(composeRoots, 12000, 200)) || salesPage.locator('body');
  await debug('compose root ready');

  // -----------------------------
  // 5) Subject (opcional según UI)
  // -----------------------------
  await debug('checking subject input existence');

  const subjectCandidates = [
    // tu input exacto + variantes por atributos
    composeRoot.locator('input._subject-field_jrrmou').first(),
    composeRoot.locator('input[class*="_subject-field"]').first(),
    composeRoot.locator('input[id*="compose-form-subject"]').first(),
    composeRoot.locator('input[placeholder*="Subject" i]').first(),
    composeRoot.locator('input[aria-label*="Subject" i]').first(),
    composeRoot.locator('input[aria-label*="Asunto" i]').first(),
    composeRoot.locator('input[aria-label*="subject" i]').first(),

    // fallbacks fuera del scope
    salesPage.locator('input._subject-field_jrrmou').first(),
    salesPage.locator('input[class*="_subject-field"]').first(),
    salesPage.locator('input[id*="compose-form-subject"]').first(),
    salesPage.locator('input[placeholder*="Subject" i]').first(),
    salesPage.locator('input[aria-label*="Subject" i]').first(),
    salesPage.locator('input[aria-label*="Asunto" i]').first(),

    // fallback “input text dentro de compose form”
    composeRoot.locator('form').locator('input[type="text"]').first(),
    salesPage.locator('form[id*="compose-form"]').locator('input[type="text"]').first(),
  ];

  const subjectBox = await findOptionalVisible(subjectCandidates, 2400, 160);

  let subjectWasRequiredUI = false;
  let subjectUsed = null;

  if (subjectBox) {
    const aria = await subjectBox.getAttribute('aria-label').catch(() => null);
    const ph = await subjectBox.getAttribute('placeholder').catch(() => null);

    subjectWasRequiredUI =
      /required/i.test(String(aria || '')) ||
      /required/i.test(String(ph || ''));

    const providedSubject = String(providedSubjectRaw || '').trim();
    subjectUsed = (providedSubject && providedSubject.length ? providedSubject : deriveSubject(text));

    await debug('subject input found -> filling subject: ' + subjectUsed);
    const okFill = await safeFill(subjectBox, subjectUsed);

    // si por alguna razón falló, reintentar una vez
    if (!okFill) {
      await stepWait(450);
      await safeFill(subjectBox, subjectUsed);
    }

    await stepWait(450);
  } else {
    await debug('subject input NOT present -> skipping subject');
  }

  // -----------------------------
  // 6) Textarea: escribir mensaje
  // -----------------------------
  await debug('waiting message textarea');
  await stepWait(700);

  const textareaCandidates = [
    // exactos / típicos SN
    composeRoot.locator('textarea[name="message"]').first(),
    composeRoot.locator('textarea[aria-label*="Type your message" i]').first(),
    composeRoot.locator('textarea[placeholder*="Type your message" i]').first(),
    composeRoot.locator('textarea#compose-form-text-ember').first(),
    composeRoot.locator('textarea[id*="compose-form-text"]').first(),
    composeRoot.locator('textarea._message-field_jrrmou').first(),
    composeRoot.locator('textarea[class*="_message-field"]').first(),

    // fallbacks fuera del scope
    salesPage.locator('textarea[name="message"]').first(),
    salesPage.locator('textarea[id*="compose-form-text"]').first(),
    salesPage.locator('textarea._message-field_jrrmou').first(),
    salesPage.locator('textarea[class*="_message-field"]').first(),
    salesPage.locator('textarea').first(),

    // ultra fallback (contenteditable)
    composeRoot.locator('[role="textbox"][contenteditable="true"]').first(),
    salesPage.locator('[role="textbox"][contenteditable="true"]').first(),
  ];

  const box = await waitAnyVisible(textareaCandidates, 16000, 220);
  if (!box) {
    throw new Error('No se encontró el textarea / textbox de Sales Navigator para escribir el mensaje.');
  }

  await box.scrollIntoViewIfNeeded().catch(() => {});
  await stepWait(350);
  await box.click({ timeout: 12000 }).catch(() => {});
  await stepWait(250);

  try { await box.fill(''); } catch {}
  await stepWait(180);

  try {
    await box.type(text, { delay: 7 });
  } catch {
    await box.fill(text);
  }

  await debug('message typed');
  await stepWait(650);

  // -----------------------------
  // 7) Click "Send"
  // -----------------------------
  await debug('finding send button');

  // Preferir el form ancestro si existe
  let form = box.locator('xpath=ancestor::form[1]');
  if (!(await form.count().catch(() => 0))) {
    form = composeRoot.locator('form').last();
    if (!(await form.count().catch(() => 0))) form = salesPage.locator('form').last();
  }

  const sendBtnCandidates = [
    // data-sales-action
    form.locator('button[data-sales-action]').filter({ hasText: /send|enviar/i }).first(),
    composeRoot.locator('button[data-sales-action]').filter({ hasText: /send|enviar/i }).first(),
    salesPage.locator('button[data-sales-action]').filter({ hasText: /send|enviar/i }).first(),

    // texto
    form.locator('button').filter({ hasText: /^Send$/i }).first(),
    composeRoot.locator('button').filter({ hasText: /^Send$/i }).first(),
    salesPage.locator('button').filter({ hasText: /^Send$/i }).first(),
    form.locator('button').filter({ hasText: /^Enviar$/i }).first(),
    composeRoot.locator('button').filter({ hasText: /^Enviar$/i }).first(),
    salesPage.locator('button').filter({ hasText: /^Enviar$/i }).first(),

    // rol
    composeRoot.getByRole('button', { name: /send|enviar/i }).first(),
    salesPage.getByRole('button', { name: /send|enviar/i }).first(),

    // clases típicas SN
    composeRoot.locator('button._primary_ps32ck, button[class*="_primary"]').filter({ hasText: /send|enviar/i }).first(),
    salesPage.locator('button._primary_ps32ck, button[class*="_primary"]').filter({ hasText: /send|enviar/i }).first(),

    // submit
    form.locator('button[type="submit"]').filter({ hasText: /send|enviar/i }).first(),
    composeRoot.locator('button[type="submit"]').filter({ hasText: /send|enviar/i }).first(),
    salesPage.locator('button[type="submit"]').filter({ hasText: /send|enviar/i }).first(),
  ];

  let sendVia = 'unknown';
  let sent = false;

  let sendBtn = await findOptionalVisible(sendBtnCandidates, 5000, 200);

  if (!sendBtn) {
    await debug('send button not found -> fallback Enter');
    await salesPage.keyboard.press('Enter').catch(() => {});
    await stepWait(900);
    sent = true;
    sendVia = 'enter-fallback';
  } else {
    const ariaDisabled = await sendBtn.getAttribute('aria-disabled').catch(() => null);
    const disabled = ariaDisabled === 'true';

    if (disabled) {
      await debug('send is aria-disabled=true -> trying to trigger input events');
      await box.evaluate((el) => {
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
        catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      }).catch(() => {});
      await stepWait(500);
    }

    const enabled = await waitEnabled(sendBtn, 7000);
    if (!enabled) {
      await debug('send not enabled -> fallback Enter');
      await salesPage.keyboard.press('Enter').catch(() => {});
      await stepWait(900);
      sent = true;
      sendVia = 'enter-fallback-2';
    } else {
      await sendBtn.scrollIntoViewIfNeeded().catch(() => {});
      await stepWait(450);
      await sendBtn.click({ timeout: 12000, force: true }).catch(async () => {
        await debug('send click failed -> fallback Enter');
        await salesPage.keyboard.press('Enter').catch(() => {});
      });

      await stepWait(1100);
      await debug('send action executed');
      sent = true;
      sendVia = 'send-button';
    }
  }

  // -----------------------------
  // 8) Cerrar chat / compose (X)
  // -----------------------------
  await debug('closing compose/chat');
  await stepWait(650);

  const closeCandidates = [
    // aria-label / title típicos
    composeRoot.locator('button[aria-label*="Close" i]').first(),
    composeRoot.locator('button[aria-label*="Cerrar" i]').first(),
    composeRoot.locator('button[aria-label*="Dismiss" i]').first(),
    composeRoot.locator('button[title*="Close" i]').first(),
    composeRoot.locator('button[title*="Cerrar" i]').first(),

    // íconos close comunes (svg / use)
    composeRoot.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('use[href*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('svg[aria-label*="close" i]').locator('xpath=ancestor::button[1]'),

    // tu span class + path (X) -> subir a button/div clickeable
    composeRoot.locator('span._icon_ps32ck').first(),
    composeRoot.locator('span[class*="_icon"]').first(),
    composeRoot.locator('svg:has(path[d^="M14 3.41L9.41 8"])').locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),
    composeRoot.locator('path[d^="M14 3.41L9.41 8"]').locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),

    // fallbacks globales por si el composeRoot no incluye header
    salesPage.locator('button[aria-label*="Close" i]').last(),
    salesPage.locator('button[aria-label*="Cerrar" i]').last(),
    salesPage.locator('button[title*="Close" i]').last(),
    salesPage.locator('button[title*="Cerrar" i]').last(),
    salesPage.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    salesPage.locator('span._icon_ps32ck').last(),
    salesPage.locator('path[d^="M14 3.41L9.41 8"]').locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),
  ];

  let closed = false;
  let closeVia = 'none';

  for (let attempt = 0; attempt < 3 && !closed; attempt++) {
    if (attempt > 0) await stepWait(700 + attempt * 350);

    const res = await clickFirstWorking('close-compose', closeCandidates, { force: true });
    if (res.ok) {
      closed = true;
      closeVia = 'click-x';
      break;
    }
  }

  if (!closed) {
    await debug('close click failed -> fallback ESC');
    await salesPage.keyboard.press('Escape').catch(() => {});
    await stepWait(450);
    await salesPage.keyboard.press('Escape').catch(() => {});
    await stepWait(450);

    // chequear si el textarea desapareció / dejó de estar visible
    const stillVisible = await box.isVisible().catch(() => false);
    closed = !stillVisible ? true : false;
    closeVia = closed ? 'escape' : 'escape-attempted';
  }

  return {
    ok: true,
    sent,
    sendVia,
    subject: {
      uiHadSubjectInput: !!subjectBox,
      uiLookedRequired: subjectWasRequiredUI,
      used: subjectUsed,
    },
    closeChat: {
      ok: closed,
      via: closeVia,
    },
    length: text.length,
    url: salesPage.url(),
  };
}
`;
  }

  async sendSalesNavigatorMessage(
    sessionId: SessionId,
    profileUrl: string,
    message: string,
    subject?: string,
  ) {
    const startTime = Date.now();

    const verboseResult = {
      ok: true,
      sessionId,
      profileUrl,
      messagePreview: message.slice(0, 80),
      messageLength: message.length,
      subjectPreview: (subject ?? '').slice(0, 80),
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_runCode_sales_navigator',
        steps: [] as string[],
        errors: [] as any[],
        codeLength: 0,
      },
      result: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Building Sales Navigator runCode',
      );
      const code = this.buildSendSalesNavMessageCode(
        profileUrl,
        message,
        subject,
      );
      verboseResult.executionDetails.codeLength = code.length;

      verboseResult.executionDetails.steps.push('Executing runCode');
      const result = await this.playwright.runCode(code, sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      verboseResult.executionDetails.steps.push('Completed');
      verboseResult.result = result;

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.ok = false;
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Error: ${e?.message ?? 'Unknown error'}`,
      );
      return verboseResult;
    }
  }
}
