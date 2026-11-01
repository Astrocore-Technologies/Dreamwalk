import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { StoryNpcService } from './npcs';
import { PrivateReleaseService } from './private-release';
@Controller('api/v1/studio/adventures/:id')
export class StoryAuthoringController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(StoryNpcService) private npcs: StoryNpcService,
    @Inject(PrivateReleaseService) private release: PrivateReleaseService,
  ) {}
  @Get('npcs') async list(@Req() r: Request, @Param('id') id: string) {
    return this.npcs.list((await this.auth.require(r)).id, id);
  }
  @Post('npcs') async create(@Req() r: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.npcs.create((await this.auth.require(r)).id, id, body);
  }
  @Post('npcs/import') async importTemplate(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.npcs.importTemplate((await this.auth.require(r)).id, id, body);
  }
  @Patch('npcs/:npcId') async update(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('npcId') npcId: string,
    @Body() body: unknown,
  ) {
    return this.npcs.update((await this.auth.require(r)).id, id, npcId, body);
  }
  @Post('npcs/:npcId/template') async template(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('npcId') npcId: string,
    @Body() body: unknown,
  ) {
    return this.npcs.saveAsTemplate((await this.auth.require(r)).id, id, npcId, body);
  }
  @Post('private-release') async publish(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.release.publish((await this.auth.require(r)).id, id, body);
  }
}
