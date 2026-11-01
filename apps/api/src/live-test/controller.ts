import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Auth } from '../auth';
import { ImageGenerationService } from '../image-generation/service';
import { LiveTestService } from './service';
@Controller('api/v1/live-test')
export class LiveTestController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(LiveTestService) private live: LiveTestService,
    @Inject(ImageGenerationService) private images: ImageGenerationService,
  ) {}
  @Get('status') async status(@Req() req: Request) {
    return this.effectiveStatus((await this.auth.require(req)).id);
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
    const grantActive = status.enabled && status.state === 'active';
    const sufficient = typeof reserve === 'number' && status.remainingMicros >= reserve;
    const busy = status.heldMicros > 0;
    const blocked = !image.externalEnabled
      ? (image.externalBlockReasons[0] ?? 'EXTERNAL_PROVIDER_DISABLED')
      : busy
        ? 'GENERATION_OUTSTANDING_REQUEST'
        : !grantActive
          ? (status.stopCode ?? 'MANUAL_LIVE_SESSION_REQUIRED')
          : !sufficient
            ? 'GENERATION_BUDGET_EXCEEDED'
            : null;
    return {
      ...status,
      imagesEnabled: grantActive && sufficient && image.externalEnabled && !busy,
      imageBlockCode: blocked ?? image.externalBlockReasons[0] ?? null,
      imageConfiguration: {
        externalEnabled: image.externalEnabled,
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
  @Post('campaigns/:id/requests/:requestId/consent') async consent(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    return this.live.consent((await this.auth.require(req)).id, id, requestId, body);
  }
}
