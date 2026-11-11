import type { Event, Stop } from "./store";

export const DEMO_CASH_LIMIT = 50000;
export const OFFER_DURATION_MS = 25000;
export const FAILURE_WAIT_MS = 300000;
export const MIN_CONTACT_ATTEMPTS = 2;
export const ATTEMPT_FEE = 1500;
export const ROUTE_FEE = 1800;
export const OFFER_FEE = 3500;

export function isValidCount(value: string, optional = false) {
  return (optional && value === "") || /^\d{1,3}$/.test(value);
}

export function openPickupIssue(events: Event[]) {
  const issue = [...events]
    .reverse()
    .find((event) => ["pickup-issue", "pickup-resolved"].includes(event.kind));
  return issue?.kind === "pickup-issue" ? issue : undefined;
}

export function pickupAffectedStops(issue: Event, stops: Stop[]) {
  if (!issue.data || issue.data === "milk" || issue.data === "crates")
    return stops;
  return stops.filter((stop) => stop.items.toLowerCase().includes(issue.data!));
}

export function isAttemptFeeEligible(reason?: string) {
  return [
    "Customer unavailable",
    "Wrong address",
    "Inaccessible doorstep",
    "Damaged item",
    "Short quantity",
    "Wrong item",
  ].includes(reason ?? "");
}

export function pendingAttemptReviews(events: Event[]) {
  return events.filter(
    (event) =>
      ["failed", "offer-failed"].includes(event.kind) &&
      event.reason !== "Partner at fault" &&
      !isAttemptFeeEligible(event.reason),
  ).length;
}

export function isResolved(events: Event[], id: string) {
  return events.some(
    (e) =>
      e.stopId === id &&
      ["delivered", "failed", "transferred"].includes(e.kind),
  );
}

export function hubReturnUnits(events: Event[], stops: Stop[]) {
  return stops.reduce((total, stop) => {
    const resolution = events.find(
      (event) =>
        event.stopId === stop.id &&
        ["delivered", "failed", "transferred"].includes(event.kind),
    );
    return (
      total +
      (resolution?.kind === "failed" ||
      (resolution?.kind === "transferred" &&
        resolution.reason === "Returned to hub")
        ? stop.units
        : 0)
    );
  }, 0);
}
export function pendingCash(events: Event[], stops: Stop[]) {
  return stops
    .filter((s) => !isResolved(events, s.id))
    .reduce((total, stop) => {
      if (
        events.some((event) => event.stopId === stop.id && event.kind === "upi")
      )
        return total;
      const collected =
        events.find(
          (event) =>
            event.stopId === stop.id && event.kind === "cash-collected",
        )?.amount ?? 0;
      return total + Math.max(0, stop.cash - collected);
    }, 0);
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

export function nextRouteStop(events: Event[], stops: Stop[]) {
  const remaining = stops.filter((stop) => !isResolved(events, stop.id));
  const selected = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === "next" &&
        event.stopId &&
        !isResolved(events, event.stopId),
    );
  return remaining.find((stop) => stop.id === selected?.stopId) ?? remaining[0];
}

/** Route times are seeded estimates for the demo, not real navigation data. */
export function canOfferDuringRoute(
  events: Event[],
  stops: Stop[],
  now: number,
  offersDuringRoute: boolean,
) {
  const started = events.find((event) => event.kind === "route-start");
  if (!started || events.some((event) => event.kind === "route-completed"))
    return true;
  if (!offersDuringRoute) return false;
  const next = nextRouteStop(events, stops);
  if (!next) return false;
  return now + 360_000 <= started.at + next.windowMinutes * 60_000;
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
