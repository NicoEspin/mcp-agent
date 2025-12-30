// src/linkedin/dto/send-connection.dto.ts
import {
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SendConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsUrl()
  profileUrl: string;

  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  /**
   * Nota opcional para la invitación.
   * LinkedIn suele limitar a ~300 caracteres.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
