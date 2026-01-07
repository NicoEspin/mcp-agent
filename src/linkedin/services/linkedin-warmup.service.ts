import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { buildEnsureOnUrlSnippet } from '../utils/navigation-snippets';
import { createHash, randomUUID } from 'crypto';

type SessionId = string;

type WarmupTraceEntry = {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: any;
};

type WarmupPayload = {
  ok: boolean;
  hasNewMessage?: boolean;
  reason?: string;
  lastMessageStr?: string | null;
  latestMessageStr?: string | null;
  latestMessage?: any;
  checks?: number;
  intervalMs?: number;
  maxChecks?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  usedFastPath?: boolean;
  correlationId?: string;
  trace?: WarmupTraceEntry[];
  meta?: any;
};

type StartWarmUpVerbose = {
  ok: boolean;
  sessionId: SessionId;
  profileUrl: string;
  lastMessageStr: string;
  intervalSeconds: number;
  maxMinutes: number;
  closeOnFinish: boolean;
  correlationId: string;
  executionDetails: {
    startTime: number;
    endTime: number | null;
    executionTimeMs: number | null;
    method: string;
    codeLength: number;
    steps: string[];
    errors: any[];
  };
  data: WarmupPayload | any;
  toolResult: any;
};

type WatcherOptions = {
  intervalSeconds?: number; // cada cuánto checkea dentro del bloque
  chunkMinutes?: number; // duración de cada corrida (si no hay msg, reintenta)
  closeOnFinish?: boolean; // cerrar tab al finalizar cada corrida
  backoffSecondsOnError?: number; // espera cuando falla
  logBrowserTrace?: boolean; // loguea trace del browser en backend
  messagePreviewChars?: number; // preview en logs
  continueAfterNewMessage?: boolean; // mantener watcher vivo tras detectar mensajes
  onNewMessage?: (
    payload: WarmupPayload & {
      sessionId: string;
      profileUrl: string;
      watcherId: string;
    },
  ) => void;
};

type WatcherState = {
  watcherId: string;
  sessionId: SessionId;
  profileUrl: string;
  lastMessageStr: string;
  startedAt: number;
  isRunning: boolean;
  attempt: number;
  abort: AbortController;
  promise: Promise<void>;
};

@Injectable()
export class LinkedinWarmUpService {
  private readonly logger = new Logger(LinkedinWarmUpService.name);

  // ✅ watchers always-on
  private readonly watchers = new Map<string, WatcherState>();

  constructor(private readonly playwright: PlaywrightService) {}

  // -----------------------------
  // Helpers
  // -----------------------------
  private makeWatcherId(sessionId: string, profileUrl: string) {
    const h = createHash('sha1')
      .update(`${sessionId}::${profileUrl}`)
      .digest('hex')
      .slice(0, 10);
    return `warmup_${h}`;
  }

  private sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private safeParse(v: any) {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  private previewText(s: any, n: number) {
    const t = (s ?? '').toString().replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  private logTrace(
    correlationId: string,
    trace?: WarmupTraceEntry[],
    max = 200,
  ) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) return;
    const slice = trace.length > max ? trace.slice(trace.length - max) : trace;

    for (const e of slice) {
      const line = `[pw-trace][${correlationId}] ${e.ts} ${e.level.toUpperCase()} ${e.msg}`;
      this.logger.debug(
        e.data ? `${line} data=${JSON.stringify(e.data).slice(0, 1200)}` : line,
      );
    }
  }

