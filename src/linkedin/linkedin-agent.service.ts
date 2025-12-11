// // src/linkedin/linkedin-agent.service.ts
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import OpenAI from 'openai';
// import { PlaywrightMcpService } from '../mcp/playwright-mcp.service';
// import { StreamService } from '../stream/stream.service';
// import { ResponseCreateParamsNonStreaming, ResponseIncludable } from 'openai/resources/responses/responses.js';

// type AgentAction = 'read_chat' | 'send_message' | 'send_connection';

// type SelectorFeature =
//   | 'profile.message_cta'
//   | 'read_chat.root'
//   | 'read_chat.items'
//   | 'send_message.textbox'
//   | 'send_message.send_button';

// interface SelectorEntry {
//   selectors: string[];
//   updatedAt: number;
//   reason?: string;
// }

// interface ReadChatResult {
//   ok: boolean;
//   code?: string; // ERROR_CODE semántico para el agente
//   error?: string;
//   profileUrl?: string;
//   limit?: number;
//   data?: any;
//   raw?: any;
// }

// const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// @Injectable()
// export class LinkedinAgentService {
//   private readonly logger = new Logger(LinkedinAgentService.name);
//   private readonly openai: OpenAI;
//   private readonly model: string;

//   // ----------------------------
//   // Self-heal selectors cache
//   // ----------------------------
//   private selectors = new Map<SelectorFeature, SelectorEntry>();

//   // Seeds razonables (tu base actual)
//   private readonly seedSelectors: Record<SelectorFeature, string[]> = {
//     'profile.message_cta': [
//       'button[aria-label^="Enviar mensaje"]',
//       'button[aria-label^="Message"]',
//       'button:has-text("Enviar mensaje")',
//       'button:has-text("Message")',
//       'a:has-text("Enviar mensaje")',
//       'a:has-text("Message")',
//       // iconos conocidos
//       'use[href="#send-privately-small"]',
//       'use[href="#send-privately-medium"]',
//       'svg[data-test-icon="send-privately-small"]',
//       'svg[data-test-icon="send-privately-medium"]',
//     ],
//     'read_chat.root': [
//       '.msg-overlay-conversation-bubble',
//       '.msg-overlay-bubble',
//       '.msg-overlay-conversation',
//       '.msg-s-message-list',
//       '.msg-thread',
//       'section[aria-label*="Conversación"]',
//       'section[aria-label*="Conversation"]',
//     ],
//     'read_chat.items': [
//       '.msg-s-message-list__event',
//       '.msg-s-message-group__message',
//       '.msg-s-message-group__messages',
//       '[role="listitem"]',
//       'li',
//       'article',
//     ],
//     'send_message.textbox': [
//       'div.msg-form__contenteditable[role="textbox"][contenteditable="true"]',
//       'div[role="textbox"][contenteditable="true"]',
//       'textarea',
//     ],
//     'send_message.send_button': [
//       'button.msg-form__send-button[type="submit"]',
//       'button.msg-form__send-button',
//       'button[type="submit"]:has-text("Enviar")',
//       'button[type="submit"]:has-text("Send")',
//     ],
//   };

//   constructor(
//     private readonly config: ConfigService,
//     private readonly mcp: PlaywrightMcpService,
//     private readonly stream: StreamService,
//   ) {
//     this.model =
//       this.config.get<string>('OPENAI_VISION_MODEL') ??
//       this.config.get<string>('OPENAI_MODEL') ??
//       'gpt-5-nano';

//     this.openai = new OpenAI({
//       apiKey: this.config.get<string>('OPENAI_API_KEY'),
//       baseURL:
//         this.config.get<string>('OPENAI_BASE_URL') ??
//         'https://api.openai.com/v1',
//     });

//     // Inicializar cache con seeds
//     (Object.keys(this.seedSelectors) as SelectorFeature[]).forEach((k) => {
//       this.selectors.set(k, {
//         selectors: [...this.seedSelectors[k]],
//         updatedAt: Date.now(),
//         reason: 'seed',
//       });
//     });
//   }

//   // ----------------------------
//   // Selectors helpers
//   // ----------------------------
//   private sanitizeSelectors(list: unknown): string[] {
//     if (!Array.isArray(list)) return [];
//     const out: string[] = [];

