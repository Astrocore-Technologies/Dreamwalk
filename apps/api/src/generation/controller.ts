import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { ImageGenerationService } from '../image-generation/service';
import { GenerationAuthority } from './service';
@Controller(['api/v1/generation', 'api/v1/live-test'])
export class GenerationController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(GenerationAuthority) private live: GenerationAuthority,
    @Inject(ImageGenerationService) private images: ImageGenerationService,
  ) {}
  @Post('bounded-authoring-tests') async createBounded(@Req() req: Request, @Body() body: unknown) {
    return this.live.createBoundedAuthoringTest((await this.auth.require(req)).id, body);
  }
  @Get('bounded-authoring-tests/:id') async boundedStatus(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.live.boundedAuthoringStatus((await this.auth.require(req)).id, id);
  }
  @Get('status') async status(@Req() req: Request) {
    return this.effectiveStatus((await this.auth.require(req)).id);
  }
  @Get('policy') async policy(@Req() req: Request) {
    return this.live.reviewPolicy((await this.auth.require(req)).id);
  }
  @Get('policy/operations/:operationId') async policyOperation(
    @Req() req: Request,
    @Param('operationId') operationId: string,
  ) {
    return this.live.policyOperation((await this.auth.require(req)).id, operationId);
  }
  @Post('policy/revisions') async amendPolicy(@Req() req: Request, @Body() body: unknown) {
    return this.live.amendPolicy((await this.auth.require(req)).id, body);
  }
  @Post('claim') async claim(@Req() req: Request, @Body() body: unknown) {
    const userId = (await this.auth.require(req)).id;
    await this.live.claim(userId, body);
    return this.effectiveStatus(userId);
  }
  private async effectiveStatus(userId: string) {
    const status = await this.live.status(userId);
    const image = this.images.configuration();
    const reserve = 'reserveMicros' in image ? image.reserveMicros : image.verifiedUpperMicros;
    const imageOnly = 'imageOnlyAdmission' in status && status.imageOnlyAdmission === true;
    const grantActive = status.enabled && (status.state === 'active' || imageOnly);
    const imageRemaining =
      status.mode === 'owner' ? status.imageRemainingMicros : status.remainingMicros;
    const perRequest =
      status.mode === 'owner' &&
      'requestEstimationEnabled' in image &&
      image.requestEstimationEnabled === true;
    // Capability permits a quote; the concrete quoted reserve is checked under the shared ledger lock.
    const sufficient = perRequest
      ? imageRemaining > 0
      : typeof reserve === 'number' && imageRemaining >= reserve;
    const retained =
      imageOnly && 'retainedImageHoldMicros' in status ? Number(status.retainedImageHoldMicros) : 0;
    const busy = status.heldMicros - retained > 0;
    const blocked = !image.externalEnabled
      ? (image.externalBlockReasons[0] ?? 'EXTERNAL_PROVIDER_DISABLED')
      : !grantActive
        ? (status.stopCode ?? 'MANUAL_LIVE_SESSION_REQUIRED')
        : busy
          ? 'GENERATION_OUTSTANDING_REQUEST'
          : !sufficient
            ? 'GENERATION_BUDGET_EXCEEDED'
            : null;
    return {
      ...status,
      imagesEnabled: grantActive && sufficient && image.externalEnabled && !busy,
      imageBlockCode: blocked ?? image.externalBlockReasons[0] ?? null,
      imageConfiguration: {
        externalEnabled: image.externalEnabled,
        ...('requestEstimationEnabled' in image
          ? { requestEstimationEnabled: image.requestEstimationEnabled }
          : {}),
        ...('pricingProfileId' in image
          ? {
              pricingProfileId: image.pricingProfileId,
              pricingProfileHash: image.pricingProfileHash,
            }
          : {}),
        ...('generationMode' in image && image.generationMode === 'owner' && status.mode === 'owner'
          ? {
              generationMode: 'owner' as const,
              ownerEstimateEnabled:
                'ownerEstimateEnabled' in image && image.ownerEstimateEnabled === true,
              estimateRiskConsentRequired:
                'estimateRiskConsentRequired' in image &&
                image.estimateRiskConsentRequired === true,
            }
          : {}),
        externalBlockReasons: image.externalBlockReasons,
        costBasis: 'costBasis' in image ? image.costBasis : 'unverified',
        estimatedTotalMicros:
          'estimatedTotalMicros' in image ? (image.estimatedTotalMicros ?? null) : null,
        reserveMicros: reserve ?? null,
        verifiedUpperMicros: image.verifiedUpperMicros,
        requestProfile: 'requestProfile' in image ? image.requestProfile : null,
        providerEnforcesQuotedCap: false,
      },
    };
  }
  @Get('campaigns/:id/requests') async pending(@Req() req: Request, @Param('id') id: string) {
    return this.live.pending((await this.auth.require(req)).id, id);
  }
  @Get('text-counts/operations/:operationId') async countOperation(
    @Req() req: Request,
    @Param('operationId') operationId: string,
  ) {
    return this.live.countOperation((await this.auth.require(req)).id, operationId);
  }
  @Post('campaigns/:id/requests/:requestId/preflight') async preflight(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    return this.live.preflightCount((await this.auth.require(req)).id, id, requestId, body);
  }
  @Post('campaigns/:id/requests/:requestId/consent') async consent(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    return this.live.consent((await this.auth.require(req)).id, id, requestId, body);
  }
}
