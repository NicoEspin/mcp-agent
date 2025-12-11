// // src/linkedin/linkedin-agent.controller.ts
// import { Body, Controller, Post } from '@nestjs/common';
// import { LinkedinAgentService } from './linkedin-agent.service';

// @Controller('linkedin/agent')
// export class LinkedinAgentController {
//   constructor(private readonly agent: LinkedinAgentService) {}

//   @Post('read-chat')
//   readChat(@Body() dto: any) {
//     return this.agent.run('read_chat', dto);
//   }

//   @Post('send-message')
//   sendMessage(@Body() dto: any) {
//     return this.agent.run('send_message', dto);
//   }

//   @Post('send-connection')
//   sendConnection(@Body() dto: any) {
//     return this.agent.run('send_connection', dto);
//   }
// }
