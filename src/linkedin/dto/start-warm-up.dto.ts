import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class StartWarmUpDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  // Acepta EITHER linkedinUrl OR profileUrl
  @ValidateIf((o) => !o.profileUrl)
  @IsUrl()
  linkedinUrl?: string;

  @ValidateIf((o) => !o.linkedinUrl)
  @IsUrl()
  profileUrl?: string;

  // texto base para comparar
  @IsOptional()
  @IsString()
  lastMessageStr?: string;

  // soporte typo (por si el cliente ya lo manda así)
  @IsOptional()
  @IsString()
  lastMessgeStr?: string;

  // opcional: para integrar con tu verifier como los demás endpoints
  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  // cada cuántos segundos checkea (default 60)
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  intervalSeconds?: number;

  // cuánto tiempo máximo esperar (default 30)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  maxMinutes?: number;

  // por defecto true para evitar fugas de tabs
  @IsOptional()
  @IsBoolean()
  closeOnFinish?: boolean;
}
