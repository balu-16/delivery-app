import type { Redis } from 'ioredis';
import { HttpException } from '@nestjs/common';
import { checkRateLimit } from '../../../common/http/rate-limit.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CouponAttemptLimiter } from '../contracts/coupons.js';
/**
 * Per-user coupon validation attempts share the fixed-window Redis primitive
 * used by PLATFORM_RATE_LIMITER. Like that limiter it fails open with a warning
 * when Redis is unavailable; exceeding the limit surfaces HTTP 429 via the
 * existing problem-filter path.
 */
export class RedisCouponAttemptLimiter implements CouponAttemptLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly config: AppConfig,
    private readonly onUnavailable: () => void = () => {
      process.stderr.write('{"level":"warn","msg":"Coupon attempt limiter unavailable"}\n');
    },
  ) {}
  async check(userId: string): Promise<void> {
    const limit = await this.config.get('couponValidationAttemptsPerWindow');
    try {
      const result = await checkRateLimit(this.redis, userId, 'coupon-validate', limit);
      if (!result.allowed) throw new HttpException('Too Many Requests', 429);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      this.onUnavailable();
    }
  }
}