  // -----------------------------
  // ✅ Playwright code generator (con trace + correlationId)
  // -----------------------------
private buildStartWarmUpCode(opts: {
  profileUrl: string;
  lastMessageStr: string;
  intervalMs: number;
  maxChecks: number;
  closeOnFinish: boolean;
  correlationId: string;
  armFromCurrent: boolean;
}) {
  const {
    profileUrl,
    lastMessageStr,
    intervalMs,
    maxChecks,
    closeOnFinish,
    correlationId,
    armFromCurrent,
  } = opts;

  return `
async (page) => {
  ${buildEnsureOnUrlSnippet()}

  const correlationId = ${JSON.stringify(correlationId)};
  const profileUrl = ${JSON.stringify(profileUrl)};
  const lastMessageStr = ${JSON.stringify(lastMessageStr ?? '')};
  const intervalMs = ${JSON.stringify(intervalMs)};
  const maxChecks = ${JSON.stringify(maxChecks)};
  const closeOnFinish = ${JSON.stringify(!!closeOnFinish)};
  const armFromCurrent = ${JSON.stringify(!!armFromCurrent)};

  const startedAt = new Date().toISOString();

  const trace = [];
  const TRACE_MAX = 300;

  const pushTrace = (level, msg, data) => {
    try {
      const entry = { ts: new Date().toISOString(), level, msg, data };
      trace.push(entry);
      if (trace.length > TRACE_MAX) trace.shift();
    } catch {}
  };

  const debug = (msg, data) => {
    pushTrace('debug', msg, data);
    console.log('[start-warm-up]', '[' + correlationId + ']', msg, data ? JSON.stringify(data) : '', 'url=', page.url());
  };

  const info = (msg, data) => {
    pushTrace('info', msg, data);
    console.log('[start-warm-up]', '[' + correlationId + ']', msg, data ? JSON.stringify(data) : '', 'url=', page.url());
  };

  const warn = (msg, data) => {
    pushTrace('warn', msg, data);
    console.log('[start-warm-up]', '[' + correlationId + ']', 'WARN:', msg, data ? JSON.stringify(data) : '', 'url=', page.url());
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();

  const normalizeProfileUrl = (u) => __normalizeUrl(u);
  const sameProfile = (a, b) => __sameUrl(a, b, false);

  let warmPage = null;

  try {
    // 0) Abrir NUEVA TAB
    warmPage = await page.context().newPage();
    page = warmPage;
    await debug('New tab created');

    const getOpenThreadProfileHref = async () => {
      const candidates = [
        '.msg-overlay-bubble-header__title a[href*="/in/"]',
        '.msg-overlay-conversation-bubble__header a[href*="/in/"]',
        '.msg-overlay-bubble-header a[href*="/in/"]',
        '.msg-thread__link-to-profile a[href*="/in/"]',
        'a.msg-thread__link-to-profile[href*="/in/"]',
        '.msg-conversation-card__header a[href*="/in/"]',
        '.msg-thread__header a[href*="/in/"]',
        '.msg-overlay-container a[href*="/in/"]',
        '.msg-overlay-conversation-bubble a[href*="/in/"]',
      ];

      for (const sel of candidates) {
        const a = page.locator(sel).last();
        if (!(await a.count().catch(() => 0))) continue;
        const href = (await a.getAttribute('href').catch(() => '')) || '';
        if (!href || !href.includes('/in/')) continue;
        if (href.startsWith('/')) return 'https://www.linkedin.com' + href;
        return href;
      }
      return '';
    };

    const detectConversationRootNow = async () => {
      const candidates = [
        page.locator('.msg-overlay-conversation-bubble__content-wrapper').last(),
        page.locator('.msg-s-message-list').last(),
        page.locator('.msg-overlay-conversation-bubble').last(),
        page.locator('[role="main"] .msg-conversation-listitem').last(),
        page.locator('.msg-conversation__body').last(),
        page.locator('.msg-thread').last(),
        page.locator('[data-view-name*="conversation"]').last(),
        page.locator('.conversation-wrapper').last(),
      ];

      for (const loc of candidates) {
        try {
          if (!(await loc.count().catch(() => 0))) continue;
          if (await loc.isVisible().catch(() => false)) return loc;
        } catch {}
      }
      return null;
    };

    let root = await detectConversationRootNow();
    let usedFastPath = false;

    if (root) {
      const openHref = await getOpenThreadProfileHref();
      const same = openHref ? sameProfile(openHref, profileUrl) : false;

      if (same) {
        usedFastPath = true;
        await debug('FastPath: conversación ya abierta y coincide', { openHref });
      } else {
        await debug('FastPath: conversación abierta pero NO coincide', { openHref });
        root = null;
      }
    }

    // 1) Ir al perfil (solo si hace falta)
    if (!usedFastPath) {
      const nav = await ensureOnUrl(profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
        settleMs: 800,
        allowSubpaths: false,
      });
      await debug('ensureOnUrl done', nav);

      const main = page.locator('main').first();
      const topCard = main
        .locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2')
        .first();
      const scope = (await topCard.count().catch(() => 0)) ? topCard : main;

      const findMessageButton = async () => {
        let loc = scope
          .locator('button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]')
          .first();
        if (await loc.count().catch(() => 0)) return loc;

        loc = main
          .locator('button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]')
          .first();
        if (await loc.count().catch(() => 0)) return loc;

        loc = scope.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
        if (await loc.count().catch(() => 0)) return loc;

        loc = main.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
        if (await loc.count().catch(() => 0)) return loc;

        const icon = scope
          .locator(
            'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
              'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
          )
          .first();

        if (await icon.count().catch(() => 0)) {
          const btn = icon.locator('xpath=ancestor::button[1]').first();
          if (await btn.count().catch(() => 0)) return btn;
        }

        const icon2 = main
          .locator(
            'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
              'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
          )
          .first();

        if (await icon2.count().catch(() => 0)) {
          const btn = icon2.locator('xpath=ancestor::button[1]').first();
          if (await btn.count().catch(() => 0)) return btn;
        }

        return null;
      };

      let messageBtn = await findMessageButton();

      if (!messageBtn) {
        await debug('CTA mensaje no encontrado. Probando overflow');

        const moreBtn = scope
          .locator(
            'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
              'button[data-view-name="profile-overflow-button"][aria-label="More"]'
          )
          .first();

        if (await moreBtn.count().catch(() => 0)) {
          await moreBtn.scrollIntoViewIfNeeded().catch(() => {});
          await moreBtn.click({ timeout: 8000, force: true });
          await page.waitForTimeout(200);

          const msgItem = page
            .getByRole('menuitem', { name: /enviar mensaje|mensaje|message/i })
            .first();

          if (await msgItem.count().catch(() => 0)) {
            await msgItem.click({ timeout: 8000 });
          } else {
            throw new Error('No se encontró opción de mensaje en el menú Más del perfil.');
          }
        } else {
          throw new Error('No se encontró CTA de mensaje ni overflow del perfil.');
        }
      } else {
        const aria = (await messageBtn.getAttribute('aria-label').catch(() => '')) ?? '';
        if (/para negocios|for business/i.test(aria)) {
          throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
        }

        await debug('Click CTA Enviar mensaje', { aria });
        await messageBtn.scrollIntoViewIfNeeded().catch(() => {});
        await messageBtn.click({ timeout: 8000, force: true });
      }

      await page.waitForTimeout(500);

      const containerCandidates = [
        page.locator('.msg-overlay-conversation-bubble__content-wrapper').last(),
        page.locator('.msg-s-message-list').last(),
        page.locator('.msg-overlay-conversation-bubble').last(),
        page.locator('[role="main"] .msg-conversation-listitem').last(),
        page.locator('.msg-conversation__body').last(),
        page.locator('.msg-thread').last(),
        page.locator('[data-view-name*="conversation"]').last(),
        page.locator('.conversation-wrapper').last(),
        page.locator('main').last(),
      ];

      for (const candidate of containerCandidates) {
        try {
          await candidate.waitFor({ state: 'visible', timeout: 2000 });
          root = candidate;
          const containerType = await candidate.evaluate((el) => el.className || el.tagName).catch(() => 'unknown');
          await debug('Container detected', { containerType });
          break;
        } catch {}
      }

      if (!root) {
        warn('No specific conversation container found, fallback to body');
        root = page.locator('body');
      }
    }

    try {
      await root
        .locator('.msg-s-event-listitem, .msg-s-message-group')
        .first()
        .waitFor({ timeout: 3500, state: 'visible' });
      await debug('Message containers detected');
    } catch {
      await debug('No structured message containers found after 3.5s (continuing)');
    }

    await sleep(500);

    // ----------------------------------------------------------------------
    // ✅ NUEVO: snapshot robusto de "tail" + IDs estables + anti-reflow
    // ----------------------------------------------------------------------
    const readTailSnapshot = async (limit = 60) => {
      return await root
        .evaluate(
          (rootEl, limit) => {
            const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();

            const container =
              rootEl.querySelector('.msg-s-message-list.full-width.scrollable') ||
              rootEl.querySelector('.msg-s-message-list.scrollable') ||
              rootEl.querySelector('.msg-s-message-list') ||
              rootEl.querySelector('[data-view-name*="conversation"]') ||
              rootEl;

            const bodySelectors = [
              'p.msg-s-event-listitem__body',
              'span.msg-s-event-listitem__body',
              'div.msg-s-event-listitem__body',
              '.msg-s-event-listitem__event-text',
              'p[data-test-id="message-text"]',
              '.message-body',
              'p.t-14',
              'span.break-words',
            ].join(',');

            const itemSelectors = [
              '.msg-s-event-listitem',
              '.msg-s-message-group',
              '.msg-s-message-list__event',
            ].join(',');

            const pickText = (item) => {
              const nodes = Array.from(item.querySelectorAll(bodySelectors));
              for (let i = nodes.length - 1; i >= 0; i--) {
                const t = norm(nodes[i]?.textContent);
                if (t) return t;
              }
              return norm(item.textContent) || '';
            };

            const pickId = (item) => {
              return (
                item.getAttribute('data-event-urn') ||
                item.getAttribute('data-urn') ||
                item.getAttribute('data-id') ||
                item.id ||
                ''
              );
            };

            const isSystem = (item) => {
              const cls = (item.className || '').toString().toLowerCase();
              if (cls.includes('msg-s-event-listitem--system')) return true;
              if (cls.includes('receipt') || cls.includes('seen')) return true;
              return false;
            };

            const pickRole = (item) => {
              const cls = (item.className || '').toString().toLowerCase();
              if (cls.includes('--other')) return 'candidate';
              if (cls.includes('--self') || cls.includes('--from-me') || cls.includes('--me')) return 'recruiter';
              return null;
            };

            // ordenar por posición visual para evitar flicker/reflow/column-reverse
            const raw = Array.from(container.querySelectorAll(itemSelectors));
            const visibleSorted = raw
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter((x) => x.r && x.r.height > 0)
              .sort((a, b) => a.r.top - b.r.top)
              .map((x) => x.el);

            const tailEls = visibleSorted
              .filter((el) => !isSystem(el))
              .slice(-Math.max(5, Number(limit) || 60));

            const tail = tailEls
              .map((el) => {
                const text = pickText(el);
                const id = pickId(el) || '';
                const role = pickRole(el);
                return { id, role, text };
              })
              .filter((m) => norm(m.text));

            const latest = tail.length ? tail[tail.length - 1] : { id: '', role: null, text: '' };

            return { ok: true, tail, latest, count: tail.length };
          },
          limit
        )
        .catch(() => ({ ok: false, tail: [], latest: { id: '', role: null, text: '' }, count: 0 }));
    };

    // -----------------------------
    // ✅ baseline robusto (anclado al "hola" si existe; si no, arma desde current)
    // -----------------------------
    const baseText = norm(lastMessageStr);

    // snapshot + mini-estabilización para evitar cambios por reflow
    let snap = await readTailSnapshot(60);

    for (let i = 0; i < 6; i++) {
      await sleep(250);
      const s2 = await readTailSnapshot(60);

      const a = (snap?.latest?.id || '') + '||' + norm(snap?.latest?.text || '');
      const b = (s2?.latest?.id || '') + '||' + norm(s2?.latest?.text || '');

      snap = s2;
      if (a && b && a === b) break;
    }

    await debug('Initial snapshot', {
      baseTextPreview: baseText ? baseText.slice(0, 120) : '',
      latestPreview: (snap?.latest?.text || '').slice(0, 120),
      latestId: snap?.latest?.id || '',
      latestRole: snap?.latest?.role || 'n/a',
      tailCount: snap?.count || 0,
      armFromCurrent,
    });

    const findAnchor = (s) => {
      if (!baseText) return null;
      const tail = s?.tail || [];
      for (let i = tail.length - 1; i >= 0; i--) {
        const m = tail[i];
        const roleOk = m.role === 'recruiter' || m.role === null;
        if (roleOk && norm(m.text) === baseText) return { m, idx: i };
      }
      return null;
    };

    let baselineText = baseText;
    let baselineId = '';
    let armedFrom = 'lastMessageStr';

    const anchor = findAnchor(snap);

    if (anchor?.m) {
      baselineId = anchor.m.id || '';
      baselineText = norm(anchor.m.text || '');
      await info('Baseline anchored on lastMessageStr ✅', {
        baselineId,
        baselineTextPreview: baselineText.slice(0, 120),
      });
    } else if (armFromCurrent) {
      baselineId = snap?.latest?.id || '';
      baselineText = norm(snap?.latest?.text || '');
      armedFrom = 'current_latest';
      await info('Baseline NOT found; arming from current latest', {
        baselineId,
        baselineTextPreview: baselineText.slice(0, 120),
      });
    } else {
      // comportamiento "viejo": si no encuentra anchor, probablemente ya hay algo nuevo al arrancar
      const latestText = norm(snap?.latest?.text || '');
      if (latestText && baseText && latestText !== baseText) {
        const finishedAt = new Date().toISOString();
        const result = {
          ok: true,
          hasNewMessage: true,
          reason: 'already-new-at-start',
          lastMessageStr: baseText || null,
          latestMessageStr: latestText,
          latestMessage: snap?.latest || null,
          checks: 0,
          intervalMs,
          maxChecks,
          startedAt,
          finishedAt,
          durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
          usedFastPath,
          correlationId,
          trace,
          meta: { profileUrl, armedFrom: 'none_anchor_missing' },
        };

        if (closeOnFinish && page && page.close) {
          try { await page.close({ runBeforeUnload: true }); } catch {}
        }
        return result;
      }

      await warn('Baseline NOT found and armFromCurrent=false (continuing anyway)', { baseTextPreview: baseText.slice(0, 120) });
    }

    // Set de vistos basado en IDs para evitar falsos positivos por reorder/timestamps
    const seenIds = new Set();
    for (const m of snap?.tail || []) {
      if (m?.id) seenIds.add(m.id);
    }
    // también agregamos baselineId explícito
    if (baselineId) seenIds.add(baselineId);

    // -----------------------------
    // ✅ Loop: esperar un mensaje realmente nuevo (ID nuevo) preferentemente role=candidate
    // -----------------------------
    const infinite = !maxChecks || maxChecks <= 0;

    for (let checks = 1; infinite || checks <= maxChecks; checks++) {
      const s = await readTailSnapshot(60);
      const tail = s?.tail || [];
      const latest = s?.latest || { id: '', role: null, text: '' };

      const latestText = norm(latest?.text || '');
      const latestId = latest?.id || '';

      // Heartbeat/log
      if (checks === 1 || checks % 5 === 0) {
        await info('Heartbeat', {
          checks,
          armedFrom,
          baselineId,
          latestId,
          latestRole: latest?.role || 'n/a',
          latestPreview: latestText ? latestText.slice(0, 120) : '[empty]',
          tailCount: s?.count || 0,
        });
      } else {
        await debug('Check', { checks, latestId, latestRole: latest?.role || 'n/a' });
      }

      // detectar nuevos (por id no visto)
      const newOnes = tail.filter((m) => m?.id && !seenIds.has(m.id));
      const candidateNew = newOnes.find((m) => m.role === 'candidate') || newOnes[newOnes.length - 1];

      // actualizar vistos (DESPUÉS de evaluar newOnes)
      for (const m of tail) {
        if (m?.id) seenIds.add(m.id);
      }

      if (candidateNew?.id) {
        // anti-flicker: confirmación de que sigue existiendo
        await sleep(350);
        const s2 = await readTailSnapshot(60);
        const still = (s2?.tail || []).find((x) => x?.id === candidateNew.id);

        if (still) {
          const finishedAt = new Date().toISOString();

          await info('New message detected ✅ (stable)', {
            checks,
            newId: still.id,
            role: still.role ?? null,
            preview: (still.text || '').slice(0, 160),
          });

          const result = {
            ok: true,
            hasNewMessage: true,
            lastMessageStr: baselineText || null,
            latestMessageStr: norm(still.text || ''),
            latestMessage: still,
            checks,
            intervalMs,
            maxChecks,
            startedAt,
            finishedAt,
            durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
            usedFastPath,
            correlationId,
            trace,
            meta: {
              profileUrl,
              baselineId,
              armedFrom,
              armedFromCurrent: armFromCurrent && armedFrom === 'current_latest',
            },
          };

          if (closeOnFinish && page && page.close) {
            try { await page.close({ runBeforeUnload: true }); } catch {}
          }
          return result;
        } else {
          await debug('New candidate id appeared but vanished (ignore flicker)', { candidateId: candidateNew.id });
        }
      }

      await sleep(intervalMs);
    }

    // timeout
    const finishedAt = new Date().toISOString();
    const latestSnap = await readTailSnapshot(60);
    const latestTimeout = latestSnap?.latest || null;

    const timeoutResult = {
      ok: true,
      hasNewMessage: false,
      reason: 'timeout',
      lastMessageStr: baselineText || null,
      latestMessageStr: norm(latestTimeout?.text || '') || null,
      latestMessage: latestTimeout,
      checks: maxChecks,
      intervalMs,
      maxChecks,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      usedFastPath,
      correlationId,
      trace,
      meta: {
        profileUrl,
        baselineId,
        armedFrom,
        armedFromCurrent: armFromCurrent && armedFrom === 'current_latest',
      },
    };

    if (closeOnFinish && page && page.close) {
      try { await page.close({ runBeforeUnload: true }); } catch {}
    }
    return timeoutResult;

  } catch (e) {
    const finishedAt = new Date().toISOString();
    warn('Error in warm-up code', { message: (e && e.message) ? e.message : String(e) });

    try {
      if (closeOnFinish && page && page.close) {
        await page.close({ runBeforeUnload: true }).catch(() => {});
      }
    } catch {}

    return {
      ok: false,
      error: (e && e.message) ? e.message : String(e),
      startedAt,
      finishedAt,
      correlationId,
      trace,
      meta: { profileUrl },
    };
  }
}
`;
}

