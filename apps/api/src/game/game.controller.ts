import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GameService } from './game.service';
@Controller('api/v1/game')
export class GameController {
  constructor(@Inject(GameService) private game: GameService) {}
  @Get('campaigns/:id/intent-proposals') intents(@Req() req: Request, @Param('id') id: string) {
    return this.game.intents(req, id);
  }
  @Post('campaigns/:id/intent-proposals') proposeIntent(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.intents(req, id, body);
  }
  @Post('campaigns/:id/intent-proposals/:proposalId/confirm') confirmIntent(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ) {
    return this.game.confirmIntent(req, id, proposalId, body);
  }
  @Get('campaigns/:id/chat') chat(@Req() req: Request, @Param('id') id: string) {
    return this.game.chat(req, id);
  }
  @Post('campaigns/:id/chat') sendChat(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.chat(req, id, body);
  }
  @Get('campaigns/:id/ai/sponsors') sponsors(@Req() req: Request, @Param('id') id: string) {
    return this.game.sponsors(req, id);
  }
  @Post('campaigns/:id/ai/sponsors') grantSponsor(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.sponsors(req, id, body);
  }
  @Delete('campaigns/:id/ai/sponsors/:sponsorId') revokeSponsor(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('sponsorId') sponsorId: string,
  ) {
    return this.game.sponsors(req, id, undefined, sponsorId);
  }
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
  @Get('campaigns/:id/hero') hero(@Req() req: Request, @Param('id') id: string) {
    return this.game.selectedHero(req, id);
  }
  @Get('campaigns/:id/actors/:actorId/portrait') async portrait(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('actorId') actorId: string,
    @Res() res: Response,
  ) {
    const bytes = await this.game.heroPortrait(req, id, actorId);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }
  @Get('campaigns/:id/narrative') narrative(@Req() req: Request, @Param('id') id: string) {
    return this.game.narrative(req, id);
  }
  @Post('campaigns/:id/narrative') narrativeSubmit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.narrative(req, id, body);
  }
  @Post('campaigns/:id/narrative/quote') narrativeQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.narrative(req, id, body, true);
  }
  @Post('campaigns/:id/media-bindings') mediaBinding(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.mediaBinding(req, id, body);
  }
  @Post('campaigns/:id/media-preparation') mediaPreparation(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.mediaPreparation(req, id, body);
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
  @Post('campaigns/:id/accept') accept(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.accept(req, id, body);
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
