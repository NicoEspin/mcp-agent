// src/linkedin/dto/send-connection.dto.ts
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class SendConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsUrl()
  profileUrl: string;

  /**
   * Nota opcional para la invitación.
   * LinkedIn suele limitar a ~300 caracteres.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
