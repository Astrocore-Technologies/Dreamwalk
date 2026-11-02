import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { StoryBuildService } from './story-build.service';
@Controller('api/v1/story-builds')
export class StoryBuildController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(StoryBuildService) private service: StoryBuildService,
  ) {}
  @Post('adventures/:id/prepare') async prepare(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.service.prepare((await this.auth.require(r)).id, id, b);
  }
  @Get('adventures/:id/latest') async latest(@Req() r: Request, @Param('id') id: string) {
    return this.service.latest((await this.auth.require(r)).id, id);
  }
  @Get(':id') async state(@Req() r: Request, @Param('id') id: string) {
    return this.service.state((await this.auth.require(r)).id, id);
  }
  @Post(':id/quote') async quote(@Req() r: Request, @Param('id') id: string, @Body() b: unknown) {
    return this.service.quote((await this.auth.require(r)).id, id, b);
  }
  @Post(':id/dispatch') async dispatch(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.service.dispatch((await this.auth.require(r)).id, id, b);
  }
  @Post(':id/apply') async apply(@Req() r: Request, @Param('id') id: string, @Body() b: unknown) {
    return this.service.apply((await this.auth.require(r)).id, id, b);
  }
}
