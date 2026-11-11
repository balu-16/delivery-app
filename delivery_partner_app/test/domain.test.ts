/// <reference types="jest" />
import {
  attemptCount,
  canAcceptCash,
  canOfferDuringRoute,
  hasOpenIssue,
  hubReturnUnits,
  isResolved,
  isValidCount,
  lastActiveOffer,
  openPickupIssue,
  pendingCash,
  pendingAttemptReviews,
  pickupAffectedStops,
  waitRemaining,
} from "../src/domain";
import { stops, type Event } from "../src/store";
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
const event = (id: string, kind: string, stopId?: string, at = 0): Event => ({
  id,
  kind,
  stopId,
  at,
});

test("hub returns exclude items handed to another rider", () => {
  const events: Event[] = [
    event("failed", "failed", "stop-1"),
    { ...event("return", "transferred", "stop-2"), reason: "Returned to hub" },
    {
      ...event("handoff", "transferred", "stop-3"),
      reason: "Demo operations handover",
    },
  ];
  expect(hubReturnUnits(events, stops)).toBe(stops[0].units + stops[1].units);
});

test("partially collected cash remains in the pending amount until UPI covers it", () => {
  const events = [
    { ...event("partial", "cash-collected", "stop-2"), amount: 4000 },
  ];
  expect(pendingCash(events, stops)).toBe(14500);
  events.push({ ...event("upi", "upi", "stop-2"), amount: 7000 });
  expect(pendingCash(events, stops)).toBe(7500);
});

test("pickup discrepancies can be resolved and reported again with affected stops", () => {
  const events: Event[] = [
    { ...event("first", "pickup-issue"), data: "curd" },
    event("resolution", "pickup-resolved"),
    { ...event("second", "pickup-issue"), data: "paneer" },
  ];
  const issue = openPickupIssue(events);
  expect(issue?.id).toBe("second");
  expect(pickupAffectedStops(issue!, stops).map((stop) => stop.id)).toEqual([
    "stop-4",
  ]);
  events.push(event("resolution-2", "pickup-resolved"));
  expect(openPickupIssue(events)).toBeUndefined();
});

test("only whole-number counts within the demo range are accepted", () => {
  expect(isValidCount("", true)).toBe(true);
  for (const value of ["0", "12", "999"])
    expect(isValidCount(value)).toBe(true);
  for (const value of ["", "-1", "1.5", "1000", "oops"])
    expect(isValidCount(value)).toBe(false);
});

test("ambiguous failed attempts remain pending review", () => {
  expect(
    pendingAttemptReviews([
      { ...event("unknown", "failed", "stop-1"), reason: "Other" },
      {
        ...event("eligible", "failed", "stop-2"),
        reason: "Customer unavailable",
      },
      { ...event("partner", "failed", "stop-3"), reason: "Partner at fault" },
    ]),
  ).toBe(1);
});

test("route offers respect the next stop deadline and opt-out", () => {
  const events = [event("start", "route-start", undefined, 1_000)];
  expect(canOfferDuringRoute(events, stops, 1_000, true)).toBe(true);
  expect(canOfferDuringRoute(events, stops, 1_000, false)).toBe(false);
  expect(canOfferDuringRoute(events, stops, 31 * 60_000, true)).toBe(false);
  events.push(event("done", "route-completed"));
  expect(canOfferDuringRoute(events, stops, 31 * 60_000, false)).toBe(true);
});
test("cash offer limits include assigned unpaid stops", () => {
  const pending = pendingCash([], stops);
  expect(pending).toBe(18500);
  expect(canAcceptCash(10000, pending, 25000, 50000)).toBe(false);
  expect(canAcceptCash(10000, pending, 0, 50000)).toBe(true);
});
test("stop wait counts only contacts after arrival and handles deferral", () => {
  const events = [
    event("old", "contact", "stop-2", 1),
    event("arr", "arrived", "stop-2", 100),
    event("c1", "contact", "stop-2", 200),
    event("defer", "next", "stop-3", 300),
  ];
  expect(attemptCount(events, "stop-2")).toBe(1);
  expect(waitRemaining(events, "stop-2", 100100)).toBe(200000);
  expect(isResolved(events, "stop-2")).toBe(false);
});
test("detours and safety issues retain their own event lifecycles", () => {
  const events = [
    event("a", "offer-accepted", "offer-1"),
    event("b", "offer-completed", "offer-1"),
    event("c", "offer-accepted", "offer-2"),
    event("d", "issue"),
  ];
  expect(lastActiveOffer(events)?.stopId).toBe("offer-2");
  expect(hasOpenIssue(events)).toBe(true);
  events.push(event("e", "issue-resolved"));
  expect(hasOpenIssue(events)).toBe(false);
});

test("a later failed distance check overrides an earlier passing check", () => {
  const events = [
    event("near", "distance-near", "stop-1"),
    event("far", "distance-far", "stop-1"),
  ];
  expect(require("../src/domain").distancePassed(events, "stop-1")).toBe(false);
  events.push(event("near-2", "distance-near", "stop-1"));
  expect(require("../src/domain").distancePassed(events, "stop-1")).toBe(true);
});
