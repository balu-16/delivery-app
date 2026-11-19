import { jest } from '@jest/globals';
import { createReadTools } from '../../../src/modules/agent/infrastructure/read-tools.js';
import {
  addAgentCartItem,
  createWriteTools,
} from '../../../src/modules/agent/infrastructure/write-tools.js';
import { AgentToolKit } from '../../../src/modules/agent/infrastructure/tool-kit.js';
import {
  AgentCandidateStore,
  assertWriteCandidate,
  stableOperationHash,
} from '../../../src/modules/agent/infrastructure/product-candidates.js';
import {
  canonicalProductKey,
  catalogTextMatches,
  extractRequestedPhrases,
  isCartRequest,
  matchVariantSizes,
  phraseInText,
  resolveProducts,
  type ResolverItem,
} from '../../../src/modules/agent/infrastructure/product-resolver.js';

type TestTool = {
  invoke(
    input: Record<string, unknown>,
    runtime: { toolCallId: string; writer?: (event: unknown) => void },
  ): Promise<string>;
};

const BUTTERMILK = '20000000-0000-4000-8000-000000000001';
const BUTTERMILK_L = '20000000-0000-4000-8000-000000000002';
const BUTTER = '20000000-0000-4000-8000-000000000003';
const A2MILK = '20000000-0000-4000-8000-000000000004';

const item = (
  variantId: string,
  name: string,
  variantName: string,
  sellingPaise = '2500',
  availability = 'IN_STOCK',
): ResolverItem => ({
  productId: `product-${variantId.slice(-4)}`,
  variantId,
  name,
  variantName,
  sellingPaise,
  availability,
  maxPerOrder: 10,
});

describe('product resolver', () => {
  test.each(['butter milk', 'butter-milk', 'buttermilk', 'Butter Milk'])(
    'maps %p to the Buttermilk product',
    (spelling) => {
      expect(canonicalProductKey(spelling)).toBe('buttermilk');
    },
  );

  test('standalone butter stays Butter, never Buttermilk', () => {
    expect(canonicalProductKey('Butter')).toBe('butter');
    const resolution = resolveProducts('Add buttermilk please', [
      item(BUTTERMILK, 'Buttermilk', '500 ml'),
      item(BUTTER, 'Butter', '100 g'),
    ]);
    expect(resolution.requested).toEqual([{ key: 'buttermilk', phrase: 'buttermilk' }]);
    expect(resolution.exact.map((entry) => entry.variantId)).toEqual([BUTTERMILK]);
  });

  test('treats "buttermilk and butter" as two products', () => {
    const resolution = resolveProducts('Add buttermilk and butter', [
      item(BUTTERMILK, 'Buttermilk', '500 ml'),
      item(BUTTER, 'Butter', '100 g'),
      item(A2MILK, 'A2 Milk', '1 L'),
    ]);
    expect(resolution.requested.map((entry) => entry.key)).toEqual(['buttermilk', 'butter']);
    expect(resolution.exact.map((entry) => entry.variantId).sort()).toEqual(
      [BUTTERMILK, BUTTER].sort(),
    );
    expect(resolution.ambiguous).toBe(false);
  });

  test('longest phrase wins overlapping spans', () => {
    expect(
      extractRequestedPhrases('peanut butter please', ['Butter', 'Peanut Butter']).map(
        (entry) => entry.key,
      ),
    ).toEqual(['peanut butter']);
  });

  test('word boundaries reject partial words', () => {
    expect(phraseInText('butter', 'Butter, please')).toBe(true);
    expect(phraseInText('butter', 'butterscotch')).toBe(false);
    expect(phraseInText('butter', 'buttermilk')).toBe(false);
    expect(phraseInText('curd', 'curd rice')).toBe(true);
  });

  test('flags ambiguous sizes until the message names one', () => {
    const items = [
      item(BUTTERMILK, 'Buttermilk', '500 ml'),
      item(BUTTERMILK_L, 'Buttermilk', '1 L'),
    ];
    expect(resolveProducts('Add buttermilk', items).ambiguous).toBe(true);
    const sized = resolveProducts('Add Buttermilk 500 ml', items);
    expect(sized.ambiguous).toBe(false);
    expect(matchVariantSizes('Add Buttermilk 500 ml', items)).toEqual([BUTTERMILK]);
    expect(matchVariantSizes('Add Buttermilk 1L', items)).toEqual([BUTTERMILK_L]);
  });

  test('address-free preview finds Buttermilk for spaced and hyphenated queries', () => {
    expect(catalogTextMatches('butter milk', 'Buttermilk', '500 ml')).toBe(true);
    expect(catalogTextMatches('butter-milk', 'Buttermilk', '500 ml')).toBe(true);
    expect(catalogTextMatches('butter milk', 'Butter', '100 g')).toBe(false);
    expect(catalogTextMatches('butter', 'Butter', '100 g')).toBe(true);
  });

  test('an out-of-stock size does not force a size question', () => {
    const resolution = resolveProducts('Add buttermilk', [
      item(BUTTERMILK, 'Buttermilk', '500 ml'),
      item(BUTTERMILK_L, 'Buttermilk', '1 L', '4500', 'OUT_OF_STOCK'),
    ]);
    expect(resolution.ambiguous).toBe(false);
    expect(resolution.unavailable.map((entry) => entry.variantId)).toEqual([BUTTERMILK_L]);
  });

  test('detects cart requests without misclassifying discovery', () => {
    expect(isCartRequest('Add buttermilk to my cart')).toBe(true);
    expect(isCartRequest('I need 2 packets of milk')).toBe(true);
    expect(isCartRequest('Order them')).toBe(true);
    expect(isCartRequest('Show me curd options')).toBe(false);
    expect(isCartRequest('What paneer do you have?')).toBe(false);
  });
});

