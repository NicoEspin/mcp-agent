import { Module } from "@nestjs/common";
import { LinkedinController } from "./linkedin.controller";
import { LinkedinService } from "./linkedin.service";
import { PlaywrightMcpModule } from "../mcp/playwright-mcp.module";

@Module({
  imports: [PlaywrightMcpModule],
  controllers: [LinkedinController],
  providers: [LinkedinService],
})
export class LinkedinModule {}
