// src/linkedin/session/linkedin-session.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlaywrightMcpService } from '../../mcp/playwright-mcp.service';
import { StreamService } from '../../stream/stream.service';

export interface LinkedinSessionCheck {
  ok: boolean;
  isLoggedIn: boolean;
  confidence?: number; // 0..1
  signals?: string[];
  reason?: string;
  checkedAt: number;
  imageMimeType?: string;
}

@Injectable()
export class LinkedinSessionService {
  private readonly logger = new Logger(LinkedinSessionService.name);
  private lastCheck: LinkedinSessionCheck | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly mcp: PlaywrightMcpService,
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
  // dentro de LinkedinSessionService

private buildSessionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      isLoggedIn: { type: "boolean" },
      confidence: { type: "number" },
      signals: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
    required: ["isLoggedIn", "confidence", "signals", "reason"],
  };
}

private buildTextFormat() {
  return {
    type: "json_schema",
    name: "linkedin_session_check",
    strict: true,
    schema: this.buildSessionSchema(),
  };
}


  async checkLoggedIn(force = false): Promise<LinkedinSessionCheck> {
    if (!force && this.lastCheck && this.isFresh(this.lastCheck)) {
      return this.lastCheck;
    }

    const apiKey = this.getOpenAIKey();
    if (!apiKey) {
      const fallback: LinkedinSessionCheck = {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['missing_openai_key'],
        reason: 'OPENAI_API_KEY no configurada',
        checkedAt: Date.now(),
      };
      this.lastCheck = fallback;
      return fallback;
    }

    // ✅ Opcional y desactivado por defecto:
    if (this.preNavigateEnabled()) {
      try {
        await this.mcp.callTool('browser_navigate', {
          url: this.getPreNavigateUrl(),
        });
        // mini espera para estabilizar UI
        await new Promise((r) => setTimeout(r, 800));
      } catch (e: any) {
        this.logger.warn(`Session pre-navigate failed: ${e?.message ?? e}`);
      }
    }

    // ✅ Ideal: reusar frame reciente del stream
    const { data, mimeType } = await this.stream.getCachedScreenshotBase64(800);
    const dataUrl = `data:${mimeType};base64,${data}`;

   const body: any = {
  model: this.getVisionModel(),
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: this.buildPrompt() },
        { type: "input_image", image_url: dataUrl, detail: "low" },
      ],
    },
  ],
  text: {
    format: this.buildTextFormat(),
  },
  max_output_tokens: 200,
};


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

      if (!res.ok) {
        const errCheck: LinkedinSessionCheck = {
          ok: false,
          isLoggedIn: false,
          confidence: 0,
          signals: ['openai_http_error'],
          reason: raw?.error?.message ?? `OpenAI error ${res.status}`,
          checkedAt: Date.now(),
          imageMimeType: mimeType,
        };
        this.lastCheck = errCheck;
        return errCheck;
      }
    } catch (e: any) {
      const errCheck: LinkedinSessionCheck = {
        ok: false,
        isLoggedIn: false,
        confidence: 0,
        signals: ['openai_network_error'],
        reason: e?.message ?? 'OpenAI network error',
        checkedAt: Date.now(),
        imageMimeType: mimeType,
      };
      this.lastCheck = errCheck;
      return errCheck;
    }

    const text = this.extractAssistantText(raw);
    const parsed = this.safeJsonParse(text);

    const check: LinkedinSessionCheck = {
      ok: true,
      isLoggedIn: Boolean(parsed?.isLoggedIn),
      confidence:
        typeof parsed?.confidence === 'number' ? parsed.confidence : undefined,
      signals: Array.isArray(parsed?.signals) ? parsed.signals : undefined,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
      checkedAt: Date.now(),
      imageMimeType: mimeType,
    };

    if (this.strictMode() && !parsed) {
      check.ok = false;
      check.isLoggedIn = false;
      check.confidence = 0;
      check.signals = ['unparsable_model_output'];
      check.reason =
        'El modelo no devolvió JSON parseable para la validación de sesión';
    }

    this.lastCheck = check;

    this.logger.log(
      `LinkedIn session check -> logged=${check.isLoggedIn} ` +
        `conf=${check.confidence ?? '?'} ` +
        `signals=${(check.signals ?? []).join(',')}`,
    );

    return check;
  }

  async assertLoggedIn(force = false) {
    const check = await this.checkLoggedIn(force);
    if (!check.ok || !check.isLoggedIn) {
      throw new Error(check.reason ?? 'LinkedIn session not authenticated');
    }
    return check;
  }
}
