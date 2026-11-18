/** Push and inbox data are untrusted: only route known assistant notifications. */
export function assistantNotificationTarget(data: Record<string, unknown>): { threadId?: string; nudgeName?: string } | null {
  const link = data.link ?? data.deepLink;
  if (link !== '/agent') return null;
  if (typeof data.threadId === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(data.threadId)) return { threadId: data.threadId };
  if (typeof data.variantId === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(data.variantId)) {
    const name = typeof data.productName === 'string' ? data.productName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
    return { nudgeName: name || 'my usual item' };
  }
  return null;
}
