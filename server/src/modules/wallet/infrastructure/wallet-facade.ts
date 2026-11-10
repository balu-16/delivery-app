import type { TransactionContext } from '../../../platform/database/database.js';
import type { SpendOptions, SpendResult, WalletSpender } from '../contracts/wallet.js';
import { WalletCreditService } from './postgres-credits.js';
import { WalletReversalService } from './postgres-reversals.js';
import { WalletSpendService } from './postgres-spend.js';

/**
 * Single WalletSpender composition: spend (checkout), reverseSpend (reversals)
 * and credit/adjust (settlements and approvals) share the same account-lock
 * primitives so every movement serialises on the account row in one order.
 */
export class WalletService implements WalletSpender {
  constructor(
    private readonly spendService: WalletSpendService,
    private readonly reversals: WalletReversalService,
    private readonly credits: WalletCreditService,
  ) {}
  spend(
    userId: string,
    reference: string,
    amountPaise: string,
    tx: TransactionContext,
    opts?: SpendOptions,
  ): Promise<SpendResult> {
    return this.spendService.spend(userId, reference, amountPaise, tx, opts);
  }
  reverseSpend(
    reference: string,
    tx?: TransactionContext,
    partial?: { amountPaise: string; reversalReference: string },
  ): Promise<boolean> {
    return this.reversals.reverseSpend(reference, tx, partial);
  }
  credit(input: Parameters<WalletSpender['credit']>[0]): Promise<boolean> {
    return this.credits.credit(input);
  }
  adjust(input: Parameters<WalletSpender['adjust']>[0]): Promise<void> {
    return this.credits.adjust(input);
  }
}
