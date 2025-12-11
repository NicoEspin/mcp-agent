// src/linkedin/dto/send-message.dto.ts
import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsUrl()
  profileUrl!: string;

  @IsString()
  @MinLength(1)
  message!: string;
}
