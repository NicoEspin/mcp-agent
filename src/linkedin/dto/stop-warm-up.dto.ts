import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class StopWarmUpDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  // Si lo tenés, es lo más preciso.
  @IsOptional()
  @IsString()
  @MinLength(6)
  watcherId?: string;

  // Acepta EITHER linkedinUrl OR profileUrl
  @ValidateIf((o) => !o.profileUrl)
  @IsOptional()
  @IsUrl()
  linkedinUrl?: string;

  @ValidateIf((o) => !o.linkedinUrl)
  @IsOptional()
  @IsUrl()
  profileUrl?: string;

  // Si mandás solo sessionId, por defecto se detienen TODOS los warmups de esa sesión.
  @IsOptional()
  @IsBoolean()
  stopAllForSession?: boolean;
}
