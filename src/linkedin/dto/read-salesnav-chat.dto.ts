import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ReadSalesNavChatDto {
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsString()
  profileUrl!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  threadHint?: string;
}
