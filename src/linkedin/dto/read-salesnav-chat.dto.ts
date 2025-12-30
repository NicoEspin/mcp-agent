import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ReadSalesNavChatDto {
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsString()
  profileUrl!: string;

  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  threadHint?: string;
}
