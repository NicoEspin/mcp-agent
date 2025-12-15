// src/linkedin/session/linkedin-session.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlaywrightService } from '../../browser/playwright.service';
import { StreamService } from '../../stream/stream.service';

export interface LinkedinSessionExecutionDetails {
  startTime: number;
  endTime: number | null;
  executionTimeMs: number | null;
  methodsUsed: string[];
  cookieCheckDetails: {
    method: 'playwright_cookie_inspection';
    wasSuccessful: boolean;
    tokenLength: number | null;
  };
  visionCheckDetails: {
    used: boolean;
    openaiModel: string | null;
    screenshotSize: number | null;
    openaiPrompt: string | null;
    openaiResponse: string | null;
    openaiUsage: any;
  };
  fallbackAttempts: number;
  steps: string[];
}

export interface LinkedinSessionCheck {
  ok: boolean;
  isLoggedIn: boolean;
  confidence?: number; // 0..1
  signals?: string[];
  reason?: string;
  checkedAt: number;
  imageMimeType?: string;
  sessionId?: string;

  // ✅ nuevo
  executionDetails?: LinkedinSessionExecutionDetails;
}

@Injectable()
export class LinkedinSessionService {
  private readonly logger = new Logger(LinkedinSessionService.name);

  // En vez de un solo lastCheck, cache por sesión
  private lastChecks = new Map<string, LinkedinSessionCheck>();

  constructor(
    private readonly config: ConfigService,
    private readonly playwright: PlaywrightService,
    private readonly stream: StreamService,
  ) {}

  private getOpenAIKey() {
    return this.config.get<string>('OPENAI_API_KEY');
  }

