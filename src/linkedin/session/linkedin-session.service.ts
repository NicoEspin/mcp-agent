// src/linkedin/session/linkedin-session.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlaywrightService } from '../../browser/playwright.service';
import { StreamService } from '../../stream/stream.service';

export interface LinkedinSessionCheck {
  ok: boolean;
  isLoggedIn: boolean;
  confidence?: number; // 0..1
  signals?: string[];
  reason?: string;
  checkedAt: number;
  imageMimeType?: string;
  sessionId?: string; // <- para trazabilidad
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
    try {
      const isLoggedIn = await this.playwright.isLinkedInLoggedIn(sessionId);
      const hasToken = isLoggedIn
        ? await this.playwright.getLinkedInAuthToken(sessionId)
        : null;

      const check: LinkedinSessionCheck = {
        ok: true,
        isLoggedIn: Boolean(hasToken),
        confidence: hasToken ? 1 : 0,
        signals: [hasToken ? 'li_at_present' : 'li_at_missing'],
        reason: hasToken
          ? 'li_at cookie presente'
          : 'li_at cookie no encontrada',
        checkedAt: Date.now(),
        sessionId,
      };

      this.lastChecks.set(sessionId, check);

      this.logger.log(
        `LinkedIn session check [${sessionId}] -> logged=${check.isLoggedIn} ` +
          `conf=${check.confidence ?? '?'} ` +
          `signals=${(check.signals ?? []).join(',')}`,
      );

      return check;
    } catch (e: any) {
      const errCheck: LinkedinSessionCheck = {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['cookie_check_error'],
        reason: e?.message ?? 'Error checking li_at cookie',
        checkedAt: Date.now(),
        sessionId,
      };
      this.lastChecks.set(sessionId, errCheck);
      return errCheck;
    }
  }

  async assertLoggedIn(sessionId = 'default', force = false) {
    const check = await this.checkLoggedIn(sessionId, force);
    if (!check.ok || !check.isLoggedIn) {
      throw new Error(check.reason ?? 'LinkedIn session not authenticated');
    }
    return check;
  }
}
