// src/linkedin/linkedin.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightMcpService } from '../mcp/playwright-mcp.service';

@Injectable()
export class LinkedinService {
  private readonly logger = new Logger(LinkedinService.name);

  constructor(private readonly mcp: PlaywrightMcpService) {}

  private extractTools(resp: any): any[] {
    return (
      resp?.tools ??
      resp?.result?.tools ??
      resp?.data?.tools ??
      resp?.payload?.tools ??
      []
    );
  }

  private async hasTool(name: string) {
    const res = await this.mcp.listTools();
    const tools = this.extractTools(res);
    return tools.some((t: any) => t?.name === name);
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
  const main = page.locator('main');

  // Scope preferido: top card / acciones de perfil si existe
  const topCard =
    main.locator('[data-view-name*="profile"], .pv-top-card, .pv-top-card-v2-ctas').first();

  const scope = (await topCard.count()) ? topCard : main;

  // Encuentra el clickable más cercano del ícono de enviar mensaje
  const getClickableFromIcon = async () => {
    const icon = scope.locator('svg#send-privately-medium').first();
    if (!(await icon.count())) return null;

    const btnAncestor = icon.locator('xpath=ancestor::button[1]');
    if (await btnAncestor.count()) return btnAncestor;

    const linkAncestor = icon.locator('xpath=ancestor::a[1]');
    if (await linkAncestor.count()) return linkAncestor;

    // Último fallback: algún contenedor clickable cercano
    const genericAncestor = icon.locator(
      'xpath=ancestor::*[self::span or self::div][1]'
    );
    if (await genericAncestor.count()) return genericAncestor;

    return null;
  };

  // ---------- 2) Click CTA "Enviar mensaje" ----------
  let messageBtn = await getClickableFromIcon();

  // Fallback B (más seguro): botón con texto "Enviar mensaje" dentro del scope, NO global
  if (!messageBtn) {
    const byText = scope.locator('button, a').filter({
      hasText: /enviar mensaje|message/i,
    }).first();

    if (await byText.count()) messageBtn = byText;
  }

  // ---------- 3) Fallback controlado: "Más" del perfil ----------
  if (!messageBtn) {
    await debug('CTA no encontrado. Probando overflow del perfil');

    // MUY IMPORTANTE: selector hiper específico del overflow del perfil
    const moreBtn = scope.locator(
      'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
      'button[data-view-name="profile-overflow-button"][aria-label="More"]'
    ).first();

    if (await moreBtn.count()) {
      await moreBtn.scrollIntoViewIfNeeded();
      await moreBtn.click({ timeout: 15000, force: true });
      await page.waitForTimeout(250);

      // Item de menú de mensaje dentro del contexto del menú abierto
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
    // Antes de clickear, doble guard simple anti-header
    const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
    if (/para negocios|for business/i.test(aria)) {
      throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
    }

    await debug('Click CTA Enviar mensaje (scoped)');
    await messageBtn.scrollIntoViewIfNeeded();
    await messageBtn.click({ timeout: 15000, force: true });
  }

   // ---------- 4) Esperar drawer + textbox (más robusto) ----------
  const waitForMessageBox = async (timeout = 12000) => {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // 1) Selector exacto de LinkedIn
      let candidate = page
        .locator(
          'div.msg-form__contenteditable[role="textbox"][contenteditable="true"]'
        )
        .first();

      if ((await candidate.count()) && (await candidate.isVisible())) {
        return candidate;
      }

      // 2) Fallback accesible por label
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

  // Pequeño buffer inicial tras el click del CTA/menú
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

  // pequeño respiro para que LinkedIn habilite el submit
  await page.waitForTimeout(250);

  // ---------- 6) Botón Enviar real (scoped al form del textbox) ----------

  // Helper: esperar a que un locator esté visible y habilitado
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
    // fallback: forms de mensajes típicos
    form = page.locator('form.msg-form, form[data-view-name*="message"]').last();
  }

  // 6.2) Buscar botón Enviar dentro del form
  let sendBtn = form.locator('button.msg-form__send-button[type="submit"]').first();

  if (!(await sendBtn.count())) {
    // fallback por submit + texto
    sendBtn = form.locator('button[type="submit"]').filter({ hasText: /enviar/i }).first();
  }

  // 6.3) Si el botón no está habilitado, puede ser que el contenteditable
  // no haya disparado input correctamente. Forzamos eventos.
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
    // fallback global por si el form cambió
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
}
