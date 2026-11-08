import { withinWeightTolerance } from '../../../src/modules/picking/domain/policy.js';
test.each([
  [1000n, 990n, 100, true],
  [1000n, 989n, 100, false],
  [1000n, 1000n, 0, true],
  [1000n, 1001n, 100, false],
  [1000n, 999n, 0, false],
  [0n, 0n, 100, false],
  [1000n, 999n, 10001, false],
  [10000000000000000n, 9999999999999999n, 1, true],
])('weight tolerance for %s/%s at %s bps is %s', (expected, picked, bps, result) => {
  expect(withinWeightTolerance(expected as bigint, picked as bigint, bps as number)).toBe(result);
});
