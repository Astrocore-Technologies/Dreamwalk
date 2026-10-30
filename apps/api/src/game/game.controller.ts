import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GameService } from './game.service';
@Controller('api/v1/game')
export class GameController {
  constructor(@Inject(GameService) private game: GameService) {}
  @Get('campaigns/:id/ai') aiStatus(@Req() req: Request, @Param('id') id: string) {
    return this.game.aiStatus(req, id);
  }
  @Post('campaigns/:id/ai/quote') aiQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.aiDecision(req, id, body, true);
  }
  @Post('campaigns/:id/ai/jobs') aiQueue(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.aiDecision(req, id, body);
  }
  @Get('campaigns') list(@Req() req: Request) {
    return this.game.list(req);
  }
  @Get('campaigns/:id/members')
  members(@Req() req: Request, @Param('id') id: string) {
    return this.game.members(req, id);
  }
  @Post('campaigns') create(@Req() req: Request, @Body() body: unknown) {
    return this.game.create(req, body);
  }
  @Get('campaigns/:id/snapshot') snapshot(@Req() req: Request, @Param('id') id: string) {
    return this.game.snapshot(req, id);
  }
  @Post('campaigns/:id/invitations') invite(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.invite(req, id, body);
  }
  @Post('campaigns/:id/accept') accept(@Req() req: Request, @Param('id') id: string) {
    return this.game.accept(req, id);
  }
  @Delete('campaigns/:id/members/:userId') revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.game.revoke(req, id, userId);
  }
  @Post('campaigns/:id/commands') command(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.command(req, id, body);
  }
  @Post('campaigns/:id/stop')
  stop(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.game.stop(req, id, body);
  }
  @Post('campaigns/:id/move') move(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.move(req, id, body);
  }
}
