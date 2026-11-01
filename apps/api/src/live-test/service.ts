import { Inject, Injectable, Optional } from '@nestjs/common';
import { Db } from '../db';
import { GenerationAuthority } from '../generation/service';
import { readLiveTestConfig, type LiveTestConfig } from './config';
/** Compatibility adapter; all rights and financial accounting live in the generic authority. */
@Injectable()
export class LiveTestService extends GenerationAuthority {
  constructor(@Inject(Db) db: Db, @Optional() @Inject('LIVE_TEST_CONFIG') config?: LiveTestConfig) {
    super(db, config ?? readLiveTestConfig());
  }
}