//     for (const s of list) {
//       if (typeof s !== 'string') continue;
//       const trimmed = s.trim();
//       if (!trimmed) continue;

//       // Filtro simple anti-basura
//       if (trimmed.length > 200) continue;
//       out.push(trimmed);
//     }

//     // dedupe
//     return Array.from(new Set(out)).slice(0, 12);
//   }

//   private getSelectors(feature: SelectorFeature): string[] {
//     const seeded = this.seedSelectors[feature] ?? [];
//     const learned = this.selectors.get(feature)?.selectors ?? [];

//     const merged = Array.from(new Set([...learned, ...seeded]));
//     return merged.slice(0, 12);
//   }

//   private saveSelectors(
//     feature: SelectorFeature,
//     selectors: string[],
//     reason?: string,
//   ) {
//     const clean = this.sanitizeSelectors(selectors);
//     if (!clean.length) return;

//     this.selectors.set(feature, {
//       selectors: clean,
//       updatedAt: Date.now(),
//       reason,
//     });

//     this.logger.log(`Selectors updated for ${feature}: ${clean.length} items`);
//   }

//   // ----------------------------
//   // MCP helpers
//   // ----------------------------
//   private extractFirstText(result: any): string | null {
//     if (!result) return null;
//     if (typeof result === 'string') return result;

//     const content =
//       result?.content ??
//       result?.result?.content ??
//       result?.data?.content ??
//       result?.payload?.content;

//     if (Array.isArray(content)) {
//       const t = content.find(
//         (c: any) => c?.type === 'text' && typeof c?.text === 'string',
//       );
//       if (t) return t.text;
//     }

//     if (typeof result?.text === 'string') return result.text;
//     if (typeof result?.content === 'string') return result.content;

//     return null;
//   }

//   // ----------------------------
//   // 1) Builder dinámico read-chat
//   // ----------------------------
//   private buildReadChatCode(
//     profileUrl: string,
//     limit: number,
//     threadHint?: string,
//   ) {
//     const rootSelectors = this.getSelectors('read_chat.root');
//     const itemSelectors = this.getSelectors('read_chat.items');

//     return `
// const profileUrl = ${JSON.stringify(profileUrl)};
// const limit = ${JSON.stringify(limit)};
// const threadHint = ${JSON.stringify(threadHint ?? '')};

// const ROOT_SELECTORS = ${JSON.stringify(rootSelectors)};
// const ITEM_SELECTORS = ${JSON.stringify(itemSelectors)};

// const debug = (msg) => console.log('[read-chat]', msg, 'url=', page.url());

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
// await page.waitForTimeout(1200);
// await debug('Perfil cargado');

// const main = page.locator('main').first();
// const topCard =
//   main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
// const scope = (await topCard.count()) ? topCard : main;

// // ---------- encontrar CTA Mensaje ----------
// const findMessageButton = async () => {
//   // 1) aria-label directo
//   let loc = scope.locator(
//     'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
//   ).first();
//   if (await loc.count()) return loc;

//   loc = main.locator(
//     'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
//   ).first();
//   if (await loc.count()) return loc;

//   // 2) texto
//   loc = scope.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
//   if (await loc.count()) return loc;

//   loc = main.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
//   if (await loc.count()) return loc;

//   // 3) iconos
//   const icon = scope.locator(
//     'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
//     'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
//   ).first();

//   if (await icon.count()) {
//     const btn = icon.locator('xpath=ancestor::button[1]').first();
//     if (await btn.count()) return btn;
//   }

//   const icon2 = main.locator(
//     'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
//     'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
//   ).first();

//   if (await icon2.count()) {
//     const btn = icon2.locator('xpath=ancestor::button[1]').first();
//     if (await btn.count()) return btn;
//   }

//   return null;
// };

// let messageBtn = await findMessageButton();

// // ---------- fallback overflow "Más" ----------
// if (!messageBtn) {
//   await debug('CTA mensaje no encontrado. Probando overflow del perfil');

//   const moreBtn = scope.locator(
//     'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
//     'button[data-view-name="profile-overflow-button"][aria-label="More"]'
//   ).first();

