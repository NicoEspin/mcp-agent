// src/linkedin/dto/check-connection.dto.ts
import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class CheckConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsString()
  @IsUrl()
  profileUrl: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  taskId?: string;
}
