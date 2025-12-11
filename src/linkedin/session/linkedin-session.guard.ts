// src/linkedin/session/linkedin-session.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { LinkedinSessionService } from './linkedin-session.service';

@Injectable()
export class LinkedinSessionGuard implements CanActivate {
  private readonly logger = new Logger(LinkedinSessionGuard.name);

  constructor(private readonly session: LinkedinSessionService) {}

  private resolveSessionId(req: any): string {
    const fromQuery = req?.query?.sessionId;
    const fromHeader = req?.headers?.['x-linkedin-session-id'];
    const fromBody = req?.body?.sessionId;

    const pick = (val: any) => {
      if (Array.isArray(val)) val = val[0];
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) return trimmed;
      }
      return null;
    };

    const candidate =
      pick(fromQuery) ?? pick(fromHeader) ?? pick(fromBody) ?? null;

    return candidate ?? 'default';
  }

  async canActivate(context: ExecutionContext) {
    const req: any = context.switchToHttp().getRequest();

    const force =
      req?.query?.forceSessionCheck === 'true' ||
      req?.query?.forceSessionCheck === '1' ||
      req?.headers?.['x-force-session-check'] === 'true' ||
      req?.headers?.['x-force-session-check'] === '1';

    const sessionId = this.resolveSessionId(req);
    req.linkedinSessionId = sessionId;

    try {
      const check = await this.session.checkLoggedIn(sessionId, force);

      // trazabilidad
      req.linkedinSessionCheck = check;

      this.logger.debug(
        `Session check [${sessionId}] => ok=${check.ok} logged=${check.isLoggedIn} conf=${check.confidence ?? '?'} reason=${check.reason ?? ''}`,
      );

      // ✅ Diferenciar "no pude validar" vs "validé y no está logueado"
      if (!check.ok) {
        throw new ServiceUnavailableException({
          ok: false,
          error: 'LinkedIn session validation unavailable',
          sessionId,
          detail: check,
        });
      }

      if (!check.isLoggedIn) {
        throw new UnauthorizedException({
          ok: false,
          error: 'LinkedIn session validation failed',
          sessionId,
          detail: check,
        });
      }

      return true;
    } catch (e: any) {
      if (e instanceof HttpException) {
        throw e;
      }

      throw new ServiceUnavailableException({
        ok: false,
        error: 'LinkedIn session validation error',
        message: e?.message ?? 'Unknown session error',
      });
    }
  }
}
