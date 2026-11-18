import { continuationText, lastShoppingRequest, readAddressContinuation } from '../src/agent/address-continuation';
import type { AgentMessage } from '../src/agent/types';
const message = (id:string, text:string): AgentMessage => ({id, text, role:'user', cards:[], createdAt:'2026-01-01T00:00:00Z'});
test('continues the shopping request rather than repeating a later address message', () => {
  const original = lastShoppingRequest([message('one','Show my cart'), message('two','Add butter and curd, one each'), message('three','Please add the address Main Street')]);
  expect(original?.id).toBe('two');
  expect(continuationText(original!.text)).toContain('Add butter and curd, one each');
});
test('keeps a shopping request that mentions the delivery address', () => {
  const original = lastShoppingRequest([message('one','Please send 2 packets of milk to my home address'),message('two','Please save the address 1 Road, PIN code 520001, phone 9876543210')]);
  expect(original?.id).toBe('one');
});
test('stores only validated identifiers for a restart and rejects broken records', () => {
  expect(readAddressContinuation(JSON.stringify({id:'request',sourceId:'message',addressId:null,waitingForLocation:false,selected:false}))).toEqual({id:'request',sourceId:'message',addressId:null,waitingForLocation:false,selected:false});
  expect(readAddressContinuation('{bad')).toBeNull();
  expect(readAddressContinuation(JSON.stringify({id:'request',sourceId:4}))).toBeNull();
});
