// src/linkedin/linkedin.controller.ts
import { Body, Controller, Post } from "@nestjs/common";
import { LinkedinService } from "./linkedin.service";
import { PlaywrightMcpService } from "../mcp/playwright-mcp.service";
import { SendMessageDto } from "./dto/send-message.dto";

@Controller("linkedin")
export class LinkedinController {
  constructor(
    private readonly linkedin: LinkedinService,
    private readonly mcp: PlaywrightMcpService
  ) {}

  @Post("send-message")
  async sendMessage(@Body() dto: SendMessageDto) {
    return this.linkedin.sendMessage(dto.profileUrl, dto.message);
  }

  @Post("open")
  async open() {
    // Esto forzará la apertura de Chromium si está en modo headed
    return this.mcp.callTool("browser_navigate", {
      url: "https://www.linkedin.com/",
    });
  }
}
