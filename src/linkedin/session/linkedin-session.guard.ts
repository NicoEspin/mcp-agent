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

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();

    const force =
      req?.query?.forceSessionCheck === 'true' ||
      req?.query?.forceSessionCheck === '1' ||
      req?.headers?.['x-force-session-check'] === 'true' ||
      req?.headers?.['x-force-session-check'] === '1';

    try {
      const check = await this.session.checkLoggedIn(force);

      // trazabilidad
      req.linkedinSessionCheck = check;

      this.logger.debug(
        `Session check => ok=${check.ok} logged=${check.isLoggedIn} conf=${check.confidence ?? '?'} reason=${check.reason ?? ''}`,
      );

      // ✅ Diferenciar "no pude validar" vs "validé y no está logueado"
      if (!check.ok) {
        throw new ServiceUnavailableException({
          ok: false,
          error: 'LinkedIn session validation unavailable',
          detail: check,
        });
      }

      if (!check.isLoggedIn) {
        throw new UnauthorizedException({
          ok: false,
          error: 'LinkedIn session validation failed',
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
