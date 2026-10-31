import { Controller, Get, Post, Body, Param, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth } from '../auth';
import { ImageGenerationService } from './service';
@Controller('api/v1/image-generation')
export class ImageGenerationController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(ImageGenerationService) private images: ImageGenerationService,
  ) {}
  @Get('config') async configuration(@Req() req: Request) {
    await this.auth.require(req);
    return this.images.configuration();
  }
  @Post('quotes') async quote(@Req() req: Request, @Body() body: unknown) {
    return this.images.quote((await this.auth.require(req)).id, body);
  }
  @Post('jobs') async enqueue(@Req() req: Request, @Body() body: unknown) {
    return this.images.enqueue((await this.auth.require(req)).id, body);
  }
  @Get('jobs') async list(@Req() req: Request, @Query() query: unknown) {
    const q = z
      .object({ adventureId: z.uuid(), campaignId: z.uuid().optional() })
      .strict()
      .parse(query);
    return this.images.list((await this.auth.require(req)).id, q.adventureId, q.campaignId);
  }
  @Get('jobs/:id') async get(@Req() req: Request, @Param('id') id: string) {
    return this.images.get((await this.auth.require(req)).id, id);
  }
  @Post('jobs/:id/cancel') async cancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.images.cancel((await this.auth.require(req)).id, id, body);
  }
}
