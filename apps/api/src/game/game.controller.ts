import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Req,
  Query,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GameService } from './game.service';
import { KnownNpcSettlement } from './known-npc-settlement';
@Controller('api/v1/game')
export class GameController {
  constructor(
    @Inject(GameService) private game: GameService,
    @Inject(KnownNpcSettlement) private knownNpcSettlement: KnownNpcSettlement,
  ) {}
  @Get('campaigns/:id/ai/jobs/:jobId/settlement')
  @Header('Cache-Control', 'no-store')
  npcSettlementQuote(@Req() req: Request, @Param('id') id: string, @Param('jobId') jobId: string) {
    return this.knownNpcSettlement.handle(req, id, jobId);
  }
  @Post('campaigns/:id/ai/jobs/:jobId/settlement')
  @Header('Cache-Control', 'no-store')
  npcSettlementConsent(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ) {
    return this.knownNpcSettlement.handle(req, id, jobId, body ?? {});
  }
  @Get('directors') directors() {
    return this.game.directors();
  }
  @Get('campaigns/:id/director') director(@Req() req: Request, @Param('id') id: string) {
    return this.game.director(req, id);
  }
  @Post('campaigns/:id/director') selectDirector(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.director(req, id, body);
  }
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
  @Get('campaigns/:id/narrative-preferences') narrativePreferences(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.game.narrativePreferences(req, id);
  }
  @Post('campaigns/:id/narrative-preferences') updateNarrativePreferences(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.narrativePreferences(req, id, body);
  }
  @Get('campaigns/:id/turns/feed') storyFeed(@Req() req: Request, @Param('id') id: string) {
    return this.game.storyFeed(req, id);
  }
  @Post('campaigns/:id/turns/quote') storyQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.withRuntimeVisionQuote(() => this.game.storyQuote(req, id, body));
  }
  @Get('campaigns/:id/world-generation') worldGenerationStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('speechReceiptBefore') speechReceiptBefore?: string,
  ) {
    return this.game.worldGenerationStatus(req, id, speechReceiptBefore);
  }
  @Post('campaigns/:id/world-generation/quote') worldGenerationQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.withRuntimeVisionQuote(() => this.game.worldGenerationQuote(req, id, body));
  }
  @Post('campaigns/:id/world-generation/consent') worldGenerationConsent(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.worldGenerationConsent(req, id, body);
  }
  @Post('campaigns/:id/world-generation/decline') worldGenerationDecline(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.worldGenerationDecline(req, id, body);
  }
  @Post('campaigns/:id/turns/:turnId/replies/quote') storyReplyQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Body() body: unknown,
  ) {
    return this.game.withRuntimeVisionQuote(() => this.game.storyReplyQuote(req, id, turnId, body));
  }
  @Post('campaigns/:id/turns/:turnId/replies/consent') storyReplyConsent(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Body() body: unknown,
  ) {
    return this.game.storyReplyConsent(req, id, turnId, body);
  }
  @Post('campaigns/:id/turns') storySubmit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.storySubmit(req, id, body);
  }
  @Post('campaigns/:id/turns/:turnId/confirm') storyConfirm(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Body() body: unknown,
  ) {
    return this.game.storyConfirm(req, id, turnId, body);
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
    return this.game.withRuntimeVisionQuote(() => this.game.aiDecision(req, id, body, true));
  }
  @Post('campaigns/:id/ai/jobs') aiQueue(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.game.aiDecision(req, id, body);
  }
  @Get('campaigns/:id/npcs/:npcId/inner-thought')
  @Header('Cache-Control', 'no-store')
  npcInnerThought(@Req() req: Request, @Param('id') id: string, @Param('npcId') npcId: string) {
    return this.game.npcInnerThought(req, id, npcId);
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
    return this.game.withRuntimeVisionQuote(() => this.game.narrative(req, id, body, true));
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
  @Get('campaigns') list(@Req() req: Request, @Query('adventureId') adventureId?: unknown) {
    return this.game.list(req, adventureId);
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
