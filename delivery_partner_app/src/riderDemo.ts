import type { components } from "./rider-api.generated";
import { canAcceptCash, lastActiveOffer, pendingCash } from "./domain";
import { has, stops, useDemo } from "./store";

type Schemas = components["schemas"];
type Task = Schemas["DeliveryTaskView"];
type OfferPage = Schemas["OfferPageView"];
type NextStatus = "AT_STORE" | "PICKED_UP" | "ARRIVED" | "DELIVERED" | "FAILED";

/** The local adapter returns the documented rider DTOs; route extensions stay local. */
export interface RiderTransport {
  offers(): Promise<OfferPage>;
  current(): Promise<Task | null>;
  accept(offerId: string, actionId: string): Promise<Task>;
  advance(
    taskId: string,
    status: NextStatus,
    actionId: string,
    proof?: Schemas["DeliverDto"] | Schemas["FailDto"],
  ): Promise<Task>;
}

const uuid = "00000000-0000-4000-8000-000000000001";
function taskView(id: string): Task {
  const events = useDemo.getState().events;
  const at = (kind: string) => {
    const event = events.find((e) => e.kind === kind && e.stopId === id);
    return event ? new Date(event.at).toISOString() : null;
  };
  const status: Task["status"] = at("offer-failed")
    ? "FAILED"
    : at("offer-completed")
      ? "DELIVERED"
      : at("offer-arrived")
        ? "ARRIVED"
        : at("offer-pickup")
          ? "PICKED_UP"
          : at("offer-hub")
            ? "AT_STORE"
            : "ASSIGNED";
  return {
    id,
    orderId: uuid,
    storeId: uuid,
    status,
    riderId: uuid,
    attemptNo: 1,
    pickupAt: at("offer-pickup"),
    arrivedStoreAt: at("offer-hub"),
    arrivedCustomerAt: at("offer-arrived"),
    deliveredAt: at("offer-completed"),
    codAmountPaise:
      (events.find((e) => e.kind === "offer-accepted" && e.stopId === id)
        ?.amount ?? 0) > 0
        ? String(
            events.find((e) => e.kind === "offer-accepted" && e.stopId === id)!
              .amount,
          )
        : null,
    handoverCode: null,
    version: "1",
  };
}
export const riderDemo: RiderTransport = {
  async offers() {
    const state = useDemo.getState();
    if (
      !state.hydrated ||
      !state.offerId ||
      !state.offerExpiresAt ||
      state.offerExpiresAt <= Date.now() + state.clockOffset
    )
      return { items: [] };
    return {
      items: [
        {
          offerId: state.offerId,
          taskId: state.offerId,
          orderId: uuid,
          storeId: uuid,
          attemptNo: 1,
          expiresAt: new Date(state.offerExpiresAt).toISOString(),
          codAmountPaise: state.offerCash ? String(state.offerCash) : null,
        },
      ],
    };
  },
  async current() {
    const active = lastActiveOffer(useDemo.getState().events);
    return active?.stopId ? taskView(active.stopId) : null;
  },
  async accept(offerId, actionId) {
    const state = useDemo.getState();
    const previous = state.events.find((e) => e.id === actionId);
    if (previous) {
      if (previous.kind !== "offer-accepted" || previous.stopId !== offerId)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return taskView(offerId);
    }
    const offer = (await this.offers()).items.find(
      (item) => item.offerId === offerId,
    );
    if (!offer || !state.signal || lastActiveOffer(state.events))
      throw new Error("OFFER_UNAVAILABLE");
    const held = state.events.reduce(
      (n, e) =>
        n +
        (e.kind === "cash-collected"
          ? (e.amount ?? 0)
          : e.kind === "cash-handover"
            ? -(e.amount ?? 0)
            : 0),
      0,
    );
    if (!canAcceptCash(held, pendingCash(state.events, stops), state.offerCash))
      throw new Error("CASH_LIMIT_EXCEEDED");
    state.record({
      id: actionId,
      kind: "offer-accepted",
      stopId: offerId,
      amount: state.offerCash,
    });
    state.offer(null);
    return taskView(offerId);
  },
  async advance(taskId, status, actionId, proof) {
    const state = useDemo.getState();
    const kinds: Record<NextStatus, string> = {
      AT_STORE: "offer-hub",
      PICKED_UP: "offer-pickup",
      ARRIVED: "offer-arrived",
      DELIVERED: "offer-completed",
      FAILED: "offer-failed",
    };
    const previous = state.events.find((e) => e.id === actionId);
    if (previous) {
      if (
        previous.kind !== kinds[status] ||
        previous.stopId !== taskId ||
        (status === "FAILED" &&
          proof &&
          "reason" in proof &&
          previous.reason !== proof.reason) ||
        (status === "DELIVERED" &&
          (!proof ||
            !("deliveryCode" in proof) ||
            proof.deliveryCode !== "1234"))
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return taskView(taskId);
    }
    const active = lastActiveOffer(state.events);
    if (active?.stopId !== taskId) {
      if (state.events.some((e) => e.id === actionId)) return taskView(taskId);
      throw new Error("TASK_UNAVAILABLE");
    }
    const current = taskView(taskId).status;
    const expected: Record<NextStatus, Task["status"]> = {
      AT_STORE: "ASSIGNED",
      PICKED_UP: "AT_STORE",
      ARRIVED: "PICKED_UP",
      DELIVERED: "ARRIVED",
      FAILED: "ARRIVED",
    };
    if (current !== expected[status]) throw new Error("TASK_STATE_INVALID");
    if (
      status === "DELIVERED" &&
      (!proof || !("deliveryCode" in proof) || proof.deliveryCode !== "1234")
    )
      throw new Error("DELIVERY_PROOF_REQUIRED");
    if (
      status === "DELIVERED" &&
      (active.amount ?? 0) > 0 &&
      (state.events.find(
        (e) => e.kind === "cash-collected" && e.stopId === taskId,
      )?.amount ?? 0) < (active.amount ?? 0) &&
      !has(state.events, "upi", taskId)
    )
      throw new Error("PAYMENT_REQUIRED");
    state.record({
      id: actionId,
      kind: kinds[status],
      stopId: taskId,
      reason: proof && "reason" in proof ? proof.reason : undefined,
    });
    return taskView(taskId);
  },
};
