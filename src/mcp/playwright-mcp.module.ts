import { Module } from "@nestjs/common";
import { PlaywrightMcpService } from "./playwright-mcp.service";
import { McpController } from "./mcp.controller";

@Module({
  providers: [PlaywrightMcpService],
  controllers: [McpController],
  exports: [PlaywrightMcpService],
})
export class PlaywrightMcpModule {}
