import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

type SessionId = string;

@Injectable()
export class StorageStateService {
  private readonly logger = new Logger(StorageStateService.name);

  private readonly stateDir: string;
  private readonly saveInFlight = new Map<SessionId, Promise<boolean>>();
  private readonly lastSaveAt = new Map<SessionId, number>();

  constructor(private readonly config: ConfigService) {
    // ✅ path estable/absoluto (clave para no “perder” datos al reiniciar)
    const raw =
      this.config.get<string>('PLAYWRIGHT_STATE_DIR') ??
      path.join(process.cwd(), 'pw-state');

    this.stateDir = path.resolve(raw);
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  private safeId(sessionId: string) {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  getStatePath(sessionId: SessionId) {
    return path.join(this.stateDir, `${this.safeId(sessionId)}.storage.json`);
  }

  hasState(sessionId: SessionId) {
    return fs.existsSync(this.getStatePath(sessionId));
  }

  /**
   * Si el JSON está corrupto, lo mueve a .bad y devuelve false (no lo usa).
   */
  ensureValidStateFile(sessionId: SessionId): boolean {
    const p = this.getStatePath(sessionId);
    if (!fs.existsSync(p)) return false;

    try {
      const txt = fs.readFileSync(p, 'utf-8');
      JSON.parse(txt);
      return true;
    } catch (e) {
      const bad = `${p}.bad.${Date.now()}`;
      try {
        fs.renameSync(p, bad);
      } catch {}
      this.logger.warn(
        `storageState corrupto para ${sessionId}, movido a ${bad}`,
      );
      return false;
    }
  }

  async hasLiAtInStateFile(sessionId: SessionId): Promise<boolean> {
    const p = this.getStatePath(sessionId);
    if (!fs.existsSync(p)) return false;

    try {
      const txt = await fs.promises.readFile(p, 'utf-8');
      const state = JSON.parse(txt);
      const cookies: any[] = Array.isArray(state?.cookies) ? state.cookies : [];
      return cookies.some(
        (c) =>
          c?.name === 'li_at' &&
          String(c?.domain ?? '')
            .toLowerCase()
            .includes('linkedin.com'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Guarda storageState a disco.
   * - requireLiAt: si no existe li_at en el context, NO pisa el archivo.
   * - throttle: evita writes constantes.
   */
  async saveState(
    sessionId: SessionId,
    context: BrowserContext,
    opts?: {
      requireLiAt?: boolean;
      minIntervalMs?: number;
      includeIndexedDB?: boolean;
    },
  ): Promise<boolean> {
    const existing = this.saveInFlight.get(sessionId);
    if (existing) return existing;

    const task = (async () => {
      const minIntervalMs =
        opts?.minIntervalMs ??
        Number(
          this.config.get('PLAYWRIGHT_STATE_SAVE_MIN_INTERVAL_MS') ?? 1500,
        );

      const last = this.lastSaveAt.get(sessionId) ?? 0;
      if (Date.now() - last < minIntervalMs) return false;

      // Si pedimos li_at, validamos antes y evitamos “pisar estado bueno con malo”
      if (opts?.requireLiAt) {
        const allCookies = await context.cookies();
        const hasLiAt = allCookies.some(
          (c) =>
            c?.name === 'li_at' &&
            String(c?.domain ?? '')
              .toLowerCase()
              .includes('linkedin.com'),
        );
        if (!hasLiAt) return false;
      }

      this.lastSaveAt.set(sessionId, Date.now());

      const finalPath = this.getStatePath(sessionId);
      const tmpPath = `${finalPath}.tmp.${Date.now()}`;

      try {
        // ✅ obtenemos el objeto y escribimos nosotros (write atomic con rename)
        const includeIndexedDB =
          opts?.includeIndexedDB ??
          String(
            this.config.get('PLAYWRIGHT_STATE_INCLUDE_INDEXEDDB') ?? 'false',
          ) === 'true';

        const state = await (context as any).storageState({ includeIndexedDB });

        await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2));
        try {
          await fs.promises.rename(tmpPath, finalPath);
        } catch (e: any) {
          // fallback Windows: si el destino existe, borrarlo y renombrar
          if (
            e?.code === 'EEXIST' ||
            e?.code === 'EPERM' ||
            e?.code === 'EINVAL'
          ) {
            await fs.promises.unlink(finalPath).catch(() => {});
            await fs.promises.rename(tmpPath, finalPath);
          } else {
            throw e;
          }
        }

        this.logger.log(`💾 storageState guardado: ${sessionId}`);
        return true;
      } catch (e: any) {
        try {
          if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
        } catch {}
        this.logger.warn(
          `No pude guardar storageState (${sessionId}): ${e?.message ?? e}`,
        );
        return false;
      }
    })().finally(() => {
      this.saveInFlight.delete(sessionId);
    });

    this.saveInFlight.set(sessionId, task);
    return task;
  }

  async clearState(sessionId: SessionId) {
    const p = this.getStatePath(sessionId);
    if (fs.existsSync(p)) await fs.promises.unlink(p);
  }
}
