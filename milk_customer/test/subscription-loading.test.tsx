/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SubscriptionPanel } from '../components/connected/SubscriptionPanel';
import { customerDetailsApi, type CatalogItem, type SubscriptionOptions } from '../src/api/customer';

jest.mock('../src/api/customer', () => ({ customerDetailsApi:{subscriptionOptions:jest.fn()} }));
jest.mock('../src/auth/session', () => ({ accessToken:jest.fn(async () => 'token') }));
jest.mock('../src/store/customer', () => ({ useCustomer:() => ({busy:false,pendingSubscription:null,createSubscription:jest.fn()}) }));
jest.mock('expo-router', () => ({ router:{push:jest.fn()} }));
jest.mock('../components/connected/Shared', () => ({ErrorBanner:() => null, shared:{muted:{},body:{},label:{},row:{},input:{}}}));
jest.mock('../components/ui/BottomSheet', () => {
  const React=require('react'), {View}=require('react-native');
  return {BottomSheet:({children}:{children:React.ReactNode}) => React.createElement(View,null,children)};
});
jest.mock('../components/ui/Button', () => {
  const React=require('react'), {Pressable,Text}=require('react-native');
  return {Button:({label,onPress}:{label:string;onPress:()=>void}) => React.createElement(Pressable,{onPress,accessibilityRole:'button'},React.createElement(Text,null,label))};
});

test('subscription options stop loading on failure and retry successfully', async () => {
  let reject!: (error: Error) => void;
  jest.mocked(customerDetailsApi.subscriptionOptions)
    .mockReturnValueOnce(new Promise((_resolve, no) => {reject=no;}))
    .mockResolvedValueOnce({enabled:false,eligible:false,slots:[],firstStartDate:'2026-01-01'} as SubscriptionOptions);
  const item = {name:'Milk',variantName:'1 litre',variantId:'v1',maxPerOrder:5} as CatalogItem;
  await render(<SubscriptionPanel item={item} addressId="a1" onClose={() => {}} />);
  expect(screen.getByLabelText('Loading delivery options')).toBeTruthy();
  await act(async () => { reject(new Error('offline')); });
  expect(await screen.findByText('Could not load subscription options.')).toBeTruthy();
  expect(screen.queryByLabelText('Loading delivery options')).toBeNull();
  await fireEvent.press(screen.getByText('Try again'));
  expect(await screen.findByText('Subscriptions are not available at the moment.')).toBeTruthy();
});
