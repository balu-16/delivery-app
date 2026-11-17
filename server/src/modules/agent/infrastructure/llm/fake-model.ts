import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { randomUUID } from 'node:crypto';

/** Scriptable LangChain test double; it does not claim natural-language understanding. */
export class ScriptedChatModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly replies: readonly AIMessage[] = []) {
    super({});
  }
  _llmType(): string {
    return 'scripted-customer-assistant';
  }
  override bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const scripted = this.replies[this.index++];
    const last = messages.at(-1);
    const human = [...messages].reverse().find((item) => item._getType() === 'human');
    const humanText = typeof human?.content === 'string' ? human.content.toLowerCase().trim() : '';
    const call = (name: string, args: Record<string, unknown> = {}) =>
      new AIMessage({
        content: '',
        tool_calls: [{ name, args, id: randomUUID(), type: 'tool_call' }],
      });
    let message: AIMessage;
    if (scripted) message = scripted;
    else if (last?._getType() === 'tool') {
      let result: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } } = {};
      try {
        result = JSON.parse(
          typeof last.content === 'string' ? last.content : '{}',
        ) as typeof result;
      } catch {
        /* Use a safe generic reply. */
      }
      const toolCallId = ToolMessage.isInstance(last) ? last.tool_call_id : '';
      const previous = [...messages]
        .reverse()
        .find(
          (item) =>
            AIMessage.isInstance(item) && item.tool_calls?.some((entry) => entry.id === toolCallId),
        );
      const toolName = AIMessage.isInstance(previous)
        ? previous.tool_calls?.find((entry) => entry.id === toolCallId)?.name
        : undefined;
      if (!result.ok)
        message = new AIMessage(
          result.error?.code === 'ADDRESS_REQUIRED'
            ? 'Please add a delivery address first.'
            : 'I could not complete that request. Please try again.',
        );
      else if (humanText === 'order 2 milk' && toolName === 'get_cart') {
        const items = Array.isArray(result.data?.items) ? result.data.items : [];
        message = items.length
          ? new AIMessage(
              'You already have items in your cart. Please review them before ordering.',
            )
          : call('search_products', { query: 'milk' });
      } else if (humanText === 'order 2 milk' && toolName === 'search_products') {
        const items = Array.isArray(result.data?.items)
          ? result.data.items.filter(
              (item) => item && typeof item === 'object' && item.availability !== 'OUT_OF_STOCK',
            )
          : [];
        message =
          items.length === 1 && typeof items[0].variantId === 'string'
            ? call('set_cart_item_qty', {
                variantId: items[0].variantId,
                quantity: 2,
                ...(typeof result.data?.addressId === 'string'
                  ? { addressId: result.data.addressId }
                  : {}),
              })
            : new AIMessage(
                'Please choose the milk you want from the product card, then ask me to place the order.',
              );
      } else if (humanText === 'order 2 milk' && toolName === 'set_cart_item_qty')
        message = call('place_order');
      else if (toolName === 'place_order')
        message = new AIMessage(
          result.data?.status === 'executed'
            ? 'Your order was placed.'
            : 'The order was not placed.',
        );
      else message = new AIMessage('Here is what I found.');
    } else {
      const input = typeof last?.content === 'string' ? last.content.toLowerCase() : '';
      message =
        humanText === 'order 2 milk'
          ? call('get_cart')
          : /^(place order|place my order)$/.test(input.trim())
            ? call('place_order')
            : /show me milk|दूध|పాలు/.test(input)
              ? call('search_products', { query: 'milk' })
              : /where is my order|recent orders|ऑर्डर कहाँ|ఆర్డర్ ఎక్కడ/.test(input)
                ? call('list_recent_orders', { limit: 5 })
                : /my cart|show cart|कार्ट दिखाएं|కార్ట్ చూపించండి/.test(input)
                  ? call('get_cart')
                  : new AIMessage('Hello! I can help you find products or check your orders.');
    }
    return {
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    };
  }
}