describe('stable operation key', () => {
  const base = { messageId: 'msg-1', variantId: BUTTERMILK, quantity: 1, mode: 'set' as const };
  test('repeats share one key; message, item, quantity or op change it', () => {
    expect(stableOperationHash(base)).toBe(stableOperationHash({ ...base }));
    expect(stableOperationHash({ ...base, messageId: 'msg-2' })).not.toBe(
      stableOperationHash(base),
    );
    expect(stableOperationHash({ ...base, variantId: BUTTER })).not.toBe(stableOperationHash(base));
    expect(stableOperationHash({ ...base, quantity: 2 })).not.toBe(stableOperationHash(base));
    expect(stableOperationHash({ ...base, mode: 'add' })).not.toBe(stableOperationHash(base));
  });
});

describe('candidate validation', () => {
  const candidates = [
    {
      productId: 'p1',
      variantId: BUTTERMILK,
      productKey: 'buttermilk',
      phrase: 'butter milk',
      name: 'Buttermilk',
      variantName: '500 ml',
      sellingPaise: '2500',
      availability: 'IN_STOCK',
      maxPerOrder: 2,
    },
  ];
  test('accepts the resolved variant and rejects the rest', () => {
    expect(assertWriteCandidate(candidates, { variantId: BUTTERMILK, quantity: 1 }).variantId).toBe(
      BUTTERMILK,
    );
    expect(() => assertWriteCandidate(candidates, { variantId: BUTTER, quantity: 1 })).toThrow(
      'ITEM_UNAVAILABLE',
    );
    expect(() => assertWriteCandidate(undefined, { variantId: BUTTERMILK, quantity: 1 })).toThrow(
      'ITEM_UNAVAILABLE',
    );
    expect(() =>
      assertWriteCandidate(candidates, {
        variantId: BUTTERMILK,
        quantity: 1,
        displayedUnitPricePaise: '9999',
      }),
    ).toThrow('PRICE_CHANGED');
    expect(() => assertWriteCandidate(candidates, { variantId: BUTTERMILK, quantity: 3 })).toThrow(
      'INVALID_QUANTITY',
    );
  });
});

