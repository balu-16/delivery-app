/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AssistantCard } from '../components/connected/AssistantCard';
import type { AgentCard } from '../src/agent/types';

const id = '018f0000-0000-7000-8000-000000000001';
const variantId = '018f0000-0000-7000-8000-000000000002';
const addressId = '018f0000-0000-7000-8000-000000000003';

test('payment details never approve an order on the customer’s behalf', async () => {
  const decision = jest.fn(), review = jest.fn();
  const card: AgentCard = { cardId: id, type: 'order_confirm', payload: {
    draftId: id, title: 'Confirm your order', status: 'pending',
    expiresAt: new Date(Date.now() + 60000).toISOString(), totalPaise: '10000',
    walletCashPaise: '5000', walletPromoPaise: '0', amountDuePaise: '5000',
  } };
  await render(<AssistantCard card={card} busy={false} onDecision={decision} onAction={jest.fn()} onReview={review} />);
  await fireEvent.press(screen.getByText('Payment details'));
  expect(review).toHaveBeenCalledWith(card);
  expect(decision).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Confirm'));
  expect(decision).toHaveBeenCalledWith(id, 'approve');
});

test('quantity controls prevent a double tap while allowing a later intentional add', async () => {
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const action = jest.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
  const card: AgentCard = { cardId: id, type: 'product_list', payload: {
    items: [{ name: 'Milk', variantId, sellingPaise: '5000', maxPerOrder: 5 }],
    options: [{ label: 'Add milk', action: 'add_to_cart', payload: { variantId, addressId, quantity: 1 } }],
  } };
  await render(<AssistantCard card={card} busy={false} onDecision={jest.fn()} onAction={action} onReview={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('Increase Milk quantity'));
  await fireEvent.press(screen.getByLabelText('Add 2 Milk to cart'));
  await fireEvent.press(screen.getByLabelText('Add 2 Milk to cart'));
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith(id, 'add_to_cart', { variantId, addressId, quantity: 2 });
  await act(async () => { release(); await first; });
  await fireEvent.press(screen.getByLabelText('Add 2 Milk to cart'));
  expect(action).toHaveBeenCalledTimes(2);
});

test('an expired confirmation can be refreshed but cannot be approved', async () => {
  const decision = jest.fn(), action = jest.fn();
  const card: AgentCard = { cardId: id, type: 'order_confirm', payload: {
    draftId: id, status: 'pending', expiresAt: new Date(Date.now() - 60000).toISOString(),
  } };
  await render(<AssistantCard card={card} busy={false} onDecision={decision} onAction={action} onReview={jest.fn()} />);
  await fireEvent.press(screen.getByText('Confirm'));
  expect(decision).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Refresh details'));
  expect(action).toHaveBeenCalledWith(id, 'retry_confirmation', { type: 'order_confirm' });
});
