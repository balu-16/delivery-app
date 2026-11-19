/// <reference types="jest" />
import { act, render, screen } from '@testing-library/react-native';
import { SupportScreen } from '../src/screens/SupportScreen';
import { riderApi } from '../src/api';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  riderApi:{tickets:jest.fn(),ticket:jest.fn(),createTicket:jest.fn(),ticketMessage:jest.fn()},
}));
jest.mock('../src/actions', () => ({performAction:jest.fn()}));
jest.mock('../src/components/Ui', () => {
  const React=require('react'), native=require('react-native');
  return {
    Text:native.Text, Card:({children}:{children:React.ReactNode}) => React.createElement(native.View,null,children),
    Button:({label,onPress,disabled}:{label:string;onPress:()=>void;disabled?:boolean}) => React.createElement(native.Pressable,{onPress,disabled,accessibilityRole:'button'},React.createElement(native.Text,null,label)),
    PageTitle:({title}:{title:string}) => React.createElement(native.Text,null,title), IconBox:() => null,
  };
});
jest.mock('../src/components/Skeleton', () => ({ CardListSkeleton: () => null }));

function ticketPage(category: string) {
  return { items: [{ id: `ticket-${category}`, category, status: 'OPEN', created_at: new Date(0).toISOString() }], nextCursor: null };
}

beforeEach(() => { jest.clearAllMocks(); });

test('pull revalidates the ticket list without a duplicate empty signal', async () => {
  jest.mocked(riderApi.tickets).mockResolvedValueOnce(ticketPage('DELIVERY')).mockResolvedValueOnce(ticketPage('PAYOUT'));
  const { rerender } = await render(<SupportScreen subject="rider" refreshSignal={0} />);
  expect(await screen.findByText('DELIVERY')).toBeTruthy();
  expect(jest.mocked(riderApi.tickets)).toHaveBeenCalledTimes(1);
  await rerender(<SupportScreen subject="rider" refreshSignal={0} />);
  await act(async () => {});
  expect(jest.mocked(riderApi.tickets)).toHaveBeenCalledTimes(1);
  await rerender(<SupportScreen subject="rider" refreshSignal={1} />);
  expect(await screen.findByText('PAYOUT')).toBeTruthy();
  expect(jest.mocked(riderApi.tickets)).toHaveBeenCalledTimes(2);
});

test('a failed pull keeps the visible tickets and reports the error', async () => {
  jest.mocked(riderApi.tickets).mockResolvedValueOnce(ticketPage('DELIVERY')).mockRejectedValueOnce(new Error('Network down'));
  const { rerender } = await render(<SupportScreen subject="rider" refreshSignal={0} />);
  expect(await screen.findByText('DELIVERY')).toBeTruthy();
  await rerender(<SupportScreen subject="rider" refreshSignal={1} />);
  expect(await screen.findByText('Network down')).toBeTruthy();
  expect(screen.getByText('DELIVERY')).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
  expect(jest.mocked(riderApi.tickets)).toHaveBeenCalledTimes(2);
});

test('first-load failure offers Try again', async () => {
  jest.mocked(riderApi.tickets).mockRejectedValueOnce(new Error('Network down'));
  await render(<SupportScreen subject="rider" refreshSignal={0} />);
  expect(await screen.findByText('Try again')).toBeTruthy();
});
