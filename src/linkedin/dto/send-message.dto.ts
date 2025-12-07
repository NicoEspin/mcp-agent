import { IsString, IsUrl, MinLength } from "class-validator";

export class SendMessageDto {
  @IsUrl()
  profileUrl!: string;

  @IsString()
  @MinLength(1)
  message!: string;
}