//   if (await moreBtn.count()) {
//     await moreBtn.scrollIntoViewIfNeeded();
//     await moreBtn.click({ timeout: 15000, force: true });
//     await page.waitForTimeout(250);

//     const msgItem = page.getByRole('menuitem', {
//       name: /enviar mensaje|mensaje|message/i,
//     }).first();

//     if (await msgItem.count()) {
//       await msgItem.click({ timeout: 15000 });
//     } else {
//       throw new Error('CTA_NOT_FOUND_IN_MORE_MENU');
//     }
//   } else {
//     throw new Error('CTA_NOT_FOUND');
//   }
// } else {
//   const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
//   if (/para negocios|for business/i.test(aria)) {
//     throw new Error('CTA_HEADER_MISSELECTION');
//   }

//   await debug('Click CTA Enviar mensaje');
//   await messageBtn.scrollIntoViewIfNeeded();
//   await messageBtn.click({ timeout: 15000, force: true });
// }

// await page.waitForTimeout(900);

// // ---------- detectar conversación (overlay o full page) ----------
// const findConversationRoot = async (timeout = 12000) => {
//   const start = Date.now();

//   while (Date.now() - start < timeout) {
//     for (const sel of ROOT_SELECTORS) {
//       const loc = page.locator(sel).last();
//       try {
//         if ((await loc.count()) && (await loc.isVisible())) return loc;
//       } catch {}
//     }
//     await sleep(200);
//   }
//   return null;
// };

// let root = await findConversationRoot();

// if (!root) {
//   // Fallback suave: a veces la UI ya está renderizada en main sin selector exacto
//   await debug('Root no encontrado con lista conocida. Intento fallback general');
//   const alt = page.locator(
//     '.msg-s-message-list, .msg-thread, main .msg-form, main [role="textbox"]'
//   ).last();

//   if ((await alt.count()) && (await alt.isVisible())) {
//     root = alt;
//   }
// }

// if (!root) throw new Error('OVERLAY_NOT_FOUND');

// await debug('Conversación detectada');

// // ---------- extracción robusta ----------
// const extractMessages = async () => {
//   let items = null;

//   // Probar lista de selectores de items
//   for (const sel of ITEM_SELECTORS) {
//     const loc = root.locator(sel);
//     if (await loc.count()) {
//       items = loc;
//       break;
//     }
//   }

//   if (!items) {
//     items = root.locator('[role="listitem"], li, article');
//   }

//   const count = await items.count();
//   if (!count) return [];

//   const texts = await items.evaluateAll((els) => {
//     const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
//     return els.map((el) => norm(el.textContent)).filter(Boolean);
//   });

//   return texts.slice(-limit);
// };

// let msgs = await extractMessages();

// if (!msgs.length) {
//   await debug('Fallback broad text scrape');
//   const broad = await root.evaluate((el) => {
//     const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
//     const blocks = Array.from(el.querySelectorAll('div, span, p'))
//       .map((n) => norm(n.textContent))
//       .filter(Boolean);

//     const uniq = [];
//     const seen = new Set();
//     for (const b of blocks) {
//       if (b.length < 2) continue;
//       if (seen.has(b)) continue;
//       seen.add(b);
//       uniq.push(b);
//     }
//     return uniq.slice(-50);
//   });

//   msgs = broad.slice(-limit);
// }

// return {
//   ok: true,
//   limit,
//   messages: msgs,
//   extractedAt: new Date().toISOString(),
// };
// `;
//   }

//   // ----------------------------
//   // 2) Tool de alto nivel: attempt_read_chat
//   // ----------------------------
//   private async attemptReadChat(
//     profileUrl: string,
//     limit = 30,
//     threadHint?: string,
//   ): Promise<ReadChatResult> {
//     const code = this.buildReadChatCode(profileUrl, limit, threadHint);

//     try {
//       const result: any = await this.mcp.callTool('browser_run_code', { code });

//       if (result?.isError) {
//         const txt = this.extractFirstText(result) ?? '';
//         return {
//           ok: false,
//           code: 'MCP_RUN_CODE_ERROR',
//           error: txt,
//           raw: result,
//         };
//       }

