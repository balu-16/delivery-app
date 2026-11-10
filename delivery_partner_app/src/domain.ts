import type { Event, Stop } from "./store";

export const DEMO_CASH_LIMIT = 50000;
export const OFFER_DURATION_MS = 25000;
export const FAILURE_WAIT_MS = 300000;
export const MIN_CONTACT_ATTEMPTS = 2;
export const ATTEMPT_FEE = 1500;
export const ROUTE_FEE = 1800;
export const OFFER_FEE = 3500;

export function isResolved(events: Event[], id: string) {
  return events.some(
    (e) =>
      e.stopId === id &&
      ["delivered", "failed", "transferred"].includes(e.kind),
  );
}
export function pendingCash(events: Event[], stops: Stop[]) {
  return stops
    .filter(
      (s) =>
        !isResolved(events, s.id) &&
        !events.some(
          (e) =>
            e.stopId === s.id && ["cash-collected", "upi"].includes(e.kind),
        ),
    )
    .reduce((total, s) => total + s.cash, 0);
}
export function canAcceptCash(
  held: number,
  pending: number,
  proposed: number,
  limit = DEMO_CASH_LIMIT,
) {
  return proposed === 0 || held + pending + proposed <= limit;
}
export function lastActiveOffer(events: Event[]) {
  return [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "offer-accepted" &&
        e.stopId &&
        !events.some(
          (x) =>
            ["offer-completed", "offer-failed", "offer-transferred"].includes(
              x.kind,
            ) && x.stopId === e.stopId,
        ),
    );
}
export function hasOpenIssue(events: Event[]) {
  const issue = events.map((e) => e.kind).lastIndexOf("issue");
  return (
    issue >= 0 &&
    issue > events.map((e) => e.kind).lastIndexOf("issue-resolved")
  );
}
export function waitRemaining(events: Event[], stopId: string, now: number) {
  const arrival = events.find(
    (e) => e.kind === "arrived" && e.stopId === stopId,
  );
  return arrival
    ? Math.max(0, FAILURE_WAIT_MS - (now - arrival.at))
    : FAILURE_WAIT_MS;
}
export function attemptCount(events: Event[], stopId: string) {
  const arrival = events.find(
    (e) => e.kind === "arrived" && e.stopId === stopId,
  );
  return events.filter(
    (e) =>
      e.kind === "contact" &&
      e.stopId === stopId &&
      arrival &&
      e.at >= arrival.at,
  ).length;
}

export function distancePassed(events: Event[], stopId: string) {
  return (
    events
      .filter(
        (e) =>
          e.stopId === stopId &&
          ["distance-near", "distance-far"].includes(e.kind),
      )
      .at(-1)?.kind === "distance-near"
  );
}
