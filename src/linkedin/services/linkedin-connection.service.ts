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
    console.log('[send-connection]', msg, 'url=', page.url());
  };

  // Function to handle note modal with human-like behavior
  const handleNoteModal = async (page, note, debug) => {
    try {
      await debug('Verificando si apareció modal de nota');
      
      // Human-like delay before checking modal
      await page.waitForTimeout(1000 + Math.random() * 1000); // 1-2 seconds
      
      // Multiple selectors for the note modal
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
      
      // If note is provided, add it
      if (note && note.trim()) {
        await debug('Procesando nota personalizada');
        
        // STEP 1: Look for "Añadir una nota" button first
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
        
        // Click "Añadir una nota" button if found
        if (addNoteButton) {
          await debug('Haciendo click en "Añadir una nota"');
          
          // Human-like delay and hover before click
          await addNoteButton.hover();
          await page.waitForTimeout(300 + Math.random() * 200); // 300-500ms
          
          await addNoteButton.click({ timeout: 5000 });
          
          // Wait for textarea to appear
          await page.waitForTimeout(800 + Math.random() * 400); // 800-1200ms
        }
        
        // STEP 2: Find the textarea (now should be visible)
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
          
          // Human-like interaction with textarea
          await textarea.hover();
          await page.waitForTimeout(200 + Math.random() * 300); // 200-500ms
          
          await textarea.click();
          await page.waitForTimeout(100 + Math.random() * 200); // 100-300ms
          
          // Clear existing text and add our note with human typing speed
          await textarea.fill('');
          await page.waitForTimeout(150 + Math.random() * 100); // 150-250ms
          
          // Type with human-like speed and occasional pauses
          const chars = note.split('');
          for (let i = 0; i < chars.length; i++) {
            await textarea.type(chars[i]);
            
            // Variable typing speed
            let delay = 80 + Math.random() * 120; // 80-200ms per character
            
            // Occasional longer pauses (thinking/hesitation)
            if (Math.random() < 0.1) { // 10% chance
              delay += 300 + Math.random() * 500; // Extra 300-800ms pause
            }
            
            // Pause after punctuation
            if (['.', ',', '!', '?'].includes(chars[i])) {
              delay += 100 + Math.random() * 200; // Extra 100-300ms after punctuation
            }
            
            await page.waitForTimeout(delay);
          }
          
          // Small pause after typing
          await page.waitForTimeout(300 + Math.random() * 500); // 300-800ms
          
          await debug('Nota añadida: ' + note.slice(0, 50) + '...');
        } else {
          await debug('No se encontró textarea para la nota');
        }
      }
      
      // STEP 3: Click send button with human-like behavior
      await debug('Buscando botón de envío');
      
      // Human-like delay before looking for send button
      await page.waitForTimeout(500 + Math.random() * 500); // 500-1000ms
      
      const sendButtonSelectors = [
        'button:has(span.artdeco-button__text:text("Enviar"))',
        'button:has-text("Enviar")',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Enviar" i]',
        'button[data-control-name="send_invite"]',
        'button[type="submit"]',
        'button.artdeco-button--primary',
        'button:has-text("Send")',
        'button:has-text("Send invitation")',
        'button:has-text("Enviar invitación")',
        '.artdeco-button--primary:has-text("Enviar")'
      ];
      
      let sendButton = null;
      for (const selector of sendButtonSelectors) {
        const btnEl = modal.locator(selector).first();
        const isVisible = await btnEl.isVisible().catch(() => false);
        const isEnabled = isVisible ? await btnEl.isEnabled().catch(() => false) : false;
        if (isVisible && isEnabled) {
          sendButton = btnEl;
          await debug('Botón de envío encontrado: ' + selector);
          break;
        }
      }
      
      if (sendButton) {
        await debug('Preparando envío de conexión');
        
        // Human-like interaction with send button
        await sendButton.hover();
        await page.waitForTimeout(400 + Math.random() * 300); // 400-700ms
        
        // Small delay before final click (user thinking)
        await page.waitForTimeout(200 + Math.random() * 400); // 200-600ms
        
        await sendButton.click({ timeout: 5000 });
        
        // Wait for the action to complete
        await page.waitForTimeout(1500 + Math.random() * 1000); // 1.5-2.5 seconds
        
        await debug('Conexión enviada con modal completado');
        return true;
      } else {
        await debug('No se encontró botón de envío válido');
        // Try to close modal and proceed
        const closeButtons = modal.locator('[aria-label*="dismiss" i], [aria-label*="close" i], button:has-text("×")');
        const closeBtn = closeButtons.first();
        const closeVisible = await closeBtn.isVisible().catch(() => false);
        if (closeVisible) {
          await closeBtn.click();
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
      await page.waitForTimeout(2000); // Wait for modal to appear
      
      // Handle note modal if it appears
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

  // 7) Espera y manejo del modal de nota
  await page.waitForTimeout(2000); // Wait for modal to appear
  
  // Handle note modal if it appears
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