//       const txt = this.extractFirstText(result) ?? '';
//       let parsed: any = null;

//       try {
//         parsed = JSON.parse(txt);
//       } catch {
//         parsed = null;
//       }

//       return {
//         ok: true,
//         profileUrl,
//         limit,
//         data: parsed ?? { raw: txt },
//         raw: result,
//       };
//     } catch (e: any) {
//       const msg = e?.message ?? String(e);

//       // Normalizamos códigos esperables para que el agente razone
//       if (/OVERLAY_NOT_FOUND/i.test(msg)) {
//         return { ok: false, code: 'OVERLAY_NOT_FOUND', error: msg };
//       }
//       if (/CTA_NOT_FOUND_IN_MORE_MENU/i.test(msg)) {
//         return { ok: false, code: 'CTA_NOT_FOUND_IN_MORE_MENU', error: msg };
//       }
//       if (/CTA_NOT_FOUND/i.test(msg)) {
//         return { ok: false, code: 'CTA_NOT_FOUND', error: msg };
//       }
//       if (/CTA_HEADER_MISSELECTION/i.test(msg)) {
//         return { ok: false, code: 'CTA_HEADER_MISSELECTION', error: msg };
//       }

//       return { ok: false, code: 'UNKNOWN', error: msg };
//     }
//   }

//   // ----------------------------
//   // 3) Tools “bajas” de Playwright
//   // ----------------------------
//   private async pwNavigate(url: string) {
//     return this.mcp.callTool('browser_navigate', { url });
//   }

//   private async pwSnapshot() {
//     return this.mcp.callTool('browser_snapshot', {});
//   }

//   private async pwRunCode(code: string) {
//     return this.mcp.callTool('browser_run_code', { code });
//   }

//   private async getScreenshot(maxAgeMs = 1200) {
//     const { data, mimeType } =
//       await this.stream.getCachedScreenshotBase64(maxAgeMs);
//     return { data, mimeType };
//   }

//   // ----------------------------
//   // 4) Definición de tools para Responses
//   // ----------------------------
//   // ----------------------------
//   // 4) Definición de tools para Responses
//   // ----------------------------
//   // ----------------------------
//   // 4) Definición de tools para Responses
//   // ----------------------------
//   private getTools() {
//     return [
//       // ✅ tus tools de alto nivel
//       {
//         type: 'function' as const,
//         name: 'attempt_read_chat',
//         strict: true,
//         description:
//           'Intenta abrir la conversación desde un perfil y extraer los últimos mensajes.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {
//             profileUrl: { type: 'string' },
//             limit: { type: 'integer', minimum: 1, maximum: 100 },
//             threadHint: { type: 'string' },
//           },
//           required: ['profileUrl', 'limit', 'threadHint'],
//         },
//       },

//       // ✅ tus helpers existentes
//       {
//         type: 'function' as const,
//         name: 'pw_navigate',
//         strict: true,
//         description: 'Navega a una URL usando Playwright MCP.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: { url: { type: 'string' } },
//           required: ['url'],
//         },
//       },
//       {
//         type: 'function' as const,
//         name: 'pw_snapshot',
//         strict: true,
//         description: 'Obtiene un snapshot estructurado de la página actual.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {},
//           required: [],
//         },
//       },
//       {
//         type: 'function' as const,
//         name: 'pw_run_code',
//         strict: true,
//         description: 'Ejecuta código Playwright JS en el contexto compartido.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: { code: { type: 'string' } },
//           required: ['code'],
//         },
//       },
//       {
//         type: 'function' as const,
//         name: 'get_screenshot',
//         strict: true,
//         description:
//           'Devuelve screenshot base64 reciente para análisis visual del agente.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {
//             maxAgeMs: { type: 'integer', minimum: 0, maximum: 5000 },
//           },
//           required: ['maxAgeMs'],
//         },
//       },

//       // ✅ NUEVO: listar tools reales del MCP
//       {
//         type: 'function' as const,
//         name: 'list_mcp_tools',
//         strict: true,
//         description:
//           'Lista las herramientas nativas disponibles en el servidor Playwright MCP conectado.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {},
//           required: [],
//         },
//       },

