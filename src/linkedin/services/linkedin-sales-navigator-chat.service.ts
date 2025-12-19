import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';

type SessionId = string;

@Injectable()
export class LinkedinSalesNavigatorChatService {
  private readonly logger = new Logger(LinkedinSalesNavigatorChatService.name);

  constructor(private readonly playwright: PlaywrightService) {}

  // -----------------------------
  // Close SalesNav compose/chat
  // (para ejecutarlo DESPUÉS del verifier en controller)
  // -----------------------------
  private buildCloseSalesNavChatCode() {
    return `
async (page) => {
  const debug = (msg) => console.log('[salesnav-close-chat]', msg, 'url=', page.url());
  const sleep = (ms) => page.waitForTimeout(ms);

  const stepWait = async (baseMs) => {
    const jitter = Math.floor(Math.random() * 220);
    await sleep(baseMs + jitter);
  };

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
        await debug(\`\${label}: candidate \${i} -> click\`);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await stepWait(350);
        await el.click({ timeout: 12000, force: true, ...opts });
        await stepWait(650);
        return { ok: true, usedIndex: i };
      } catch {
        await debug(\`\${label}: click failed candidate \${i}\`);
      }
    }
    return { ok: false, usedIndex: -1 };
  };

  // Intentar scopear a dialogs/forms de compose
  const composeRoots = [
    page.locator('form[id*="compose-form"]').last(),
    page.locator('div[role="dialog"]').last(),
    page.locator('section[role="dialog"]').last(),
    page.locator('div').filter({ has: page.locator('input[id*="compose-form-subject"], textarea[name="message"], p[data-anonymize="general-blurb"]') }).last(),
  ];

  let composeRoot = null;
  for (const r of composeRoots) {
    try {
      if ((await r.count().catch(() => 0)) && (await r.first().isVisible().catch(() => false))) {
        composeRoot = r.first();
        break;
      }
    } catch {}
  }

  if (!composeRoot) composeRoot = page.locator('body');

  await debug('closing compose/chat (SalesNav)');

  const closeCandidates = [
    // aria-label / title
    composeRoot.locator('button[aria-label*="Close" i]').first(),
    composeRoot.locator('button[aria-label*="Cerrar" i]').first(),
    composeRoot.locator('button[aria-label*="Dismiss" i]').first(),
    composeRoot.locator('button[title*="Close" i]').first(),
    composeRoot.locator('button[title*="Cerrar" i]').first(),

    // icons
    composeRoot.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('use[href*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('svg[aria-label*="close" i]').locator('xpath=ancestor::button[1]'),

    // tu span class/icon
    composeRoot.locator('span._icon_ps32ck').first(),
    composeRoot.locator('span[class*="_icon"]').first(),
    composeRoot.locator('path[d^="M14 3.41L9.41 8"]').locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),

    // global fallbacks
    page.locator('button[aria-label*="Close" i]').last(),
    page.locator('button[aria-label*="Cerrar" i]').last(),
    page.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    page.locator('span._icon_ps32ck').last(),
  ];

  let closed = false;

  for (let attempt = 0; attempt < 3 && !closed; attempt++) {
    if (attempt > 0) await stepWait(700 + attempt * 350);
    const res = await clickFirstWorking('close-compose', closeCandidates, { force: true });
    if (res.ok) {
      closed = true;
      break;
    }
  }

  if (!closed) {
    await debug('close click failed -> ESC fallback');
    await page.keyboard.press('Escape').catch(() => {});
    await stepWait(300);
    await page.keyboard.press('Escape').catch(() => {});
    await stepWait(300);
  }

  return { ok: true, closed, via: closed ? 'click' : 'escape' };
}
`;
  }

  async closeSalesNavChatOverlay(sessionId: SessionId) {
    const code = this.buildCloseSalesNavChatCode();
    return this.playwright.runCode(code, sessionId);
  }

