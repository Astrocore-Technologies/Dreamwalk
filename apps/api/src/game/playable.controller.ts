import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PlayableService } from './playable.service';
@Controller('api/v1')
export class PlayableController {
  constructor(@Inject(PlayableService) private playable: PlayableService) {}
  @Post('admin/adventures/:id/npc-preview') reviewNpc(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.playable.reviewNpc(r, id, b);
  }
  @Get('admin/adventures/:id/playable-review')
  review(@Req() r: Request, @Param('id') id: string) {
    return this.playable.review(r, id);
  }
  @Get('studio/adventures/:id/playable-draft') draft(@Req() r: Request, @Param('id') id: string) {
    return this.playable.draft(r, id);
  }
  @Put('studio/adventures/:id/playable-draft') save(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.playable.save(r, id, b);
  }
  @Post('studio/adventures/:id/npc-preview')
  previewNpc(@Req() r: Request, @Param('id') id: string, @Body() b: unknown) {
    return this.playable.previewNpc(r, id, b);
  }
  @Post('studio/adventures/:id/playable-versions') compile(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.playable.compilePrivate(r, id, b);
  }
  @Get('studio/adventures/:id/playable-versions') versions(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.playable.versions(r, id, true);
  }
  @Get('game/adventures/:id/playable-versions') available(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.playable.versions(r, id);
  }
}
