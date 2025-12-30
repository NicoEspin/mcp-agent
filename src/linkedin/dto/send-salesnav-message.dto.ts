import { IsOptional, IsUUID } from 'class-validator';

// src/linkedin/dto/send-salesnav-message.dto.ts
export class SendSalesNavMessageDto {
  sessionId?: string;
  profileUrl!: string;
  message!: string;

  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  subject?: string;
}