const previewDeps = (overrides: Record<string, unknown> = {}) => ({
  addresses: { list: async () => [] },
  cart: { get: async () => null },
  appConfig: { get: async () => 10 },
  catalog: {
    preview: async () => ({
      items: [
        {
          productId: 'p-bm',
          variantId: BUTTERMILK,
          name: 'Buttermilk',
          variantName: '500 ml',
          sellingPaise: '2500',
        },
        {
          productId: 'p-bt',
          variantId: BUTTER,
          name: 'Butter',
          variantName: '100 g',
          sellingPaise: '6000',
        },
        {
          productId: 'p-a2',
          variantId: A2MILK,
          name: 'A2 Milk',
          variantName: '1 L',
          sellingPaise: '8000',
        },
      ],
    }),
  },
  ...overrides,
});

const searchTool = (
  deps: Record<string, unknown>,
  context: { userText?: string; clientMessageId?: string; candidates?: AgentCandidateStore },
) =>
  createReadTools(
    deps as never,
    { userId: 'user-1', locale: 'en', ...context },
    new AgentToolKit(10),
  ).find((entry) => entry.name === 'search_products')! as unknown as TestTool;

const writeTool = (
  deps: Record<string, unknown>,
  messageId: string,
  store: AgentCandidateStore,
  userText = 'Add butter milk',
) =>
  createWriteTools(
    deps as never,
    {
      userId: 'user-1',
      threadId: 'thread-1',
      maxQuantity: 10,
      userText,
      clientMessageId: messageId,
      candidates: store,
    },
    new AgentToolKit(10),
  ).find((entry) => entry.name === 'set_cart_item_qty')! as unknown as TestTool;

