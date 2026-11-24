import type { Client } from 'pg';

/**
 * Subscription seeding is retired (plan3 section 7). No new recurring plans
 * or slots are created; existing rows and archive data are left untouched.
 * Historical orders keep their order-source values and lifecycle.
 */
export async function seedSubscriptions(
  _client: Client,
  _storeIds: readonly string[],
): Promise<void> {
  void _client;
  void _storeIds;
}
