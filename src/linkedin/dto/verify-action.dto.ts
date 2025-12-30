// src/linkedin/dto/verify-action.dto.ts
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export type LinkedinActionName =
  | 'open'
  | 'send_message'
  | 'send_connection'
  | 'read_chat';

export class VerifyActionDto {
  @IsOptional()
  @IsString()
  sessionId?: string;
  taskId?: string;

  @IsString()
  @IsIn(['open', 'send_message', 'send_connection', 'read_chat'])
  action!: LinkedinActionName;

  @IsOptional()
  @IsString()
  profileUrl?: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsObject()
  actionResult?: any;
}
