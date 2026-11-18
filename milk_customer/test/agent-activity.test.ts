import { toolActivity, updateActiveTools } from '../src/agent/activity';
import { agentStrings } from '../src/agent/strings';

test('describes real actions in each supported language without claiming success', () => {
  for (const locale of ['en', 'hi', 'te'] as const) {
    const t = agentStrings(locale);
    expect(toolActivity('agent.tool.search_products', t)).toBe(t.activityProducts);
    expect(toolActivity('agent.activity.findProducts', t)).toBe(t.activityProducts);
    expect(toolActivity('agent.tool.set_cart_item_qty', t)).toBe(t.activityCartUpdate);
    expect(toolActivity('agent.tool.place_order', t)).toBe(t.activityOrder);
    expect(toolActivity('agent.tool.place_order', t, 'approve')).toBe(t.activityPlacing);
    expect(toolActivity('agent.tool.place_order', t, 'reject')).toBe(t.activityDecision);
    expect(toolActivity('agent.tool.unknown', t)).toBe(t.activityPreparing);
  }
});

test('keeps a repeated or overlapping action active until each matching call ends', () => {
  let active: string[] = [];
  active = updateActiveTools(active, 'search', 'start');
  active = updateActiveTools(active, 'address', 'start');
  active = updateActiveTools(active, 'search', 'start');
  active = updateActiveTools(active, 'search', 'end');
  expect(active).toEqual(['search', 'address']);
  active = updateActiveTools(active, 'address', 'end');
  expect(active).toEqual(['search']);
  expect(updateActiveTools(active, 'unknown', 'end')).toEqual(['search']);
  expect(updateActiveTools(active, 'search', 'end')).toEqual([]);
});
