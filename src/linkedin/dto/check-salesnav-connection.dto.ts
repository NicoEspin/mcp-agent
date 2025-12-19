import { IsOptional, IsString, IsUrl } from 'class-validator';

export class CheckSalesNavConnectionDto {
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsUrl({ require_tld: false })
  profileUrl!: string;
}
