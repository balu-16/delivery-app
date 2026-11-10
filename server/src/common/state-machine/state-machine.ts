/** Pure guarded transition; storage/history/event belong to the caller's transaction. */
export function transition<State extends string>(
  current: State,
  next: State,
  allowed: Readonly<Record<State, readonly State[]>>,
): State {
  if (!allowed[current].includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  return next;
}

export interface TransitionRule<State extends string, Actor extends string, Context, Event> {
  from: State;
  to: State;
  actors: readonly Actor[];
  guard?: (context: Context) => boolean;
  events?: (context: Context) => readonly Event[];
}

/** Pure policy decision. Persist returned state, history and events atomically. */
export function decideTransition<State extends string, Actor extends string, Context, Event>(
  current: State,
  next: State,
  actor: Actor,
  context: Context,
  rules: readonly TransitionRule<State, Actor, Context, Event>[],
): { state: State; events: readonly Event[] } {
  const matching = rules.filter(
    (rule) => rule.from === current && rule.to === next && rule.actors.includes(actor),
  );
  if (matching.length !== 1 || !matching[0] || (matching[0].guard && !matching[0].guard(context)))
    throw new Error('ILLEGAL_STATE_TRANSITION');
  return { state: next, events: matching[0].events?.(context) ?? [] };
}