  // -----------------------------
  // Read SalesNav chat
  // -----------------------------
  private buildReadSalesNavChatCode(
    profileUrl: string,
    limit: number,
    threadHint?: string,
  ) {
    return `
async (page) => {
  const profileUrl = ${JSON.stringify(profileUrl)};
  const limit = ${JSON.stringify(limit)};
  const threadHint = ${JSON.stringify(threadHint ?? '')};

  const debug = (msg) => console.log('[salesnav-read-chat]', msg, 'url=', page.url());
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
    (await page.locator('button[data-anchor-send-inmail], textarea[name="message"], p[data-anonymize="general-blurb"]').first().isVisible().catch(() => false));

  let salesPage = page;

  if (!alreadySalesNav) {
    // -----------------------------
    // 2) Click "More / Más" (overflow)
    // -----------------------------
    await debug('finding overflow "More actions"');

    const overflowCandidates = [
      scope.locator('button[aria-label="More actions"]').first(),
      scope.locator('button[aria-label="Más acciones"]').first(),
      scope.locator('button[aria-label*="More actions" i]').first(),
      scope.locator('button[aria-label*="Más acciones" i]').first(),

      scope.locator('button[id*="profile-overflow-action"]').first(),
      scope.locator('button[id$="-profile-overflow-action"]').first(),
      scope.locator('button.artdeco-dropdown__trigger[id*="profile-overflow-action"]').first(),

      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="More"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="Más"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"]').first(),

      scope.locator('button').filter({ hasText: /^More$/ }).first(),
      scope.locator('button').filter({ hasText: /^Más$/ }).first(),
      main.locator('button').filter({ hasText: /^More$/ }).first(),
      main.locator('button').filter({ hasText: /^Más$/ }).first(),

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
    if (!dropdownRoot) throw new Error('No se detectó el dropdown del overflow (artdeco-dropdown / role=menu).');

    await debug('dropdown visible');

    const viewSalesNavRegex = /view in sales navigator|ver en sales navigator|sales navigator/i;

    const itemCandidates = [
      dropdownRoot.locator('div.artdeco-dropdown__item[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('[role="menuitem"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('div[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('button').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('a').filter({ hasText: viewSalesNavRegex }),

      dropdownRoot.locator('[aria-label*="Sales Navigator" i]'),
      dropdownRoot.locator('div[aria-label*="Sales Navigator" i]'),

      dropdownRoot
        .locator('svg[data-test-icon="sales-navigator-small"], use[href="#sales-navigator-small"]')
        .locator('xpath=ancestor::*[self::div or self::button or self::a][1]'),
    ];

    const ctx = page.context();
    const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);

    const clickedSalesNav = await clickFirstWorking('view-in-sales-nav', itemCandidates);
    if (!clickedSalesNav.ok) throw new Error('No se encontró / no se pudo clickear "View in Sales Navigator" en el dropdown.');

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
    salesPage.locator('button[data-anchor-send-inmail]').first(),
    salesPage.locator('button[data-anchor-send-inmail=""]').first(),

    salesPage.getByRole('button', { name: /message|mensaje/i }).first(),

    salesPage.locator('button').filter({ hasText: /^Message$/i }).first(),
    salesPage.locator('button').filter({ hasText: /^Mensaje$/i }).first(),

    salesPage.locator('button._message-cta_1xow7n, button._cta_1xow7n').first(),
    salesPage.locator('button[class*="_message-cta"]').first(),
    salesPage.locator('button[class*="message"][class*="cta"]').first(),

    salesPage.locator('button[aria-label*="Message" i], button[aria-label*="Mensaje" i]').first(),
  ];

  let messageClicked = false;
  for (let attempt = 0; attempt < 3 && !messageClicked; attempt++) {
    if (attempt > 0) await stepWait(1400 + attempt * 900);
    const res = await clickFirstWorking('salesnav-message-cta', messageBtnCandidates);
    messageClicked = res.ok;
  }
  if (!messageClicked) throw new Error('No se encontró / no se pudo clickear el botón "Message" en Sales Navigator.');

  // -----------------------------
  // 4.5) Detectar root del thread/compose (scoped selectors)
  // -----------------------------
  await debug('waiting compose/thread container');
  await stepWait(900);

  const composeRoots = [
    salesPage.locator('div[role="dialog"]').last(),
    salesPage.locator('section[role="dialog"]').last(),
    salesPage.locator('form[id*="compose-form"]').last(),
    salesPage.locator('form').filter({ has: salesPage.locator('textarea[name="message"], [role="textbox"][contenteditable="true"], p[data-anonymize="general-blurb"]') }).last(),
    salesPage.locator('div').filter({ has: salesPage.locator('p[data-anonymize="general-blurb"]') }).last(),
    salesPage.locator('div').filter({ has: salesPage.locator('textarea[name="message"]') }).last(),
  ];

  const composeRoot = (await waitAnyVisible(composeRoots, 14000, 220)) || salesPage.locator('body');
  await debug('compose/thread root ready');

  // Esperar algo mínimo (mensajes o input)
  await waitAnyVisible(
    [
      composeRoot.locator('p[data-anonymize="general-blurb"]').first(),
      composeRoot.locator('time.t-12, time').first(),
      composeRoot.locator('textarea[name="message"]').first(),
      composeRoot.locator('[role="textbox"][contenteditable="true"]').first(),
    ],
    9000,
    220
  ).catch(() => null);

  // -----------------------------
  // 5) Extraer mensajes con heurísticas (MUCHOS fallbacks)
  // -----------------------------
  const payload = await composeRoot.evaluate((rootEl, lim, hint) => {
    const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();

    const parseFromAria = (aria) => {
      const a = norm(aria);
      // "Message from Javier Alegre" / "Mensaje de ..."
      const m1 = a.match(/^(message from)\\s+/i);
      const m2 = a.match(/^(mensaje de)\\s+/i);
      if (m1) return norm(a.replace(/^message from\\s+/i, ''));
      if (m2) return norm(a.replace(/^mensaje de\\s+/i, ''));
      return null;
    };

    const isYouWrapper = (wrap) => {
      // Caso típico: <address> <span aria-label="Message from you">You</span>
      const you1 = wrap.querySelector('span[aria-label="Message from you"], span[aria-label*="Message from you" i]');
      if (you1) return true;

      const you2 = wrap.querySelector('address span[aria-label*="Message from you" i]');
      if (you2) return true;

      // fallback por texto visible "You" (NO ideal, pero ayuda)
      const addr = wrap.querySelector('address');
      if (addr && /\\byou\\b/i.test(norm(addr.textContent))) return true;

      return false;
    };

    const getSenderName = (wrap) => {
      if (isYouWrapper(wrap)) return 'You';

      // Tu ejemplo: <span data-anonymize="person-name" aria-label="Message from Javier Alegre">Javier Alegre</span>
      const pn = wrap.querySelector('span[data-anonymize="person-name"]');
      const pnText = norm(pn?.textContent);
      if (pnText) return pnText;

      const pnAria = pn?.getAttribute?.('aria-label');
      const fromAria = parseFromAria(pnAria);
      if (fromAria) return fromAria;

      // Cualquier aria-label "Message from X"
      const any = wrap.querySelector('[aria-label*="Message from" i], [aria-label*="Mensaje de" i]');
      const anyAria = any?.getAttribute?.('aria-label');
      const anyFrom = parseFromAria(anyAria);
      if (anyFrom) return anyFrom;

      // Address fallback
      const addr = wrap.querySelector('address');
      const addrText = norm(addr?.textContent);
      if (addrText && !/\\byou\\b/i.test(addrText)) return addrText;

      return null;
    };

    const getTime = (wrap) => {
      const t =
        wrap.querySelector('time[datetime]') ||
        wrap.querySelector('time.t-12') ||
        wrap.querySelector('time');

      const datetime = t?.getAttribute?.('datetime') || null;
      const label = norm(t?.textContent) || null;
      return { datetime, label };
    };

    // Recolectamos <p data-anonymize="general-blurb"> y subimos hasta encontrar un wrapper “razonable”
    const ps = Array.from(rootEl.querySelectorAll('p[data-anonymize="general-blurb"], p.t-14.white-space-pre-wrap'));
    const items = [];

    const pickWrapper = (p) => {
      let node = p;
      for (let i = 0; i < 8; i++) {
        if (!node || !node.parentElement) break;
        const el = node.parentElement;

        // wrapper candidato si contiene time + (address o person-name o aria "Message from")
        const hasTime = !!el.querySelector('time');
        const hasSender =
          !!el.querySelector('address span[aria-label*="Message from" i]') ||
          !!el.querySelector('span[data-anonymize="person-name"]') ||
          !!el.querySelector('[aria-label*="Message from" i], [aria-label*="Mensaje de" i]') ||
          !!el.querySelector('address');

        if (hasTime && hasSender) return el;

        // segundo criterio: si contiene el p y un time en algún ancestro cercano
        node = el;
      }
      // fallback: el contenedor directo del p
      return p.parentElement || p;
    };

    for (const p of ps) {
      const text = norm(p.textContent);
      if (!text) continue;

      const wrap = pickWrapper(p);

      const senderName = getSenderName(wrap);
      const isYou = senderName === 'You' || isYouWrapper(wrap);
      const t = getTime(wrap);

      items.push({
        senderName,
        isYou,
        datetime: t.datetime,
        timeLabel: t.label,
        text,
      });
    }

    // Dedup (sender + datetime + text)
    const seen = new Set();
    const deduped = [];
    for (const m of items) {
      const key = [m.senderName ?? '', m.datetime ?? '', m.text ?? ''].join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    // Orden: por datetime si parsea, si no, conserva orden DOM
    const withIdx = deduped.map((m, idx) => ({ ...m, _idx: idx }));
    withIdx.sort((a, b) => {
      const ta = Date.parse(a.datetime || '');
      const tb = Date.parse(b.datetime || '');
      const va = Number.isFinite(ta);
      const vb = Number.isFinite(tb);
      if (va && vb) return ta - tb;
      return a._idx - b._idx;
    });

    let messages = withIdx.map(({ _idx, ...m }) => m);

    if (typeof lim === 'number' && lim > 0 && messages.length > lim) {
      messages = messages.slice(-lim);
    }

    // Best-effort participant name
    const other =
      messages.find((m) => !m.isYou && m.senderName)?.senderName ||
      norm(rootEl.querySelector('span[data-anonymize="person-name"]')?.textContent) ||
      null;

    return {
      ok: true,
      threadHint: hint || undefined,
      participants: { me: 'You', other },
      totalFound: withIdx.length,
      returned: messages.length,
      extractedAt: new Date().toISOString(),
      messages,
    };
  }, limit, threadHint);

  return {
    ok: true,
    profileUrl,
    limit,
    threadHint: threadHint || undefined,
    url: salesPage.url(),
    data: payload,
  };
}
`;
  }

  async readSalesNavChat(
    sessionId: SessionId,
    profileUrl: string,
    limit = 30,
    threadHint?: string,
  ) {
    const startTime = Date.now();
    const code = this.buildReadSalesNavChatCode(profileUrl, limit, threadHint);

    const verboseResult = {
      ok: true,
      sessionId,
      profileUrl,
      limit,
      threadHint,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_runCode_salesnav_read_chat',
        steps: [] as string[],
        errors: [] as any[],
        codeLength: code.length,
      },
      result: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Building SalesNav read-chat runCode',
      );
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
