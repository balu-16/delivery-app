import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AgentCard } from '@/src/agent/types';
import { agentStrings } from '@/src/agent/strings';
import { cartChoiceExpiresAt, cartChoiceId, cartChoiceQuestion, cartChoiceReference, cartChoiceSelection, cartChoiceSubmitted, cartChoiceVariants } from '@/src/agent/cart-choice';
import { formatPaise } from '@/src/utils/money';

type Props = { card: AgentCard; locale?: string | null; busy: boolean; onDecision: (id: string, decision: 'approve' | 'reject') => void; onAction: (cardId: string, action: string, payload: Record<string, unknown>) => void | Promise<void>; onReview: (card: AgentCard) => void };
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function AssistantCard({ card, locale, busy, onDecision, onAction, onReview }: Props) {
  const t = agentStrings(locale), payload = card.payload;
  const draftId = text(payload.draftId), expiresAt = text(payload.expiresAt);
  const [now, setNow] = useState(() => Date.now());
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [addingId, setAddingId] = useState('');
  const adding = useRef(false);
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  const remaining = expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : 0;
  const status = text(payload.status);
  const expired = (!status || status === 'pending' || status === 'expired') && !!expiresAt && (!Number.isFinite(remaining) || remaining <= 0);
  const approved = status === 'approved';
  const disabled = busy || expired || (!!status && status !== 'pending' && !approved);
  const confirm = ['address_confirm', 'order_confirm', 'cancel_confirm', 'refund_confirm', 'subscription_confirm'].includes(card.type);
  const outcomeLabel = status === 'executed'
    ? card.type === 'refund_confirm' ? 'Refund request sent for review.' : card.type === 'cancel_confirm' ? 'Cancellation confirmed.' : card.type === 'order_confirm' ? 'Order confirmed.' : 'Request completed.'
    : status === 'rejected' || status === 'superseded' ? 'This request was not confirmed.'
    : status === 'stale' ? 'These details changed. Refresh them before confirming.'
    : status === 'approved' ? 'Your approval was received. Finish confirming if needed.' : '';
  const items = Array.isArray(payload.items) ? payload.items : [];
  const options = Array.isArray(payload.options) ? payload.options : [];
  const issue = ['out_of_stock', 'delivery_unavailable', 'payment_unavailable', 'cart_attention'].includes(card.type);
  const eta = payload.etaRange && typeof payload.etaRange === 'object' ? payload.etaRange as Record<string, unknown> : null;
  return <View style={styles.card} accessibilityLabel={text(payload.title) || card.type.replaceAll('_', ' ')}>
    {!!text(payload.title) && <Text style={styles.title}>{text(payload.title)}</Text>}
    {!!text(payload.description) && <Text style={styles.body}>{text(payload.description)}</Text>}
    {!!text(payload.formatted) && <Text style={styles.body}>{text(payload.formatted)}</Text>}
    {items.map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const name = text(item.name) || text(item.orderNumber) || text(item.productName);
      const id = text(item.variantId) || text(item.orderId);
      const price = text(item.sellingPaise) || text(item.unitPricePaise);
      const status = text(item.status);
      const option = card.type === 'product_list' && id ? options.find(raw => {
        if (!raw || typeof raw !== 'object') return false;
        const value = raw as Record<string, unknown>;
        return value.action === 'add_to_cart' && value.payload && typeof value.payload === 'object' && (value.payload as Record<string, unknown>).variantId === id;
      }) as Record<string, unknown> | undefined : undefined;
      const optionPayload = option?.payload && typeof option.payload === 'object' ? option.payload as Record<string, unknown> : null;
      const max = typeof item.maxPerOrder === 'number' && Number.isSafeInteger(item.maxPerOrder) && item.maxPerOrder > 0 ? Math.min(item.maxPerOrder, 100) : 10;
      const initial = Number(item.quantity);
      const quantity = quantities[id] ?? (Number.isSafeInteger(initial) && initial > 0 ? Math.min(initial, max) : 1);
      return <View key={id || String(index)} style={styles.item}>
        <View style={styles.grow}><Text style={styles.itemName}>{name}</Text>{!!text(item.variantName) && <Text style={styles.muted}>{text(item.variantName)}</Text>}{!!status && <Text style={styles.muted}>{status.replaceAll('_', ' ').toLowerCase()}</Text>}{!!text(item.availability) && <Text style={styles.muted}>{text(item.availability).replaceAll('_', ' ').toLowerCase()}</Text>}</View>
        {!!price && <Text style={styles.itemName}>{formatPaise(price)}</Text>}
        {optionPayload ? <View style={styles.itemActions}>
          <View style={styles.stepper}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${name} quantity`} disabled={busy || quantity <= 1} onPress={() => setQuantities(current => ({ ...current, [id]: Math.max(1, quantity - 1) }))} style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
            <Text accessibilityLabel={`${quantity} selected`} style={styles.quantity}>{quantity}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${name} quantity`} disabled={busy || quantity >= max} onPress={() => setQuantities(current => ({ ...current, [id]: Math.min(max, quantity + 1) }))} style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Add ${quantity} ${name} to cart`} disabled={busy || addingId === id} onPress={() => {
            if (adding.current) return;
            adding.current = true; setAddingId(id);
            void Promise.resolve(onAction(card.cardId, 'add_to_cart', { ...optionPayload, quantity })).finally(() => { adding.current = false; setAddingId(''); });
          }} style={[styles.add, (busy || addingId === id) && styles.disabled]}><Text style={styles.primaryText}>{addingId === id ? 'Adding' : 'Add'}</Text></Pressable>
        </View> : !!text(item.quantity) && <Text style={styles.muted}>× {text(item.quantity)}</Text>}
      </View>;
    })}
    {card.type === 'order_confirm' && eta && typeof eta.minMinutes === 'number' && typeof eta.maxMinutes === 'number' && eta.minMinutes >= 0 && eta.maxMinutes >= eta.minMinutes && <Text style={styles.body}>Estimated delivery: {eta.minMinutes}–{eta.maxMinutes} min</Text>}
    {card.type === 'order_confirm' && Array.isArray(payload.fees) && payload.fees.map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const fee = raw as Record<string, unknown>, amount = text(fee.amountPaise);
      if (!amount || amount === '0') return null;
      return <View key={`${text(fee.kind)}-${index}`} style={styles.item}><Text style={styles.grow}>{text(fee.kind).replaceAll('_', ' ').toLowerCase()}</Text><Text>{formatPaise(amount)}</Text></View>;
    })}
    {card.type === 'order_confirm' && !!text(payload.taxTotalPaise) && text(payload.taxTotalPaise) !== '0' && <View style={styles.item}><Text style={styles.grow}>{t.tax}</Text><Text>{formatPaise(text(payload.taxTotalPaise))}</Text></View>}
    {card.type === 'order_confirm' && !!text(payload.discountPaise) && text(payload.discountPaise) !== '0' && <View style={styles.item}><Text style={styles.grow}>{t.discount}</Text><Text>-{formatPaise(text(payload.discountPaise))}</Text></View>}
    {!!text(payload.totalPaise) && <View style={styles.item}><Text style={styles.grow}>{t.total}</Text><Text style={styles.title}>{formatPaise(text(payload.totalPaise))}</Text></View>}
    {card.type === 'order_confirm' && !!text(payload.walletCashPaise) && text(payload.walletCashPaise) !== '0' && <View style={styles.item}><Text style={styles.grow}>{t.wallet}</Text><Text>-{formatPaise(text(payload.walletCashPaise))}</Text></View>}
    {card.type === 'order_confirm' && !!text(payload.walletPromoPaise) && text(payload.walletPromoPaise) !== '0' && <View style={styles.item}><Text style={styles.grow}>{t.promotionalBalance}</Text><Text>-{formatPaise(text(payload.walletPromoPaise))}</Text></View>}
    {card.type === 'order_confirm' && !!text(payload.amountDuePaise) && <View style={styles.item}><Text style={styles.grow}>{t.dueOnDelivery}</Text><Text style={styles.title}>{formatPaise(text(payload.amountDuePaise))}</Text></View>}
    {card.type === 'cart_choice' && <CartChoiceCard card={card} busy={busy} onAction={onAction} />}
    {card.type === 'order_confirm' && <Pressable accessibilityRole="button" onPress={() => onReview(card)} style={styles.option}><Text style={styles.optionText}>Payment details</Text></Pressable>}
    {Array.isArray(payload.missingFields) && payload.missingFields.length > 0 && <Text style={styles.body}>Still needed: {payload.missingFields.filter(field => typeof field === 'string').join(', ')}.</Text>}
    {!!text(payload.message) && <Text style={styles.body}>{text(payload.message)}</Text>}
    {options.map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const option = raw as Record<string, unknown>, label = text(option.label), action = text(option.action);
      if (!label || !action) return null;
      if (card.type === 'product_list' && action === 'add_to_cart') return null;
      return <Pressable key={`${action}-${index}`} accessibilityRole="button" disabled={busy} onPress={() => onAction(card.cardId, action, typeof option.payload === 'object' && option.payload !== null ? option.payload as Record<string, unknown> : {})} style={styles.option}><Text style={styles.optionText}>{label}</Text></Pressable>;
    })}
    {issue && <Pressable accessibilityRole="button" onPress={() => onReview(card)} style={styles.option}><Text style={styles.optionText}>See options</Text></Pressable>}
    {confirm && !!draftId && <>
      {!!outcomeLabel && <Text style={styles.body} accessibilityLiveRegion="polite">{outcomeLabel}</Text>}
      {!!expiresAt && (!status || status === 'pending' || status === 'expired') && <Text style={styles.muted}>{expired || status === 'expired' ? t.expired : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}</Text>}
      {(expired || status === 'expired' || status === 'stale') && <Pressable accessibilityRole="button" disabled={busy} onPress={() => onAction(card.cardId, 'retry_confirmation', { type: card.type })} style={styles.option}><Text style={styles.optionText}>Refresh details</Text></Pressable>}
      <View style={styles.actions}><Pressable disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} onPress={() => onDecision(draftId, 'approve')} style={[styles.primary, disabled && styles.disabled]}><Text style={styles.primaryText}>{busy ? t.pending : t.approve}</Text></Pressable><Pressable disabled={disabled || approved} accessibilityRole="button" accessibilityState={{ disabled: disabled || approved }} onPress={() => onDecision(draftId, 'reject')} style={[styles.option, (disabled || approved) && styles.disabled]}><Text style={styles.optionText}>{t.reject}</Text></Pressable></View>
    </>}
  </View>;
}

/**
 * Durable cart choice: pick an exact catalog size, then how many packs.
 * Quantity is asked even when only one size exists; "Other" leaves the
 * typed answer to the composer. One tap on a quantity submits exactly once.
 */
function CartChoiceCard({ card, busy, onAction }: { card: AgentCard; busy: boolean; onAction: Props['onAction'] }) {
  const question = cartChoiceQuestion(card);
  const choiceId = cartChoiceId(card);
  const reference = cartChoiceReference(card);
  const variants = cartChoiceVariants(card);
  const selection = cartChoiceSelection(card);
  const status = text(card.payload.status);
  const expiresAt = cartChoiceExpiresAt(card);
  const [now, setNow] = useState(() => Date.now());
  const [variantId, setVariantId] = useState(selection.variantId ?? '');
  const [other, setOther] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const submitted = confirmed || cartChoiceSubmitted(card);
  const closed = !!status && status !== 'pending';
  const placing = useRef(false);
  useEffect(() => {
    if (!expiresAt || closed || submitted) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [closed, expiresAt, submitted]);
  const expired = status === 'expired' || (expiresAt !== null && now >= expiresAt);
  const blocked = busy || submitting || submitted || expired || closed;
  const submit = (quantity: number) => {
    if (!variantId || quantity < 1 || blocked || placing.current) return;
    placing.current = true;
    setSubmitting(true);
    void Promise.resolve(onAction(card.cardId, 'cart_choice', { ...reference, choiceId, variantId, quantity }))
      .then(() => setConfirmed(true))
      .catch(() => undefined)
      .finally(() => { placing.current = false; setSubmitting(false); });
  };
  const remaining = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return <View style={styles.choice} accessibilityLabel={question}>
    <Text style={styles.body}>{question}</Text>
    {submitted
      ? <Text style={styles.body} accessibilityLiveRegion="polite">Added to your cart.</Text>
      : expired
      ? <Text style={styles.muted}>This choice has expired. Ask for the item again.</Text>
      : closed ? <Text style={styles.muted}>This choice has closed.</Text>
      : variants.length === 0
        ? <Text style={styles.muted}>Type your answer below — for example “2 packs of 500 g”.</Text>
        : <>
          <View style={styles.choiceRow} accessibilityLabel="Choose a size">
            {variants.map((variant) => {
              const active = variantId === variant.variantId;
              return <Pressable key={variant.variantId} accessibilityRole="button" accessibilityLabel={`Choose ${variant.label}`} accessibilityState={{ selected: active, disabled: blocked }} disabled={blocked} onPress={() => { setOther(false); setVariantId(variant.variantId); }} style={[styles.choicePill, active && styles.choiceActive]}><Text style={[styles.choiceText, active && styles.choiceTextActive]}>{variant.label}{variant.sellingPaise ? ` · ${formatPaise(variant.sellingPaise)}` : ''}</Text></Pressable>;
            })}
          </View>
          {!!variantId && (selection.quantity ?
            <Pressable accessibilityRole="button" disabled={blocked} onPress={() => submit(selection.quantity!)} style={styles.choicePill}><Text style={styles.choiceText}>Add {selection.quantity} {selection.quantity === 1 ? 'pack' : 'packs'}</Text></Pressable>
            : <>{question !== 'How many packs?' && <Text style={styles.muted}>How many packs?</Text>}<View style={styles.choiceRow} accessibilityLabel="Choose a quantity">
            {[{ label: '1', value: 1 }, { label: '2', value: 2 }].map((option) => <Pressable key={option.label} accessibilityRole="button" accessibilityLabel={`${option.label} pack`} disabled={blocked} onPress={() => { setOther(false); submit(option.value); }} style={[styles.choicePill, submitting && styles.choiceActive]}><Text style={styles.choiceText}>{option.label}</Text></Pressable>)}
            <Pressable accessibilityRole="button" accessibilityLabel="Other quantity" accessibilityState={{ selected: other }} onPress={() => setOther(true)} style={[styles.choicePill, other && styles.choiceActive]}><Text style={[styles.choiceText, other && styles.choiceTextActive]}>Other</Text></Pressable>
          </View>{other && <Text style={styles.muted}>Type your answer, for example “4 packs of {variants.find(item => item.variantId === variantId)?.label}”.</Text>}</>)}
          {remaining !== null && !expired && <Text style={styles.muted}>{t_expired(remaining)}</Text>}
        </>}
  </View>;
}

function t_expired(remainingSeconds: number): string {
  return `This choice expires in ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderColor: '#deded8', borderWidth: 1, borderRadius: 12, padding: 14, gap: 8, minWidth: 220 },
  title: { color: '#252820', fontSize: 16, fontWeight: '700' }, body: { color: '#33372d', fontSize: 15, lineHeight: 22 }, muted: { color: '#62685d', fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }, grow: { flex: 1 }, itemName: { color: '#252820', fontWeight: '600' }, actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  option: { borderRadius: 8, borderWidth: 1, borderColor: '#526c39', minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14 }, optionText: { color: '#36551f', fontWeight: '600' },
  primary: { backgroundColor: '#405f29', borderRadius: 8, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 18 }, primaryText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.45 },
  itemActions: { gap: 5, alignItems: 'center' }, stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#d8dfd0', borderRadius: 9 }, step: { minWidth: 34, minHeight: 36, alignItems: 'center', justifyContent: 'center' }, stepText: { color: '#36551f', fontSize: 19 }, quantity: { minWidth: 20, textAlign: 'center', color: '#263520' }, add: { minHeight: 36, minWidth: 68, borderRadius: 8, backgroundColor: '#405f29', justifyContent: 'center', alignItems: 'center' },
  choice: { gap: 10 }, choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, choicePill: { borderRadius: 20, borderWidth: 1, borderColor: '#a7b893', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#fff' }, choiceActive: { backgroundColor: '#405f29', borderColor: '#405f29' }, choiceText: { color: '#36551f', fontWeight: '700', fontSize: 14 }, choiceTextActive: { color: '#fff' },
});