//       // ✅ NUEVO: proxy controlado
//       {
//         type: 'function' as const,
//         name: 'pw_call',
//         strict: true,
//         description:
//           'Proxy genérico para invocar herramientas nativas del Playwright MCP (browser_*). ' +
//           'Pasá los argumentos como JSON string en args_json. Usá "{}" si no hay argumentos.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {
//             tool: { type: 'string' },
//             args_json: { type: 'string' },
//           },
//           required: ['tool', 'args_json'],
//         },
//       },

//       // ✅ tus tools de selectores
//       {
//         type: 'function' as const,
//         name: 'get_selector_hints',
//         strict: true,
//         description: 'Obtiene selectores cacheados por feature.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {
//             feature: {
//               type: 'string',
//               enum: [
//                 'profile.message_cta',
//                 'read_chat.root',
//                 'read_chat.items',
//                 'send_message.textbox',
//                 'send_message.send_button',
//               ],
//             },
//           },
//           required: ['feature'],
//         },
//       },
//       {
//         type: 'function' as const,
//         name: 'save_selector_hints',
//         strict: true,
//         description: 'Guarda nuevos selectores inferidos por el agente.',
//         parameters: {
//           type: 'object',
//           additionalProperties: false,
//           properties: {
//             feature: {
//               type: 'string',
//               enum: [
//                 'profile.message_cta',
//                 'read_chat.root',
//                 'read_chat.items',
//                 'send_message.textbox',
//                 'send_message.send_button',
//               ],
//             },
//             selectors: {
//               type: 'array',
//               items: { type: 'string' },
//               minItems: 1,
//               maxItems: 12,
//             },
//             reason: { type: 'string' },
//           },
//           required: ['feature', 'selectors', 'reason'],
//         },
//       },
//     ];
//   }

//   // ----------------------------
//   // 5) Dispatcher de tools
//   // ----------------------------
//   private async callLocalTool(name: string, args: any) {
//     switch (name) {
//       case 'attempt_read_chat':
//         return this.attemptReadChat(
//           args?.profileUrl,
//           typeof args?.limit === 'number' ? args.limit : 30,
//           typeof args?.threadHint === 'string' ? args.threadHint : '',
//         );

//       case 'pw_navigate':
//         return this.pwNavigate(args.url);

//       case 'pw_snapshot':
//         return this.pwSnapshot();

//       case 'pw_run_code':
//         return this.pwRunCode(args.code);

//       case 'get_screenshot':
//         return this.getScreenshot(
//           typeof args?.maxAgeMs === 'number' ? args.maxAgeMs : 1200,
//         );

//       case 'list_mcp_tools': {
//         const defs = await this.mcp.listToolDefs();
//         return {
//           ok: true,
//           tools: defs.map((t: any) => ({
//             name: t?.name,
//             description: t?.description,
//             inputSchema: t?.inputSchema,
//           })),
//         };
//       }
//       case 'pw_call': {
//         const tool = String(args?.tool ?? '');

//         let payload: any = {};
//         try {
//           payload =
//             typeof args?.args_json === 'string' && args.args_json.trim()
//               ? JSON.parse(args.args_json)
//               : {};
//         } catch {
//           payload = {};
//         }

//         if (!tool.startsWith('browser_')) {
//           return { ok: false, error: 'Only browser_* tools are allowed' };
//         }

//         const can = await this.mcp.hasTool(tool);
//         if (!can) {
//           return { ok: false, error: `MCP tool not available: ${tool}` };
//         }

//         return this.mcp.callTool(tool, payload);
//       }

//       case 'get_selector_hints':
//         return {
//           feature: args.feature,
//           selectors: this.getSelectors(args.feature),
//         };

//       case 'save_selector_hints':
//         this.saveSelectors(
//           args.feature,
//           args.selectors,
//           args.reason ?? 'agent',
//         );
//         return { ok: true };

//       default:
//         return { ok: false, error: `Unknown tool ${name}` };
//     }
//   }

//   // ----------------------------
//   // 6) Extract function calls desde Responses
//   // ----------------------------
//   private extractFunctionCalls(response: any) {
//     const out = response?.output ?? [];
//     if (!Array.isArray(out)) return [];

//     return out.filter((i: any) => i?.type === 'function_call');
//   }