describe('assistant buttermilk regression', () => {
  test.each(['Add butter milk to my cart', 'Add butter-milk to my cart', 'Add buttermilk'])(
    'search resolves %p to Buttermilk only',
    async (userText) => {
      const store = new AgentCandidateStore();
      const outcome = JSON.parse(
        await searchTool(previewDeps(), {
          userText,
          clientMessageId: 'msg-1',
          candidates: store,
        }).invoke({ query: 'butter milk' }, { toolCallId: 'search-1' }),
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.data.exact.map((entry: { variantId: string }) => entry.variantId)).toEqual([
        BUTTERMILK,
      ]);
      expect(outcome.data.needsChoice).toBe(false);
      expect(store.get('user-1', 'msg-1')!.map((entry) => entry.variantId)).toEqual([BUTTERMILK]);
    },
  );

  test('sending Butter after a Buttermilk request performs zero writes', async () => {
    const store = new AgentCandidateStore();
    await searchTool(previewDeps(), {
      userText: 'Add butter milk to my cart',
      clientMessageId: 'msg-1',
      candidates: store,
    }).invoke({ query: 'butter milk' }, { toolCallId: 'search-1' });
    const transaction = jest.fn(() => ({ execute: jest.fn(async () => ({})) }));
    const putItem = jest.fn(async () => ({}));
    const outcome = JSON.parse(
      await writeTool({ db: { transaction }, cart: { putItem } }, 'msg-1', store).invoke(
        { variantId: BUTTER, quantity: 1, displayedUnitPricePaise: '6000' },
        { toolCallId: 'write-1' },
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe('ITEM_UNAVAILABLE');
    expect(transaction).not.toHaveBeenCalled();
    expect(putItem).not.toHaveBeenCalled();
  });

  test('the resolved Buttermilk variant passes validation', async () => {
    const store = new AgentCandidateStore();
    await searchTool(previewDeps(), {
      userText: 'Add butter milk to my cart',
      clientMessageId: 'msg-1',
      candidates: store,
    }).invoke({ query: 'butter milk' }, { toolCallId: 'search-1' });
    const execute = jest.fn(async () => ({ version: 2 }));
    const transaction = jest.fn(() => ({ execute }));
    const outcome = JSON.parse(
      await writeTool(
        { db: { transaction }, cart: {} },
        'msg-1',
        store,
        'Add 1 bottle of butter milk',
      ).invoke(
        { variantId: BUTTERMILK, quantity: 1, displayedUnitPricePaise: '2500' },
        { toolCallId: 'write-1' },
      ),
    );
    expect(outcome).toMatchObject({ ok: true, data: { version: 2 } });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('a recognized product still needs an explicit quantity for a model cart write', async () => {
    const store = new AgentCandidateStore();
    await searchTool(previewDeps(), {
      userText: 'Add butter milk',
      clientMessageId: 'msg-1',
      candidates: store,
    }).invoke({ query: 'butter milk' }, { toolCallId: 'search-1' });
    const transaction = jest.fn();
    const outcome = JSON.parse(
      await writeTool({ db: { transaction }, cart: {} }, 'msg-1', store).invoke(
        { variantId: BUTTERMILK, quantity: 1, displayedUnitPricePaise: '2500' },
        { toolCallId: 'write-1' },
      ),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'CART_CHOICE_REQUIRED' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  test('an explicit owned card tap keeps the card-action path without candidates', async () => {
    const execute = jest.fn(async () => ({ version: 2 }));
    const transaction = jest.fn(() => ({ execute }));
    await addAgentCartItem(
      { db: { transaction }, cart: {} } as never,
      { userId: 'user-1', threadId: 'thread-1', maxQuantity: 10 },
      { variantId: BUTTER, quantity: 1 },
      'card:card-1:action-1',
      { noteId: '30000000-0000-4000-8000-000000000001', displayedCardPrice: '6000' },
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('an unavailable exact match asks for a choice and blocks the write', async () => {
    const addressId = '40000000-0000-4000-8000-000000000001';
    const store = new AgentCandidateStore();
    const deps = {
      addresses: { list: async () => [{ id: addressId, isDefault: true }] },
      cart: { get: async () => null },
      appConfig: { get: async () => 10 },
      catalog: {
        list: async () => ({
          items: [
            {
              productId: 'p-bm',
              variantId: BUTTERMILK,
              name: 'Buttermilk',
              variantName: '500 ml',
              sellingPaise: '2500',
              availability: 'OUT_OF_STOCK',
              maxPerOrder: 10,
            },
            {
              productId: 'p-bt',
              variantId: BUTTER,
              name: 'Butter',
              variantName: '100 g',
              sellingPaise: '6000',
              availability: 'IN_STOCK',
              maxPerOrder: 10,
            },
          ],
        }),
      },
    };
    const search = JSON.parse(
      await searchTool(deps, {
        userText: 'Add butter milk',
        clientMessageId: 'msg-oos',
        candidates: store,
      }).invoke({ query: 'butter milk' }, { toolCallId: 'search-oos' }),
    );
    expect(search.ok).toBe(true);
    expect(search.data.needsChoice).toBe(true);
    expect(search.data.clarification).toMatch(/unavailable/i);
    const transaction = jest.fn(() => ({ execute: jest.fn(async () => ({})) }));
    const blocked = JSON.parse(
      await writeTool({ db: { transaction }, cart: {} }, 'msg-oos', store).invoke(
        { variantId: BUTTERMILK, quantity: 1, displayedUnitPricePaise: '2500' },
        { toolCallId: 'write-oos' },
      ),
    );
    expect(blocked.error.code).toBe('ITEM_UNAVAILABLE');
    expect(transaction).not.toHaveBeenCalled();
  });

  test('ambiguous sizes ask for a choice', async () => {
    const store = new AgentCandidateStore();
    const deps = previewDeps({
      catalog: {
        preview: async () => ({
          items: [
            {
              productId: 'p-bm',
              variantId: BUTTERMILK,
              name: 'Buttermilk',
              variantName: '500 ml',
              sellingPaise: '2500',
            },
            {
              productId: 'p-bm',
              variantId: BUTTERMILK_L,
              name: 'Buttermilk',
              variantName: '1 L',
              sellingPaise: '4500',
            },
          ],
        }),
      },
    });
    const search = JSON.parse(
      await searchTool(deps, {
        userText: 'Add buttermilk',
        clientMessageId: 'msg-size',
        candidates: store,
      }).invoke({ query: 'buttermilk' }, { toolCallId: 'search-size' }),
    );
    expect(search.ok).toBe(true);
    expect(search.data.needsChoice).toBe(true);
    expect(search.data.clarification).toMatch(/size/i);
  });
});