  private getOpenAIBaseUrl() {
    return (
      this.config.get<string>('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1'
    );
  }

  private getVisionModel() {
    return this.config.get<string>('OPENAI_VISION_MODEL') ?? 'gpt-5-nano';
  }

  private getTtlMs() {
    return Number(this.config.get('LINKEDIN_SESSION_CHECK_TTL_MS') ?? 30000);
  }

  private strictMode() {
    return (
      (this.config.get<string>('LINKEDIN_SESSION_CHECK_STRICT') ?? 'true') ===
      'true'
    );
  }

  private preNavigateEnabled() {
    return (
      (this.config.get<string>('LINKEDIN_SESSION_CHECK_PRENAVIGATE') ??
        'false') === 'true'
    );
  }

  private getPreNavigateUrl() {
    return (
      this.config.get<string>('LINKEDIN_SESSION_CHECK_URL') ??
      'https://www.linkedin.com/'
    );
  }

  private isFresh(check: LinkedinSessionCheck) {
    return Date.now() - check.checkedAt < this.getTtlMs();
  }

  private buildPrompt(): string {
    return `
Sos un validador de sesión de LinkedIn.
Vas a recibir UNA captura de pantalla del navegador actual.

Respondé SOLO JSON válido con esta forma:
{
  "isLoggedIn": boolean,
  "confidence": number,
  "signals": string[],
  "reason": string
}

Usá señales visuales generales, SIN requerir /feed:
- Logged in: barra superior de LinkedIn visible, avatar del usuario, menú con "Mi red", "Empleos", "Mensajes", "Notificaciones", etc.
- Not logged in: pantalla de login/registro, botones "Iniciar sesión / Sign in", inputs de email/contraseña, challenge/verify.

No incluyas texto fuera del JSON.
`.trim();
  }

  private extractAssistantText(resp: any): string {
    // Formato nuevo de /responses
    if (typeof resp?.output_text === 'string') return resp.output_text;

    const output = resp?.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === 'message' && Array.isArray(item?.content)) {
          const textPart = item.content.find(
            (c: any) => c?.type === 'output_text',
          );
          if (textPart?.text) return String(textPart.text);
        }
      }
    }
    return '';
  }

  private safeJsonParse(s: string): any | null {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      const match = s.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  // -------------------------
  // Nuevos helpers de schema
  // -------------------------
  private buildSessionSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        isLoggedIn: { type: 'boolean' },
        confidence: { type: 'number' },
        signals: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['isLoggedIn', 'confidence', 'signals', 'reason'],
    };
  }

  private buildTextFormat() {
    return {
      type: 'json_schema',
      name: 'linkedin_session_check',
      strict: true,
      schema: this.buildSessionSchema(),
    };
  }

  // -------------------------
  // checkLoggedIn multi-sesión
  // -------------------------
  async checkLoggedIn(
    sessionId = 'default',
    force = false,
  ): Promise<LinkedinSessionCheck> {
    const startTime = Date.now();

    const executionDetails: LinkedinSessionExecutionDetails = {
      startTime,
      endTime: null,
      executionTimeMs: null,
      methodsUsed: [],
      cookieCheckDetails: {
        method: 'playwright_cookie_inspection',
        wasSuccessful: false,
        tokenLength: null,
      },
      visionCheckDetails: {
        used: false,
        openaiModel: null,
        screenshotSize: null,
        openaiPrompt: null,
        openaiResponse: null,
        openaiUsage: null,
      },
      fallbackAttempts: 0,
      steps: [],
    };

    // ✅ inicializado: nunca null
    let cookieCheck: LinkedinSessionCheck = {
      ok: false,
      isLoggedIn: false,
      confidence: 0,
      signals: ['init'],
      reason: 'not_checked_yet',
      checkedAt: Date.now(),
      sessionId,
      executionDetails,
    };

    try {
      executionDetails.steps.push(`Starting session check for: ${sessionId}`);
      executionDetails.steps.push(`Force mode: ${force}`);
      executionDetails.methodsUsed.push('cookie_check');

      const isLoggedIn = await this.playwright.isLinkedInLoggedIn(sessionId);
      const hasToken = isLoggedIn
        ? await this.playwright.getLinkedInAuthToken(sessionId)
        : null;

      executionDetails.cookieCheckDetails.wasSuccessful = true;

      if (hasToken) {
        executionDetails.cookieCheckDetails.tokenLength = hasToken.length;
        executionDetails.steps.push(
          `Found li_at token: ${hasToken.slice(0, 10)}... (length: ${hasToken.length})`,
        );
      } else {
        executionDetails.steps.push('No li_at token found in cookies');
      }

      cookieCheck = {
        ok: true,
        isLoggedIn: Boolean(hasToken),
        confidence: hasToken ? 1 : 0,
        signals: [hasToken ? 'li_at_present' : 'li_at_missing'],
        reason: hasToken
          ? 'li_at cookie presente'
          : 'li_at cookie no encontrada',
        checkedAt: Date.now(),
        sessionId,
        executionDetails,
      };
    } catch (e: any) {
      executionDetails.steps.push(
        `Cookie check failed: ${e?.message ?? 'Unknown error'}`,
      );

      cookieCheck = {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['cookie_check_error'],
        reason: e?.message ?? 'Error checking li_at cookie',
        checkedAt: Date.now(),
        sessionId,
        executionDetails,
      };
    }

    // Si cookie dice logged in, opcionalmente validar con visión en force
    if (cookieCheck.ok && cookieCheck.isLoggedIn) {
      let finalCheck: LinkedinSessionCheck = cookieCheck;

      if (force) {
        executionDetails.steps.push(
          'Force mode enabled - running vision fallback',
        );
        executionDetails.methodsUsed.push('vision_fallback');
        executionDetails.fallbackAttempts = 1;

        const visionCheck = await this.runVisionFallback(
          sessionId,
          executionDetails,
        );

        // preferí visión si falla o contradice
        finalCheck = {
          ...visionCheck,
          signals: [
            'vision_fallback_after_failure',
            ...(visionCheck.signals ?? []),
          ],
          executionDetails,
        };
      }

      const endTime = Date.now();
      executionDetails.endTime = endTime;
      executionDetails.executionTimeMs = endTime - startTime;

      // asegurá que el final tenga detalles
      finalCheck = { ...finalCheck, executionDetails };

      this.lastChecks.set(sessionId, finalCheck);

      this.logger.log(
        `LinkedIn session check [${sessionId}] -> logged=${finalCheck.isLoggedIn} ` +
          `conf=${finalCheck.confidence ?? '?'} ` +
          `signals=${(finalCheck.signals ?? []).join(',')} ` +
          `time=${executionDetails.executionTimeMs}ms`,
      );

      return finalCheck;
    }

    // Fallback: visión cuando cookie falla o dice no logged
    executionDetails.steps.push(
      'Cookie check failed or user not logged in - running vision fallback',
    );
    executionDetails.methodsUsed.push('vision_fallback');
    executionDetails.fallbackAttempts = 1;

    const visionCheck = await this.runVisionFallback(
      sessionId,
      executionDetails,
    );

    const endTime = Date.now();
    executionDetails.endTime = endTime;
    executionDetails.executionTimeMs = endTime - startTime;

    const finalVisionCheck: LinkedinSessionCheck = {
      ...visionCheck,
      executionDetails,
    };

    this.lastChecks.set(sessionId, finalVisionCheck);

    this.logger.log(
      `LinkedIn session check [${sessionId}] -> logged=${finalVisionCheck.isLoggedIn} ` +
        `conf=${finalVisionCheck.confidence ?? '?'} ` +
        `signals=${(finalVisionCheck.signals ?? []).join(',')} ` +
        `time=${executionDetails.executionTimeMs}ms`,
    );

    return finalVisionCheck;
  }

  private async runVisionFallback(
    sessionId: string,
    executionDetails?: LinkedinSessionExecutionDetails,
  ): Promise<LinkedinSessionCheck> {
    const apiKey = this.getOpenAIKey();
    if (!apiKey) {
      if (executionDetails) {
        executionDetails.steps.push(
          'Vision fallback failed: missing OpenAI API key',
        );
      }
      return {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['missing_openai_key'],
        reason: 'OPENAI_API_KEY no configurada',
        checkedAt: Date.now(),
        sessionId,
      };
    }

    if (executionDetails) {
      executionDetails.steps.push('Starting vision fallback with OpenAI');
      executionDetails.visionCheckDetails.used = true;
      executionDetails.visionCheckDetails.openaiModel = this.getVisionModel();
    }

    if (this.preNavigateEnabled()) {
      try {
        await this.playwright.navigate(this.getPreNavigateUrl(), sessionId);
        await new Promise((r) => setTimeout(r, 800));
      } catch (e: any) {
        this.logger.warn(
          `Session pre-navigate failed [${sessionId}]: ${e?.message ?? e}`,
        );
      }
    }

    const { data, mimeType } = await this.stream.getCachedScreenshotBase64(
      sessionId,
      800,
    );
    const dataUrl = `data:${mimeType};base64,${data}`;

    if (executionDetails) {
      executionDetails.visionCheckDetails.screenshotSize = data.length;
      executionDetails.steps.push(
        `Screenshot captured: ${mimeType}, size: ${data.length} chars`,
      );
      executionDetails.visionCheckDetails.openaiPrompt = this.buildPrompt();
    }

    const body: any = {
      model: this.getVisionModel(),
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: this.buildPrompt() },
            { type: 'input_image', image_url: dataUrl, detail: 'low' },
          ],
        },
      ],
      text: {
        format: this.buildTextFormat(),
      },
      max_output_tokens: 200,
    };

    if (executionDetails) {
      executionDetails.steps.push('Sending request to OpenAI vision model');
    }

    let raw: any;
    try {
      const res = await fetch(`${this.getOpenAIBaseUrl()}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      raw = await res.json();

      if (executionDetails && raw) {
        executionDetails.visionCheckDetails.openaiUsage = raw.usage || null;
      }

      if (!res.ok) {
        return {
          ok: false,
          isLoggedIn: false,
          confidence: 0,
          signals: ['openai_http_error', 'vision_fallback'],
          reason: raw?.error?.message ?? `OpenAI error ${res.status}`,
          checkedAt: Date.now(),
          imageMimeType: mimeType,
          sessionId,
        };
      }
    } catch (e: any) {
      return {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['openai_network_error', 'vision_fallback'],
        reason: e?.message ?? 'OpenAI network error',
        checkedAt: Date.now(),
        imageMimeType: mimeType,
        sessionId,
      };
    }

    const text = this.extractAssistantText(raw);
    const parsed = this.safeJsonParse(text);

    if (executionDetails) {
      executionDetails.visionCheckDetails.openaiResponse = text;
      executionDetails.steps.push(`OpenAI response: "${text}"`);
    }

    const check: LinkedinSessionCheck = {
      ok: Boolean(parsed),
      isLoggedIn: Boolean(parsed?.isLoggedIn),
      confidence:
        typeof parsed?.confidence === 'number' ? parsed.confidence : undefined,
      signals: ['vision_fallback'].concat(
        Array.isArray(parsed?.signals) ? parsed.signals : [],
      ),
      reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
      checkedAt: Date.now(),
      imageMimeType: mimeType,
      sessionId,
    };

    if (this.strictMode() && !parsed) {
      check.ok = false;
      check.isLoggedIn = false;
      check.confidence = 0;
      check.signals = ['vision_fallback', 'unparsable_model_output'];
      check.reason =
        'El modelo no devolvió JSON parseable para la validación de sesión';
    }

    return check;
  }

  async assertLoggedIn(sessionId = 'default', force = false) {
    const check = await this.checkLoggedIn(sessionId, force);
    if (!check.ok || !check.isLoggedIn) {
      throw new Error(check.reason ?? 'LinkedIn session not authenticated');
    }
    return check;
  }
}
