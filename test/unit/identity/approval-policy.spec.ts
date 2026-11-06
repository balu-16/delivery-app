import { canonicalApprovalPayload } from '../../../src/modules/compliance/domain/approval-policy.js';
it('canonicalizes nested approval payloads independent of object key order', () => {
  expect(canonicalApprovalPayload({ z: [3, null, { b: false, a: 'x' }], a: 2 })).toBe(
    '{"a":2,"z":[3,null,{"a":"x","b":false}]}',
  );
  expect(canonicalApprovalPayload({ a: 2, z: [3, null, { a: 'x', b: false }] })).toBe(
    canonicalApprovalPayload({ z: [3, null, { b: false, a: 'x' }], a: 2 }),
  );
  expect(canonicalApprovalPayload([1, 2])).not.toBe(canonicalApprovalPayload([2, 1]));
});
