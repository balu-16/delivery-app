export type RatingTarget = 'ORDER' | 'RIDER' | 'PRODUCT';
export const RATINGS = Symbol('RATINGS');
export interface Ratings {
  create(
    userId: string,
    orderId: string,
    input: { targetType: RatingTarget; targetId: string; stars: number; comment?: string },
  ): Promise<string>;
  edit(
    userId: string,
    orderId: string,
    ratingId: string,
    input: { stars: number; comment?: string },
  ): Promise<void>;
  moderate(actorId: string, ratingId: string, hidden: boolean, reason: string): Promise<void>;
  aggregate(
    targetType: RatingTarget,
    targetId: string,
  ): Promise<{ count: number; average: number } | null>;
}
