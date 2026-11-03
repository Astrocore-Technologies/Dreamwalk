import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { PaidStartService } from './paid-start.service';
@Controller('api/v1/game/start-preparations')
export class PaidStartController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(PaidStartService) private service: PaidStartService,
  ) {}
  @Post() async prepare(@Req() req: Request, @Body() body: unknown) {
    return this.service.prepare((await this.auth.require(req)).id, body);
  }
  @Get('by-operation/:operationId') async restore(
    @Req() req: Request,
    @Param('operationId') operationId: string,
  ) {
    return this.service.byOperation((await this.auth.require(req)).id, operationId);
  }
  @Get(':id') async state(@Req() req: Request, @Param('id') id: string) {
    return this.service.state((await this.auth.require(req)).id, id);
  }
  @Post(':id/quote') async quote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.quote((await this.auth.require(req)).id, id, body);
  }
  @Post(':id/dispatch') async dispatch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.dispatch((await this.auth.require(req)).id, id, body);
  }
}
