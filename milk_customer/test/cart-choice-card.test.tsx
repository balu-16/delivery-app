/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AssistantCard } from '../components/connected/AssistantCard';
import type { AgentCard } from '../src/agent/types';

const cardId = '018f0000-0000-7000-8000-000000000011';
const choiceId = 'choice-1';
const V1 = '018f0000-0000-7000-8000-000000000012';
const V2 = '018f0000-0000-7000-8000-000000000013';

function choiceCard(payload: Record<string, unknown>): AgentCard {
  return { cardId, type: 'cart_choice', payload };
}

const twoSizes = {
  choiceId,
  question: 'Which curd size would you like?',
  variants: [
    { variantId: V1, label: '500 g', sellingPaise: '5000' },
    { variantId: V2, label: '1 kg', sellingPaise: '9000' },
  ],
};

test('picking a size shows one question and highlights only the quantity being submitted', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const onAction = jest.fn().mockImplementationOnce(() => pending);
  const props = { busy: false, onDecision: jest.fn(), onAction, onReview: jest.fn() };
  const { rerender } = await render(<AssistantCard card={choiceCard(twoSizes)} {...props} />);
  expect(screen.getByText('Which curd size would you like?')).toBeTruthy();
  expect(screen.queryByText('How many packs?')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Choose 500 g'));
  expect(screen.getByText('How many packs?')).toBeTruthy();
  expect(screen.queryByText(twoSizes.question)).toBeNull();
  const one = screen.getByLabelText('1 pack');
  const two = screen.getByLabelText('2 packs');
  await act(async () => {
    await fireEvent.press(one);
    await fireEvent.press(two);
  });
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onAction).toHaveBeenCalledWith(cardId, 'cart_choice', { choiceId, variantId: V1, quantity: 1 });
  expect(screen.getByRole('button', { name: '1 pack', selected: true, disabled: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: '2 packs', selected: false, disabled: true })).toBeTruthy();
  expect(screen.queryByText('Added 1 pack to your cart.')).toBeNull();
  await act(async () => { release(); });
  await rerender(<AssistantCard card={choiceCard({ ...twoSizes, status: 'committed', selection: { variantId: V1, quantity: 1 } })} {...props} />);
  expect(screen.getAllByText('Added 1 pack to your cart.')).toHaveLength(1);
  expect(screen.queryByText('How many packs?')).toBeNull();
  expect(screen.queryByLabelText('2 packs')).toBeNull();
});

test('a single curd size is selected and shows the server question once', async () => {
  const onAction = jest.fn().mockResolvedValue(undefined);
  const question = 'How many packs of Curd (500 g)?';
  await render(<AssistantCard card={choiceCard({ ...twoSizes, question, message: question, variants: twoSizes.variants.slice(0, 1) })} busy={false} onDecision={jest.fn()} onAction={onAction} onReview={jest.fn()} />);
  expect(screen.getByLabelText('Choose 500 g')).toBeTruthy();
  expect(screen.getAllByText(question)).toHaveLength(1);
  expect(screen.queryByText('How many packs?')).toBeNull();
  await fireEvent.press(screen.getByLabelText('1 pack'));
  expect(onAction).toHaveBeenCalledWith(cardId, 'cart_choice', { choiceId, variantId: V1, quantity: 1 });
});

test('Other leaves the typed answer to the composer without submitting', async () => {
  const onAction = jest.fn().mockResolvedValue(undefined);
  await render(<AssistantCard card={choiceCard(twoSizes)} busy={false} onDecision={jest.fn()} onAction={onAction} onReview={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('Choose 1 kg'));
  await fireEvent.press(screen.getByLabelText('Other quantity'));
  expect(screen.getByText('Type your answer, for example “4 packs of 1 kg”.')).toBeTruthy();
  expect(onAction).not.toHaveBeenCalled();
});

test('an expired choice blocks submission', async () => {
  const onAction = jest.fn().mockResolvedValue(undefined);
  await render(<AssistantCard card={choiceCard({ ...twoSizes, expiresAt: new Date(Date.now() - 60000).toISOString() })} busy={false} onDecision={jest.fn()} onAction={onAction} onReview={jest.fn()} />);
  expect(screen.getByText(/This choice has expired/)).toBeTruthy();
  expect(screen.queryByLabelText('Choose 500 g')).toBeNull();
  expect(screen.queryByText('How many packs?')).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
});

test('a committed choice confirms the cart update and blocks taps', async () => {
  const onAction = jest.fn().mockResolvedValue(undefined);
  await render(<AssistantCard card={choiceCard({ ...twoSizes, status: 'committed' })} busy={false} onDecision={jest.fn()} onAction={onAction} onReview={jest.fn()} />);
  expect(screen.getByText('Added to your cart.')).toBeTruthy();
  expect(screen.queryByLabelText('Choose 500 g')).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
});

test('without variants the card falls back to a typed answer', async () => {
  const onAction = jest.fn().mockResolvedValue(undefined);
  await render(<AssistantCard card={choiceCard({ choiceId, question: 'Which curd?' })} busy={false} onDecision={jest.fn()} onAction={onAction} onReview={jest.fn()} />);
  expect(screen.getByText('Type your answer below — for example “2 packs of 500 g”.')).toBeTruthy();
  expect(screen.queryByLabelText('Choose 500 g')).toBeNull();
});
