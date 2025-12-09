// src/linkedin/dto/check-connection.dto.ts
import { IsString, IsUrl } from 'class-validator';

export class CheckConnectionDto {
  @IsString()
  @IsUrl()
  profileUrl: string;
}
