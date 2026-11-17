export type AgentLocale = 'en' | 'hi' | 'te';
export type CardType = 'product_list' | 'address_confirm' | 'order_confirm' | 'order_status' | 'cancel_confirm' | 'refund_confirm' | 'subscription_confirm' | 'quick_replies' | 'info';
export interface AgentCard { cardId: string; type: CardType; payload: Record<string, unknown> }
export interface AgentMessage { id: string; role: 'user' | 'assistant' | 'system_note'; text: string; cards: AgentCard[]; createdAt: string }
export interface AgentConfig { enabled: boolean; suggestedPrompts: string[]; maxMessageChars: number; disclosureVersion: string; supportedLocales: AgentLocale[] }
export interface AgentThread { id: string; messages: AgentMessage[]; nextCursor: string | null }
export interface AgentEvent { event: string; data: Record<string, unknown> }
