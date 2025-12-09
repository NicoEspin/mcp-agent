// src/linkedin/session/require-linkedin-session.decorator.ts
import { applyDecorators, UseGuards } from "@nestjs/common";
import { LinkedinSessionGuard } from "./linkedin-session.guard";

export const RequireLinkedinSession = () =>
  applyDecorators(UseGuards(LinkedinSessionGuard));
