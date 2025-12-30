// src/linkedin/dto/read-chat.dto.ts
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class ReadChatDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsUrl()
  profileUrl!: string;

    // ✅ NEW
  @IsOptional()
  @IsUUID('4')
  taskId?: string;


  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // opcional futuro
  @IsOptional()
  @IsString()
  threadHint?: string;
}