//   // ----------------------------
//   // 7) Loop agente (Responses)
//   // ----------------------------
//   private normalizeBaseInput(input: any) {
//     if (Array.isArray(input)) return input;

//     const text = typeof input === 'string' ? input : String(input ?? '');

//     return [
//       {
//         role: 'user',
//         content: [{ type: 'input_text', text }],
//       },
//     ];
//   }

//   private async runResponseLoop(input: any, instructions: string, maxIterations = 6) {
//   const tools = this.getTools();
//   const baseInput = this.normalizeBaseInput(input);

//   const include: ResponseIncludable[] = ['reasoning.encrypted_content'];

//   const common = {
//     model: this.model,
//     instructions,
//     tools,
//     parallel_tool_calls: false,
//     include,
//     store: true,
//   } satisfies Omit<ResponseCreateParamsNonStreaming, 'input' | 'previous_response_id'>;

//   let resp = await this.openai.responses.create({
//     ...common,
//     input: baseInput,
//   });

//   for (let i = 0; i < maxIterations; i++) {
//     const calls = this.extractFunctionCalls(resp);
//     if (!calls.length) break;

//     const toolOutputs: any[] = [];

//     for (const call of calls) {
//       let args: any = {};
//       try {
//         args = call.arguments ? JSON.parse(call.arguments) : {};
//       } catch {}

//       const result = await this.callLocalTool(call.name, args);

//       toolOutputs.push({
//         type: 'function_call_output',
//         call_id: call.call_id,
//         output: typeof result === 'string' ? result : JSON.stringify(result),
//       });
//     }

//     resp = await this.openai.responses.create({
//       ...common,
//       previous_response_id: resp.id,
//       input: toolOutputs,
//     });
//   }

//   return resp;
// }

//   // ----------------------------
//   // 8) API pública del agente
//   // ----------------------------
//   async run(action: AgentAction, payload: any) {
//     const instructions = `
// Sos un agente de automatización de LinkedIn dentro de un microservicio controlado.

// Objetivo principal: ejecutar la acción solicitada con máxima robustez usando tools.
// Usá preferentemente tools de alto nivel como attempt_read_chat.

// Reglas de autonomía:
// 1) Si attempt_read_chat falla con OVERLAY_NOT_FOUND, pedí pw_snapshot y analizá qué UI de mensajes hay.
// 2) Proponé selectores nuevos SOLO si ves un patrón claro en el snapshot.
// 3) Guardalos con save_selector_hints y reintentá attempt_read_chat.
// 4) Máximo 2 ciclos de self-heal por request.
// 5) No inventes resultados: devolvé ok:false si no se pudo.

// Salida:
// - Si la acción es read_chat, devolvé JSON final con ok, data y, si aplica, code de error.
// `;

//     const userInput = (() => {
//       switch (action) {
//         case 'read_chat':
//           return `Acción: read_chat
// profileUrl: ${payload.profileUrl}
// limit: ${payload.limit ?? 30}
// threadHint: ${payload.threadHint ?? ''}

// Meta:
// Extraer los últimos mensajes disponibles.`;
//         case 'send_message':
//           return `Acción: send_message
// profileUrl: ${payload.profileUrl}
// message: ${payload.message}

// Meta:
// Enviar el mensaje. Si falla por selectores del textbox o send button, usar snapshot y sugerir nuevos selectores para esas features.`;
//         case 'send_connection':
//           return `Acción: send_connection
// profileUrl: ${payload.profileUrl}
// note: ${payload.note ?? ''}

// Meta:
// Enviar solicitud de conexión.`;
//         default:
//           return `Acción desconocida`;
//       }
//     })();

//     const resp = await this.runResponseLoop(userInput, instructions);

//     // output_text helper recomendado en Responses. :contentReference[oaicite:8]{index=8}
//     const text = resp?.output_text ?? '';

//     // Intento parse JSON “suave” para read_chat
//     if (action === 'read_chat') {
//       try {
//         return JSON.parse(text);
//       } catch {
//         return { ok: true, raw: text, responseId: resp?.id };
//       }
//     }

//     return { ok: true, raw: text, responseId: resp?.id };
//   }
// }
