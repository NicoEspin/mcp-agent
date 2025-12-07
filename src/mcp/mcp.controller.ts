import { Controller, Get } from "@nestjs/common";
import { PlaywrightMcpService } from "./playwright-mcp.service";

@Controller("mcp")
export class McpController {
  constructor(private readonly mcp: PlaywrightMcpService) {}

  @Get("tools")
  async listTools() {
    return this.mcp.listTools();
  }

  @Get("health")
  health() {
    return { ok: true };
  }
}
