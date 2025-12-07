// src/linkedin/linkedin.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { PlaywrightMcpService } from "../mcp/playwright-mcp.service";

@Injectable()
export class LinkedinService {
  private readonly logger = new Logger(LinkedinService.name);

  constructor(private readonly mcp: PlaywrightMcpService) {}

  private extractTools(resp: any): any[] {
    return (
      resp?.tools ??
      resp?.result?.tools ??
      resp?.data?.tools ??
      resp?.payload?.tools ??
      []
    );
  }

  private async hasTool(name: string) {
    const res = await this.mcp.listTools();
    const tools = this.extractTools(res);
    return tools.some((t: any) => t?.name === name);
  }

  async sendMessage(profileUrl: string, message: string) {
    // Forzamos que exista una página navegando al perfil
    const canRunCode = await this.hasTool("browser_run_code");

    if (!canRunCode) {
      return {
        ok: false,
        error:
          "Tu servidor MCP no expone browser_run_code. Actualizá @playwright/mcp y el SDK.",
      };
    }

    // Código Playwright ejecutado en el contexto del MCP
    // Nota: LinkedIn puede variar UI; esto es robusto razonable para un MVP.
    const code = `
      const profileUrl = ${JSON.stringify(profileUrl)};
      const text = ${JSON.stringify(message)};

      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      // Intentar click en botón Message/Mensaje
      const msgBtn = page.getByRole('button', { name: /message|mensaje/i }).first();
      if (await msgBtn.count()) {
        await msgBtn.click();
      } else {
        // Fallback: algunos perfiles tienen el botón dentro de "More/Más"
        const moreBtn = page.getByRole('button', { name: /more|más/i }).first();
        if (await moreBtn.count()) {
          await moreBtn.click();
          await page.waitForTimeout(400);
          const msgItem = page.getByRole('menuitem', { name: /message|mensaje/i }).first();
          if (await msgItem.count()) await msgItem.click();
        }
      }

      await page.waitForTimeout(800);

      // Buscar un textbox del panel de mensajes
      const box = page.getByRole('textbox').last();
      await box.click();
      // Usamos fill para reemplazar contenido
      await box.fill(text);

      // Enviar
      await page.keyboard.press('Enter');
    `;

    try {
      await this.mcp.callTool("browser_run_code", { code });

      return {
        ok: true,
        profileUrl,
        messagePreview: message.slice(0, 80),
        note:
          "Mensaje intentado vía browser_run_code usando el contexto compartido.",
      };
    } catch (e: any) {
      this.logger.warn(`sendMessage failed: ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? "Unknown error" };
    }
  }
}
