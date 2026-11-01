import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { VisualAuthoringService } from './service';
import { SpatialPlannerService } from './spatial-planner';
@Controller('api/v1/visual-authoring')
export class VisualAuthoringController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(VisualAuthoringService) private visuals: VisualAuthoringService,
    @Inject(SpatialPlannerService) private planner: SpatialPlannerService,
  ) {}
  @Get('config') async config(@Req() req: Request) {
    await this.auth.require(req);
    return this.visuals.configuration();
  }
  @Get('projects') async list(@Req() req: Request) {
    return this.visuals.list((await this.auth.require(req)).id);
  }
  @Post('projects') async create(@Req() req: Request, @Body() body: unknown) {
    return this.visuals.create((await this.auth.require(req)).id, body);
  }
  @Get('projects/:id') async get(@Req() req: Request, @Param('id') id: string) {
    return this.visuals.get((await this.auth.require(req)).id, id);
  }
  @Get('projects/:id/spatial-plan') async spatialState(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.planner.state((await this.auth.require(req)).id, id);
  }
  @Post('projects/:id/spatial-plan/quote') async spatialQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.planner.quote((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/spatial-plan/dispatch') async spatialDispatch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.planner.dispatch((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/spatial-plan/apply') async spatialApply(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.planner.apply((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/spatial-plan/jobs/:jobId/cancel') async spatialCancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ) {
    return this.planner.cancel((await this.auth.require(req)).id, id, jobId, body);
  }
  @Get('projects/:id/generation') async generation(@Req() req: Request, @Param('id') id: string) {
    return this.visuals.generation((await this.auth.require(req)).id, id);
  }
  @Post('projects/:id/generation/quote') async quote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.quoteGeneration((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/generation/dispatch') async dispatch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.dispatchGeneration((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/generation/reuse') async reuse(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.reuseGeneration((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/approve') async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.approve((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/complete') async complete(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.complete((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/cancel') async cancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const owner = (await this.auth.require(req)).id;
    const result = await this.visuals.cancel(owner, id, body);
    await this.planner.cancelPendingForProject(owner, id);
    return result;
  }
  @Post('projects/:id/layers') async edit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.edit((await this.auth.require(req)).id, id, body);
  }
  @Post('projects/:id/preview') async preview(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.preview((await this.auth.require(req)).id, id, body);
  }
  @Get('packages') async packages(@Req() req: Request) {
    return this.visuals.packages((await this.auth.require(req)).id);
  }
  @Post('packages/:id/equip') async equip(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.equip((await this.auth.require(req)).id, id, body);
  }
  @Post('packages/:id/apply') async apply(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.visuals.apply((await this.auth.require(req)).id, id, body);
  }
  @Get('stories/:id/source') async source(@Req() req: Request, @Param('id') id: string) {
    return this.visuals.sourceHash((await this.auth.require(req)).id, id);
  }
}