  // -----------------------------
  // ✅ startWarmUp (misma API, más logs + correlationId)
  // - armFromCurrent:
  //   - false => comportamiento viejo (already-new-at-start)
  //   - true  => si baseline no coincide, "arma" y espera el siguiente
  // -----------------------------
  async startWarmUp(
    sessionId: SessionId,
    profileUrl: string,
    lastMessageStr: string,
    intervalSeconds = 60,
    maxMinutes = 30,
    closeOnFinish = true,
    correlationId?: string,
    logBrowserTrace = false,
    armFromCurrent = false, // ✅ NUEVO
  ): Promise<StartWarmUpVerbose> {
    const startTime = Date.now();
    const cid = correlationId ?? randomUUID();

    const intervalMs = Math.max(10, intervalSeconds) * 1000;

    const maxChecks =
      !maxMinutes || maxMinutes <= 0
        ? 0
        : Math.max(
            1,
            Math.ceil(
              (Math.max(1, maxMinutes) * 60) / Math.max(10, intervalSeconds),
            ),
          );

    const code = this.buildStartWarmUpCode({
      profileUrl,
      lastMessageStr: lastMessageStr ?? '',
      intervalMs,
      maxChecks,
      closeOnFinish,
      correlationId: cid,
      armFromCurrent,
    });

    const verboseResult: StartWarmUpVerbose = {
      ok: true,
      sessionId,
      profileUrl,
      lastMessageStr,
      intervalSeconds,
      maxMinutes,
      closeOnFinish,
      correlationId: cid,
      executionDetails: {
        startTime,
        endTime: null,
        executionTimeMs: null,
        method: 'playwright_direct_execution',
        codeLength: code.length,
        steps: [],
        errors: [],
      },
      data: null as any,
      toolResult: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push('Generated warm-up code');
      verboseResult.executionDetails.steps.push(`correlationId=${cid}`);
      verboseResult.executionDetails.steps.push(
        `intervalMs=${intervalMs}, maxChecks=${maxChecks}, armFromCurrent=${armFromCurrent}`,
      );
      verboseResult.executionDetails.steps.push(
        'Starting Playwright runCode execution',
      );

      this.logger.log(
        `[warmup][${cid}] startWarmUp begin sessionId=${sessionId} interval=${intervalSeconds}s maxMinutes=${maxMinutes} closeOnFinish=${closeOnFinish} armFromCurrent=${armFromCurrent}`,
      );
      this.logger.debug(
        `[warmup][${cid}] profileUrl=${profileUrl} lastMessageStrPreview="${this.previewText(lastMessageStr, 120)}"`,
      );

      const result = await this.playwright.runCode(code, sessionId);
      const parsed: WarmupPayload = this.safeParse(result);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      verboseResult.executionDetails.steps.push(
        'Playwright execution completed',
      );
      verboseResult.executionDetails.steps.push(
        `ok=${parsed?.ok} hasNewMessage=${parsed?.hasNewMessage ?? 'n/a'} checks=${parsed?.checks ?? 'n/a'} reason=${parsed?.reason ?? 'n/a'}`,
      );

      verboseResult.data = parsed;
      verboseResult.toolResult = parsed;

      const msgPreview = this.previewText(parsed?.latestMessageStr, 140);

      this.logger.log(
        `[warmup][${cid}] done ok=${parsed?.ok} hasNewMessage=${parsed?.hasNewMessage} checks=${parsed?.checks} reason=${parsed?.reason ?? 'n/a'} durationMs=${verboseResult.executionDetails.executionTimeMs}`,
      );
      if (parsed?.hasNewMessage) {
        this.logger.log(
          `[warmup][${cid}] ✅ NEW MESSAGE latestPreview="${msgPreview}"`,
        );
      } else {
        this.logger.debug(
          `[warmup][${cid}] heartbeat latestPreview="${msgPreview}"`,
        );
      }

      if (logBrowserTrace) {
        this.logTrace(cid, parsed?.trace);
      }

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

      this.logger.warn(
        `[warmup][${cid}] startWarmUp failed: ${e?.message ?? e}`,
      );

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        sessionId,
      } as any;
    }
  }

  // -----------------------------
  // ✅ Always-on watcher API
  // -----------------------------
  startWarmUpWatcher(
    sessionId: SessionId,
    profileUrl: string,
    lastMessageStr: string,
    opts: WatcherOptions = {},
  ) {
    const watcherId = this.makeWatcherId(sessionId, profileUrl);

    const existing = this.watchers.get(watcherId);
    if (existing?.isRunning) {
      this.logger.warn(
        `[watcher][${watcherId}] already running (sessionId=${sessionId})`,
      );
      return { ok: true, watcherId, alreadyRunning: true };
    }

    const abort = new AbortController();
    const state: WatcherState = {
      watcherId,
      sessionId,
      profileUrl,
      lastMessageStr: lastMessageStr ?? '',
      startedAt: Date.now(),
      isRunning: true,
      attempt: 0,
      abort,
      promise: Promise.resolve(),
    };

    state.promise = this.runWatcherLoop(state, opts).finally(() => {
      state.isRunning = false;
      this.watchers.set(watcherId, state);
    });

    this.watchers.set(watcherId, state);

    this.logger.log(
      `[watcher][${watcherId}] started sessionId=${sessionId} profileUrl=${profileUrl}`,
    );

    return { ok: true, watcherId, alreadyRunning: false };
  }

  stopWarmUpWatcher(watcherId: string) {
    const st = this.watchers.get(watcherId);
    if (!st) return { ok: false, error: 'watcher_not_found', watcherId };

    if (!st.isRunning)
      return { ok: true, watcherId, stopped: true, alreadyStopped: true };

    st.abort.abort();
    this.logger.warn(`[watcher][${watcherId}] stop requested`);
    return { ok: true, watcherId, stopped: true, alreadyStopped: false };
  }

  listWarmUpWatchers() {
    return Array.from(this.watchers.values()).map((w) => ({
      watcherId: w.watcherId,
      sessionId: w.sessionId,
      profileUrl: w.profileUrl,
      isRunning: w.isRunning,
      attempt: w.attempt,
      startedAt: w.startedAt,
      lastMessageStrPreview: this.previewText(w.lastMessageStr, 120),
    }));
  }

  // -----------------------------
  // ✅ internal: loop “indefinido” (por chunks)
  // -----------------------------
  private async runWatcherLoop(state: WatcherState, opts: WatcherOptions) {
    const {
      intervalSeconds = 60,
      chunkMinutes = 15,
      closeOnFinish = true,
      backoffSecondsOnError = 10,
      logBrowserTrace = false,
      messagePreviewChars = 160,
      continueAfterNewMessage = false,
      onNewMessage,
    } = opts;

    const { watcherId, sessionId, profileUrl } = state;

    this.logger.log(
      `[watcher][${watcherId}] loop begin interval=${intervalSeconds}s chunkMinutes=${chunkMinutes} closeOnFinish=${closeOnFinish} continueAfterNewMessage=${continueAfterNewMessage}`,
    );

    while (!state.abort.signal.aborted) {
      state.attempt += 1;

      const cid = `${watcherId}_${state.attempt}_${randomUUID().slice(0, 8)}`;

      this.logger.log(
        `[watcher][${watcherId}][${cid}] attempt=${state.attempt} start lastPreview="${this.previewText(
          state.lastMessageStr,
          120,
        )}"`,
      );

      try {
        // ✅ armFromCurrent=true para evitar tu caso de "already-new-at-start"
        const res = await this.startWarmUp(
          sessionId,
          profileUrl,
          state.lastMessageStr,
          intervalSeconds,
          chunkMinutes,
          closeOnFinish,
          cid,
          logBrowserTrace,
          true, // ✅ armFromCurrent
        );

        const payload: WarmupPayload =
          (res as any)?.data ?? (res as any)?.toolResult ?? (res as any);

        if (!payload || payload.ok === false) {
          const errMsg = (payload as any)?.error ?? 'unknown_payload_error';
          this.logger.warn(
            `[watcher][${watcherId}][${cid}] run returned ok=false error=${errMsg}`,
          );
          await this.sleep(
            backoffSecondsOnError * 1000,
            state.abort.signal,
          ).catch(() => {});
          continue;
        }

        if (payload?.hasNewMessage) {
          const preview = this.previewText(
            payload.latestMessageStr,
            messagePreviewChars,
          );

          this.logger.log(
            `[watcher][${watcherId}][${cid}] ✅ NEW MESSAGE detected checks=${payload.checks} latestPreview="${preview}"`,
          );

          try {
            onNewMessage?.({
              ...(payload as any),
              sessionId,
              profileUrl,
              watcherId,
            });
          } catch (cbErr: any) {
            this.logger.warn(
              `[watcher][${watcherId}][${cid}] onNewMessage callback failed: ${cbErr?.message ?? cbErr}`,
            );
          }

          if (payload?.latestMessageStr) {
            state.lastMessageStr = payload.latestMessageStr;
          }

          if (continueAfterNewMessage) {
            this.logger.log(
              `[watcher][${watcherId}][${cid}] continueAfterNewMessage=true -> keep listening`,
            );
            continue;
          }

          break;
        }

        // timeout / heartbeat => avanzamos baseline con lo último visto
        if (payload?.latestMessageStr) {
          state.lastMessageStr = payload.latestMessageStr;
        }

        this.logger.debug(
          `[watcher][${watcherId}][${cid}] heartbeat: no new message (reason=${payload.reason ?? 'n/a'}) continuing...`,
        );
      } catch (e: any) {
        this.logger.warn(
          `[watcher][${watcherId}][${cid}] attempt crashed: ${e?.message ?? e}`,
        );
        await this.sleep(
          backoffSecondsOnError * 1000,
          state.abort.signal,
        ).catch(() => {});
      }
    }

    this.logger.log(
      `[watcher][${watcherId}] loop end (aborted=${state.abort.signal.aborted})`,
    );
  }
}
