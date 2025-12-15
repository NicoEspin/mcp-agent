// src/linkedin/services/linkedin-action-verifier.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { StreamService } from '../../stream/stream.service';

type SessionId = string;

export type LinkedinActionName =
  | 'open'
  | 'send_message'
  | 'send_connection'
  | 'read_chat';

export type LinkedinActionVerification = {
  ok: boolean;
  action: LinkedinActionName;
  sessionId: string;

  completed: boolean;
  confidence: number; // 0..1
  details: string;
  signals: string[];

  is_human_required: boolean;
  human_reason: string | null;

  screenshots: {
    count: number;
    capturedAt: number[];
    mimeTypes: string[];
    totalBase64Chars: number;
  };

  model: string;
  usage?: any;
  rawModelText?: string;
};

@Injectable()
export class LinkedinActionVerifierService {
  private readonly logger = new Logger(LinkedinActionVerifierService.name);
  private readonly openai: OpenAI;

  constructor(
    private readonly config: ConfigService,
    private readonly stream: StreamService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
      baseURL: this.config.get<string>('OPENAI_BASE_URL') || undefined,
    });
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private safeJsonParse(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
  }

  private normalize(obj: any) {
    const completed = !!obj?.completed;

    const conf = Number(obj?.confidence);
    const confidence =
      Number.isFinite(conf) && conf >= 0 && conf <= 1
        ? conf
        : completed
          ? 0.75
          : 0.35;

    const is_human_required = !!obj?.is_human_required;

    const human_reason =
      typeof obj?.human_reason === 'string' ? obj.human_reason : null;

    const details =
      typeof obj?.details === 'string'
        ? obj.details
        : completed
          ? 'Acción verificada como completada.'
          : 'No se pudo verificar como completada.';

    const signals = Array.isArray(obj?.signals)
      ? obj.signals.map((s: any) => String(s)).slice(0, 30)
      : [];

    return {
      completed,
      confidence,
      details,
      signals,
      is_human_required,
      human_reason,
    };
  }

  private buildPrompt(args: {
    action: LinkedinActionName;
    profileUrl?: string;
    message?: string;
    note?: string;
    actionResult?: any;
  }) {
    const { action, profileUrl, message, note } = args;

    // Contexto corto del result (no mandes cosas gigantes)
    const resultHint = args.actionResult
      ? `\n\nContexto adicional (resumen del resultado previo):\n${JSON.stringify(
          {
            ok:
              args.actionResult?.ok ?? args.actionResult?.success ?? undefined,
            error: args.actionResult?.error ?? undefined,
            note: args.actionResult?.note ?? undefined,
          },
        ).slice(0, 800)}`
      : '';

    const base = `
Vas a recibir 3 capturas consecutivas (ordenadas por tiempo) de una sesión de LinkedIn.
Objetivo: verificar si la acción "${action}" se completó exitosamente.

Respondé SOLO con JSON válido (sin markdown, sin texto extra) con este formato:
{
  "completed": boolean,
  "confidence": number,
  "details": string,
  "signals": string[],
  "is_human_required": boolean,
  "human_reason": string|null
}

Si ves login requerido, captcha, verificación, bloqueo, error visible, o un modal que requiere interacción humana:
- is_human_required=true
- completed=false (salvo que la acción sea "open" y LinkedIn haya cargado el login correctamente)
`.trim();

    const perAction =
      action === 'open'
        ? `
Criterio "open":
- completed=true si LinkedIn cargó (feed/home o pantalla de login de LinkedIn).
- Si aparece login/captcha: is_human_required=true (solo si el objetivo posterior requiere estar logueado).
`.trim()
        : action === 'send_connection'
          ? `
Criterio "send_connection":
- completed=true si aparece "Pendiente", "Invitación enviada", "Invited", "Pending", o cambia el CTA indicando solicitud enviada.
- completed=false si sigue disponible "Conectar" sin señales de envío.
Perfil: ${profileUrl ?? 'N/A'}
Nota (preview): ${(note ?? '').slice(0, 180)}
`.trim()
          : action === 'send_message'
            ? `
Criterio "send_message":
- completed=true si se ve chat/overlay y el mensaje aparece como enviado (ideal: coincide parcial con el texto).
- completed=false si no aparece el mensaje, hay error o la UI no cambió.
Perfil: ${profileUrl ?? 'N/A'}
Mensaje esperado (preview): ${(message ?? '').slice(0, 220)}
`.trim()
            : `
Criterio "read_chat":
- completed=true si se ve conversación abierta o lista de mensajes visible.
- completed=false si no hay conversación / hay error / no se abre el overlay.
Perfil: ${profileUrl ?? 'N/A'}
`.trim();

    return `${base}\n\n${perAction}${resultHint}`;
  }

  private async captureBurst(sessionId: SessionId) {
    const shots: { base64: string; mimeType: string; ts: number }[] = [];
    const start = Date.now();

    // 3 capturas en ~4s: t=0, t=2s, t=4s
    for (const offset of [0, 2000, 2000]) {
      if (offset) await this.sleep(offset);

      const ts = Date.now();
      const { data, mimeType } =
        await this.stream.forceScreenshotBase64(sessionId);
      shots.push({ base64: data, mimeType: mimeType ?? 'image/jpeg', ts });

      this.logger.debug(
        `burst screenshot session=${sessionId} at +${ts - start}ms mime=${mimeType} size=${data?.length ?? 0}`,
      );
    }

    return shots;
  }

  async verifyAfterAction(args: {
    sessionId: SessionId;
    action: LinkedinActionName;
    profileUrl?: string;
    message?: string;
    note?: string;
    actionResult?: any;
  }): Promise<LinkedinActionVerification> {
    const model = 'gpt-5-nano';
    const apiKey = this.config.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      return {
        ok: false,
        action: args.action,
        sessionId: args.sessionId,
        completed: false,
        confidence: 0,
        details: 'OPENAI_API_KEY no configurada',
        signals: ['missing_openai_key'],
        is_human_required: false,
        human_reason: null,
        screenshots: {
          count: 0,
          capturedAt: [],
          mimeTypes: [],
          totalBase64Chars: 0,
        },
        model,
      };
    }

    try {
      const shots = await this.captureBurst(args.sessionId);

      const prompt = this.buildPrompt(args);

      const content: any[] = [{ type: 'text', text: prompt }];
      for (const s of shots) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${s.mimeType};base64,${s.base64}` },
        });
      }

      const resp = await this.openai.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Sos un verificador estricto de UI. Respondés únicamente JSON válido con el formato solicitado.',
          },
          { role: 'user', content },
        ],
      });

      const rawText = resp?.choices?.[0]?.message?.content?.trim() ?? '';
      const parsed = this.safeJsonParse(rawText) ?? {};
      const norm = this.normalize(parsed);

      const totalChars = shots.reduce(
        (acc, s) => acc + (s.base64?.length ?? 0),
        0,
      );

      return {
        ok: true,
        action: args.action,
        sessionId: args.sessionId,

        completed: norm.completed,
        confidence: norm.confidence,
        details: norm.details,
        signals: norm.signals,

        is_human_required: norm.is_human_required,
        human_reason: norm.human_reason,

        screenshots: {
          count: shots.length,
          capturedAt: shots.map((s) => s.ts),
          mimeTypes: shots.map((s) => s.mimeType),
          totalBase64Chars: totalChars,
        },

        model,
        usage: resp?.usage,
        rawModelText: rawText,
      };
    } catch (e: any) {
      this.logger.warn(
        `verifyAfterAction failed action=${args.action} session=${args.sessionId}: ${e?.message ?? e}`,
      );

      return {
        ok: false,
        action: args.action,
        sessionId: args.sessionId,

        completed: false,
        confidence: 0,
        details: e?.message ?? 'Verification error',
        signals: ['verifier_error'],

        is_human_required: false,
        human_reason: null,

        screenshots: {
          count: 0,
          capturedAt: [],
          mimeTypes: [],
          totalBase64Chars: 0,
        },

        model,
      };
    }
  }
}
