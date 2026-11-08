import type { Redis } from 'ioredis';
import type { LocationPointInput, Point, RiderGeo } from '../contracts/tracking.js';

// ElastiCache Serverless enforces Redis Cluster hash slots for scripts and MULTI.
const GEO_KEY = 'delivery:{rider-geo}:geo';
const riderKey = (riderId: string) => `delivery:{rider-geo}:rider:${riderId}`;
const erasedKey = (riderId: string) => `delivery:{rider-geo}:erased:${riderId}`;

/**
 * Redis GEO candidate index (D22): members are a prefilter only. A per-rider
 * hash with a TTL carries freshness; pruneExpired removes GEO members whose
 * hash has expired so the index never suggests a silent rider.
 */
export class RedisRiderGeo implements RiderGeo {
  constructor(private readonly redis: Redis) {}

  async candidatesNear(point: Point, radiusMetres: number, limit: number): Promise<string[]> {
    const result = (await this.redis.call(
      'GEOSEARCH',
      GEO_KEY,
      'FROMLONLAT',
      String(point.lng),
      String(point.lat),
      'BYRADIUS',
      String(Math.max(1, Math.trunc(radiusMetres))),
      'm',
      'COUNT',
      String(Math.max(1, Math.trunc(limit))),
      'ASC',
    )) as string[];
    const ids = result.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return [];
    const markers = await this.redis.pipeline(ids.map((id) => ['exists', riderKey(id)])).exec();
    return ids.filter((_, i) => markers?.[i]?.[1] === 1);
  }

  async updateMember(
    riderId: string,
    point: LocationPointInput,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
      local prior = redis.call('HGET', KEYS[2], 'at')
      if prior and tonumber(prior) >= tonumber(ARGV[4]) then return 0 end
      redis.call('GEOADD', KEYS[1], ARGV[1], ARGV[2], ARGV[3])
      redis.call('HSET', KEYS[2], 'at', ARGV[4])
      redis.call('EXPIRE', KEYS[2], ARGV[5])
      return 1
    `,
      3,
      GEO_KEY,
      riderKey(riderId),
      erasedKey(riderId),
      String(point.lng),
      String(point.lat),
      riderId,
      String(Date.parse(point.ts)),
      String(Math.max(1, Math.trunc(ttlSeconds))),
    );
    return result === 1;
  }

  async removeMember(riderId: string): Promise<void> {
    await this.redis
      .multi()
      .set(erasedKey(riderId), '1')
      .del(riderKey(riderId))
      .zrem(GEO_KEY, riderId)
      .exec();
  }

  async refreshTtl(riderId: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(riderKey(riderId), Math.max(1, Math.trunc(ttlSeconds)));
  }

  /** Best-effort prune of members whose freshness hash expired (ADD-17). */
  async pruneExpired(sample = 200): Promise<number> {
    const members = (await this.redis.call(
      'ZRANDMEMBER',
      GEO_KEY,
      String(sample),
      'WITHSCORES',
    )) as string[] | null;
    if (!members || members.length === 0) return 0;
    const ids: string[] = [];
    for (let i = 0; i < members.length; i += 2) ids.push(members[i]!);
    let pruned = 0;
    for (const riderId of ids) {
      const removed = await this.redis.eval(
        `if redis.call('EXISTS', KEYS[2]) == 0 then return redis.call('ZREM', KEYS[1], ARGV[1]) end return 0`,
        2,
        GEO_KEY,
        riderKey(riderId),
        riderId,
      );
      pruned += Number(removed);
    }
    return pruned;
  }
}
