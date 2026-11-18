import { distinctAddressCards, pendingLocationAddressId } from '../src/agent/distinct-address-cards';
import type { AgentCard } from '../src/agent/types';
const card = (id:string, addressId?:string): AgentCard => ({cardId:id,type:'info',payload:{options:[{label:'Add address',action:'open_screen',payload:{screen:'addresses',...(addressId ? {addressId} : {})}}]}});
test('removes repeated prompts in saved conversations but keeps different addresses and other cards', () => {
  const other:AgentCard = {cardId:'other',type:'product_list',payload:{}};
  expect(distinctAddressCards([card('one'),card('two'),card('three','a'),card('four','b'),other]).map(item=>item.cardId)).toEqual(['one','three','four','other']);
});
test('remembers only address cards that actually require a location', () => {
  expect(pendingLocationAddressId({cardId:'one',type:'info',payload:{options:[{action:'open_screen',payload:{screen:'addresses',addressId:'a',needsLocation:true}}]}})).toBe('a');
  expect(pendingLocationAddressId(card('two','b'))).toBeNull();
});
