import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AgentCard } from '@/src/agent/types';
import { agentStrings } from '@/src/agent/strings';
import { formatPaise } from './Shared';

type Props = { card: AgentCard; locale?: string | null; busy: boolean; onDecision: (id: string, decision: 'approve' | 'reject') => void; onAction: (cardId: string, action: string, payload: Record<string, unknown>) => void };
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function AssistantCard({ card, locale, busy, onDecision, onAction }: Props) {
  const t = agentStrings(locale), payload = card.payload;
  const draftId = text(payload.draftId), expiresAt = text(payload.expiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  const remaining = expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : 0;
  const expired = !!expiresAt && (!Number.isFinite(remaining) || remaining <= 0);
  const status = text(payload.status);
  const approved = status === 'approved';
  const disabled = busy || expired || (!!status && status !== 'pending' && !approved);
  const confirm = ['address_confirm', 'order_confirm', 'cancel_confirm', 'refund_confirm', 'subscription_confirm'].includes(card.type);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return <View style={styles.card} accessibilityLabel={text(payload.title) || card.type.replaceAll('_', ' ')}>
    {!!text(payload.title) && <Text style={styles.title}>{text(payload.title)}</Text>}
    {!!text(payload.description) && <Text style={styles.body}>{text(payload.description)}</Text>}
    {!!text(payload.formatted) && <Text style={styles.body}>{text(payload.formatted)}</Text>}
    {items.map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const name = text(item.name) || text(item.productName);
      const id = text(item.variantId);
      const price = text(item.sellingPaise) || text(item.unitPricePaise);
      return <View key={id || String(index)} style={styles.item}>
        <View style={styles.grow}><Text style={styles.itemName}>{name}</Text>{!!text(item.variantName) && <Text style={styles.muted}>{text(item.variantName)}</Text>}{!!text(item.availability) && <Text style={styles.muted}>{text(item.availability).replaceAll('_', ' ').toLowerCase()}</Text>}</View>
        {!!price && <Text style={styles.itemName}>{formatPaise(price)}</Text>}
        {!!text(item.quantity) && <Text style={styles.muted}>× {text(item.quantity)}</Text>}
      </View>;
    })}
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
    {!!text(payload.message) && <Text style={styles.body}>{text(payload.message)}</Text>}
    {Array.isArray(payload.options) && payload.options.map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const option = raw as Record<string, unknown>, label = text(option.label), action = text(option.action);
      if (!label || !action) return null;
      return <Pressable key={`${action}-${index}`} accessibilityRole="button" disabled={busy} onPress={() => onAction(card.cardId, action, typeof option.payload === 'object' && option.payload !== null ? option.payload as Record<string, unknown> : {})} style={styles.option}><Text style={styles.optionText}>{label}</Text></Pressable>;
    })}
    {confirm && !!draftId && <>
      {!!expiresAt && <Text style={styles.muted}>{expired ? t.expired : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}</Text>}
      <View style={styles.actions}><Pressable disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} onPress={() => onDecision(draftId, 'approve')} style={[styles.primary, disabled && styles.disabled]}><Text style={styles.primaryText}>{busy ? t.pending : t.approve}</Text></Pressable><Pressable disabled={disabled || approved} accessibilityRole="button" accessibilityState={{ disabled: disabled || approved }} onPress={() => onDecision(draftId, 'reject')} style={[styles.option, (disabled || approved) && styles.disabled]}><Text style={styles.optionText}>{t.reject}</Text></Pressable></View>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderColor: '#deded8', borderWidth: 1, borderRadius: 12, padding: 14, gap: 8, minWidth: 220 },
  title: { color: '#252820', fontSize: 16, fontWeight: '700' }, body: { color: '#33372d', fontSize: 15, lineHeight: 22 }, muted: { color: '#62685d', fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }, grow: { flex: 1 }, itemName: { color: '#252820', fontWeight: '600' }, actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  option: { borderRadius: 8, borderWidth: 1, borderColor: '#526c39', minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14 }, optionText: { color: '#36551f', fontWeight: '600' },
  primary: { backgroundColor: '#405f29', borderRadius: 8, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 18 }, primaryText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.45 },
});
