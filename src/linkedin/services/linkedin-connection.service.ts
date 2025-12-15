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
    
    const verboseResult = {
      ok: true,
      result: false,
      profileUrl,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'openai_vision_analysis',
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],
        openaiDetails: {
          model: 'gpt-5-nano',
          prompt: null as string | null,
          response: null as any,
          outputText: null as string | null,
          usage: null as any
        }
      },
    };

    try {
      verboseResult.executionDetails.steps.push('Starting checkConnection process');
      
      // Check LinkedIn authentication status before proceeding
      verboseResult.executionDetails.steps.push('Checking LinkedIn authentication status');
      const isAuthenticated = await this.checkAndLogLinkedInAuth(sessionId);
      if (!isAuthenticated) {
        verboseResult.executionDetails.steps.push('User not logged into LinkedIn - returning false');
        this.logger.warn(
          `Cannot check connection - user not logged into LinkedIn (session: ${sessionId})`,
        );
        
        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.ok = false;
        verboseResult.result = false;
        verboseResult.executionDetails.errors.push({
          message: 'User not authenticated',
          timestamp: endTime
        });
        
        return verboseResult;
      }

      verboseResult.executionDetails.steps.push('User authenticated, capturing profile screenshot');
      const { base64, mimeType } = await this.captureProfileScreenshot(
        sessionId,
        profileUrl,
      );
      
      verboseResult.executionDetails.steps.push(`Screenshot captured: ${mimeType}, size: ${base64.length} chars`);

      const prompt = `
Analizá esta captura del perfil de LinkedIn.

Objetivo:
Determinar si el usuario LOGUEADO actualmente en LinkedIn ya está conectado con este perfil.

Reglas de salida:
- Respondé SOLO con "true" o "false" (sin comillas).
- true => ya están conectados.
- false => NO están conectados o aparece un CTA que indica que hay que enviar solicitud.
`;

      verboseResult.executionDetails.openaiDetails.prompt = prompt;
      verboseResult.executionDetails.steps.push('Sending request to OpenAI vision model');

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

      verboseResult.executionDetails.openaiDetails.response = resp;
      verboseResult.executionDetails.openaiDetails.usage = resp.usage;
      
      const out = resp?.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';
      verboseResult.executionDetails.openaiDetails.outputText = out;
      verboseResult.executionDetails.steps.push(`OpenAI response received: "${out}"`);

      let finalResult = false;
      
      if (out === 'true') {
        finalResult = true;
        verboseResult.executionDetails.steps.push('Direct match: "true" - users are connected');
      } else if (out === 'false') {
        finalResult = false;
        verboseResult.executionDetails.steps.push('Direct match: "false" - users not connected');
      } else {
        const hasTrue = /\btrue\b/i.test(out);
        const hasFalse = /\bfalse\b/i.test(out);

        if (hasTrue && !hasFalse) {
          finalResult = true;
          verboseResult.executionDetails.steps.push('Regex match: found "true" in response - users are connected');
        } else if (hasFalse && !hasTrue) {
          finalResult = false;
          verboseResult.executionDetails.steps.push('Regex match: found "false" in response - users not connected');
        } else {
          verboseResult.executionDetails.steps.push(`Unexpected model output: ${out} - defaulting to false`);
          verboseResult.executionDetails.errors.push({
            message: `Unexpected model output: ${out}`,
            timestamp: Date.now()
          });
          this.logger.warn(`checkConnection: salida inesperada del modelo: ${out}`);
          finalResult = false;
        }
      }

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.result = finalResult;
      verboseResult.executionDetails.steps.push(`Final result: ${finalResult}`);
      
      return verboseResult;
      
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.ok = false;
      verboseResult.result = false;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime
      });
      verboseResult.executionDetails.steps.push(`Error occurred: ${e?.message ?? 'Unknown error'}`);
      
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
          selectors: [] as string[]
        }
      },
      note: null as string | null,
      toolResult: null as any,
    };

    try {
      verboseResult.executionDetails.steps.push('Starting sendConnection process');
      
      // Check LinkedIn authentication status before proceeding
      verboseResult.executionDetails.steps.push('Checking LinkedIn authentication status');
      const isAuthenticated = await this.checkAndLogLinkedInAuth(sessionId);
      if (!isAuthenticated) {
        verboseResult.executionDetails.steps.push('User not authenticated - returning error');
        
        const endTime = Date.now();
        verboseResult.executionDetails.endTime = endTime;
        verboseResult.executionDetails.executionTimeMs = endTime - startTime;
        verboseResult.executionDetails.errors.push({
          message: 'User not logged into LinkedIn',
          timestamp: endTime
        });
        
        return {
          ok: false,
          error: 'User not logged into LinkedIn',
          detail: 'Please login to LinkedIn first before attempting to send connections',
          executionDetails: verboseResult.executionDetails,
          profileUrl,
          sessionId
        };
      }

      verboseResult.executionDetails.steps.push('User authenticated, building Playwright execution code');

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
      
      // Realistic human delay before checking modal (7-10 seconds)
      await page.waitForTimeout(7000 + Math.random() * 3000); // 7-10 seconds
      
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
          
          // Realistic human thinking time before clicking (7-12 seconds)
          await page.waitForTimeout(7000 + Math.random() * 5000); // 7-12 seconds
          
          // Human-like delay and hover before click
          await addNoteButton.hover();
          await page.waitForTimeout(2000 + Math.random() * 2000); // 2-4 seconds hover
          
          await addNoteButton.click({ timeout: 5000 });
          
          // Wait for textarea to appear (8-12 seconds)
          await page.waitForTimeout(8000 + Math.random() * 4000); // 8-12 seconds
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
          
          // Realistic human thinking time before typing (7-15 seconds)
          await page.waitForTimeout(7000 + Math.random() * 8000); // 7-15 seconds
          
          // Human-like interaction with textarea
          await textarea.hover();
          await page.waitForTimeout(2000 + Math.random() * 3000); // 2-5 seconds hover
          
          await textarea.click();
          await page.waitForTimeout(1000 + Math.random() * 2000); // 1-3 seconds after click
          
          // Clear existing text and add our note with human typing speed
          await textarea.fill('');
          await page.waitForTimeout(2000 + Math.random() * 2000); // 2-4 seconds after clear
          
          // Type with realistic human speed and pauses
          const chars = note.split('');
          for (let i = 0; i < chars.length; i++) {
            await textarea.type(chars[i]);
            
            // Realistic variable typing speed
            let delay = 150 + Math.random() * 250; // 150-400ms per character
            
            // Frequent longer pauses (thinking/hesitation)
            if (Math.random() < 0.2) { // 20% chance
              delay += 1000 + Math.random() * 2000; // Extra 1-3 second pause
            }
            
            // Longer pause after punctuation
            if (['.', ',', '!', '?'].includes(chars[i])) {
              delay += 500 + Math.random() * 1000; // Extra 500ms-1.5s after punctuation
            }
            
            // Pause after spaces (word breaks)
            if (chars[i] === ' ') {
              delay += 200 + Math.random() * 400; // Extra 200-600ms after spaces
            }
            
            await page.waitForTimeout(delay);
          }
          
          // Realistic pause after typing to review message (7-12 seconds)
          await page.waitForTimeout(7000 + Math.random() * 5000); // 7-12 seconds
          
          await debug('Nota añadida: ' + note.slice(0, 50) + '...');
        } else {
          await debug('No se encontró textarea para la nota');
        }
      }
      
      // STEP 3: Click send button with human-like behavior
      await debug('Buscando botón de envío');
      
      // Realistic human delay before looking for send button (7-12 seconds thinking)
      await page.waitForTimeout(7000 + Math.random() * 5000); // 7-12 seconds
      
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
        
        // Final thinking time before sending (8-15 seconds - most important pause!)
        await page.waitForTimeout(8000 + Math.random() * 7000); // 8-15 seconds
        
        // Human-like interaction with send button
        await sendButton.hover();
        await page.waitForTimeout(2000 + Math.random() * 3000); // 2-5 seconds hover
        
        // Last moment hesitation before final click (3-7 seconds)
        await page.waitForTimeout(3000 + Math.random() * 4000); // 3-7 seconds
        
        await sendButton.click({ timeout: 5000 });
        
        // Wait for the action to complete (7-12 seconds)
        await page.waitForTimeout(7000 + Math.random() * 5000); // 7-12 seconds
        
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
      verboseResult.executionDetails.playwrightDetails.codeLength = code.length;
      verboseResult.executionDetails.steps.push(`Generated Playwright code: ${code.length} characters`);
      verboseResult.executionDetails.steps.push('Executing Playwright code with human-like behavior');
      
      const result = await this.playwright.runCode(code, sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.steps.push('Playwright execution completed');

      this.logger.debug(
        'browser_run_code result (sendConnection popover): ' +
          JSON.stringify(result, null, 2),
      );

      if (result?.isError) {
        verboseResult.executionDetails.errors.push({
          message: 'Playwright MCP error',
          detail: result?.content ?? result,
          timestamp: endTime
        });
        verboseResult.executionDetails.steps.push(`Error in Playwright execution: ${result?.content ?? result}`);
        
        return {
          ok: false,
          error: 'Playwright MCP error en browser_run_code',
          detail: result?.content ?? result,
          executionDetails: verboseResult.executionDetails,
          profileUrl,
          sessionId
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
      verboseResult.executionDetails.steps.push(`Connection sent via: ${connectionMethod}${selectorInfo}`);
      
      if (result?.viaDirect) {
        verboseResult.executionDetails.playwrightDetails.selectors.push(result.selector || 'unknown');
      }
      
      if (result?.noteAdded) {
        verboseResult.executionDetails.steps.push(`Custom note added: ${note?.slice(0, 50)}...`);
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
        timestamp: endTime
      });
      verboseResult.executionDetails.steps.push(`Error occurred: ${e?.message ?? 'Unknown error'}`);

      this.logger.warn(`sendConnection (popover) failed: ${e?.message ?? e}`);
      
      return { 
        ok: false, 
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        sessionId
      };
    }
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime
      });
      verboseResult.executionDetails.steps.push(`Outer error: ${e?.message ?? 'Unknown error'}`);

      this.logger.warn(`sendConnection failed: ${e?.message ?? e}`);
      
      return { 
        ok: false, 
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        sessionId
      };
    }
  }
}
