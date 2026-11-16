/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Catalog } from '../components/connected/Catalog';
import { customerApi } from '../src/api/customer';

const mockFly = jest.fn();
const mockUpdateCart = jest.fn();
const mockState = {
  profile:{name:'Customer'}, addresses:[], selectedAddress:null, products:[], cursor:null,
  loadCatalog:jest.fn(), pendingPlacement:null, cart:null, notifications:[], loadAccount:jest.fn(),
  readNotifications:jest.fn(), favorites:[], favoritesLoaded:true, favoriteBusy:[],
  toggleFavorite:jest.fn(), updateCart:mockUpdateCart, error:null, clearError:jest.fn(),
};
jest.mock('../src/store/customer', () => {
  const useCustomer = (selector?: (state: typeof mockState) => unknown) => selector ? selector(mockState) : mockState;
  useCustomer.getState = () => mockState;
  return { useCustomer };
});
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn().mockResolvedValue('customer-token') }));
jest.mock('../src/api/customer', () => ({ customerApi: { catalogPreview:jest.fn() } }));
jest.mock('../components/animations/FlyToCart', () => ({ useFlyToCart: () => ({ fly:mockFly }) }));
jest.mock('../components/animations/PressableScale', () => {
  const React = require('react'); const { Pressable } = require('react-native');
  return { PressableScale: React.forwardRef((props: object, ref: unknown) => React.createElement(Pressable, {...props,ref})) };
});
jest.mock('../components/connected/AddressPanel', () => {
  const React = require('react'); const { Text } = require('react-native');
  return { AddressPanel: ({visible}: {visible:boolean}) => visible ? React.createElement(Text,null,'Address form opened') : null };
});
jest.mock('../components/ui/BottomSheet', () => {
  const React = require('react'); const { View } = require('react-native');
  return { BottomSheet: ({visible,children}: {visible:boolean;children:React.ReactNode}) => visible ? React.createElement(View,null,children) : null };
});
jest.mock('../components/ui/Button', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { Button: ({label,onPress,disabled}: {label:string;onPress:()=>void;disabled?:boolean}) => React.createElement(Pressable,{onPress,disabled,accessibilityRole:'button'},React.createElement(Text,null,label)) };
});
jest.mock('../components/ui/Screen', () => {
  const React = require('react'); const { View } = require('react-native');
  return { Screen: ({children}: {children:React.ReactNode}) => React.createElement(View,null,children) };
});
jest.mock('../components/connected/PushNotifications', () => ({PushSettings: () => null}));
jest.mock('../components/connected/useProductPhoto', () => ({useProductPhoto: () => ({source:null,illustrative:false,onError:jest.fn()})}));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('expo-linear-gradient', () => { const React = require('react'); const {View} = require('react-native'); return {LinearGradient: ({children}: {children:React.ReactNode}) => React.createElement(View,null,children)}; });
jest.mock('expo-router', () => ({ router: {push:jest.fn()} }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top:0, bottom:0 }) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(customerApi.catalogPreview).mockResolvedValue({items:[
    {productId:'product-1',name:'Test milk',description:'Sample',categoryId:'category-1',variantId:'variant-1',variantName:'500 ml',sellingPaise:'3500',mrpPaise:'4000',discountPercent:12,images:['/media/image']},
    {productId:'product-2',name:'Test curd',description:'Sample',categoryId:'category-1',variantId:'variant-2',variantName:'400 g',sellingPaise:'4500',mrpPaise:'4500',discountPercent:0,images:['/media/image-2']},
  ]});
});

test('shows real preview prices and asks for an address before adding', async () => {
  await render(<Catalog />);
  expect(await screen.findByText('Test milk')).toBeTruthy();
  expect(screen.getByText('₹35.00')).toBeTruthy();
  expect(screen.getByText('₹40.00')).toBeTruthy();
  expect(screen.getByText('12% off')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Add Test milk to cart'));
  expect(screen.getByText('Address form opened')).toBeTruthy();
  expect(mockUpdateCart).not.toHaveBeenCalled();
  expect(mockFly).not.toHaveBeenCalled();
});

test('searches the preview without requiring an address', async () => {
  await render(<Catalog />);
  await screen.findByText('Test milk');
  await fireEvent.changeText(screen.getByLabelText('Search products'), 'curd');
  await fireEvent.press(screen.getByText('Search'));
  expect(screen.getByText('Test curd')).toBeTruthy();
  expect(screen.queryByText('Test milk')).toBeNull();
});
