import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  @IsUrl()
  profileUrl!: string;

  // ✅ Legacy: se valida SOLO si no hay messages
  @ValidateIf((o) => !o.messages || o.messages.length === 0)
  @IsString()
  @MinLength(1)
  message?: string;

  // ✅ Nuevo: si viene, se valida siempre
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  messages?: string[];
}
