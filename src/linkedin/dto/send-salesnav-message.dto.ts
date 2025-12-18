// src/linkedin/dto/send-salesnav-message.dto.ts
export class SendSalesNavMessageDto {
  sessionId?: string;
  profileUrl!: string;
  message!: string;

  subject?: string;
}
