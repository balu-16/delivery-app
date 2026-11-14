import { hasOpenIssue, isResolved, lastActiveOffer } from "./domain";
import { riderDemo } from "./riderDemo";
import { has, stops, useDemo, type Event } from "./store";

export type TaskStatus = "new" | "accepted" | "in-progress" | "completed";
export type DemoTask = {
  id: string;
  order: string;
  name: string;
  address: string;
  items: string;
  distance: string;
  time: string;
  cash: number;
  status: TaskStatus;
  kind: "offer" | "route" | "history";
  offerId?: string;
  completedAt?: number;
};
const offers = [
  {
    id: "sample-1",
    order: "DD8421",
    name: "Suresh Verma",
    address: "Civil Lines, Vijayawada",
    items: "Milk (2 L) · Curd (1 kg)",
    distance: "2.4 km",
    time: "9:30 – 10:00 AM",
    cash: 0,
  },
  {
    id: "sample-2",
    order: "DD8422",
    name: "Priya Singh",
    address: "Lakshmi Nagar, Vijayawada",
    items: "Milk (1 L) · Paneer (250 g)",
    distance: "3.1 km",
    time: "10:00 – 10:30 AM",
    cash: 11000,
  },
  {
    id: "sample-3",
    order: "DD8423",
    name: "Amit Sharma",
    address: "Gandhi Nagar, Vijayawada",
    items: "Milk (2 L) · Curd (500 g)",
    distance: "4.5 km",
    time: "10:15 – 11:00 AM",
    cash: 0,
  },
];

export function demoTasks(events: Event[]): DemoTask[] {
  const sampleTasks: DemoTask[] = offers
    .filter(
      (offer) =>
        !events.some(
          (event) =>
            event.kind === "assignment-rejected" && event.stopId === offer.id,
        ),
    )
    .map((offer) => {
      const link = events.find(
        (event) =>
          event.kind === "assignment-linked" && event.data === offer.id,
      );
      const id = link?.stopId;
      let status: TaskStatus = "new";
      if (id)
        status =
          has(events, "offer-completed", id) || has(events, "offer-failed", id)
            ? "completed"
            : has(events, "offer-hub", id) ||
                has(events, "offer-pickup", id) ||
                has(events, "offer-arrived", id)
              ? "in-progress"
              : "accepted";
      return { ...offer, status, kind: "offer", offerId: id };
    });
  const routeTasks: DemoTask[] = stops.map((stop, index) => ({
    id: stop.id,
    order: `DD84${10 + index}`,
    name: stop.name,
    address: stop.address,
    items: stop.items,
    distance: `${(1.2 + index * 0.5).toFixed(1)} km`,
    time: `${9 + Math.floor(index / 2)}:${index % 2 ? "30" : "00"} AM`,
    cash: stop.cash,
    status: isResolved(events, stop.id)
      ? "completed"
      : has(events, "route-start")
        ? "in-progress"
        : "accepted",
    kind: "route",
  }));
  const history: DemoTask[] = events
    .filter(
      (event) =>
        event.kind === "delivered" &&
        event.stopId?.startsWith("sample-history-"),
    )
    .map((event, index) => ({
      id: event.stopId!,
      order: `DD83${String(index + 1).padStart(2, "0")}`,
      name: ["Nisha Rao", "Rohan Kumar", "Lakshmi Devi"][index % 3],
      address: "Demo neighborhood, Vijayawada",
      items: "Milk (1 L) · Curd",
      distance: "2.0 km",
      time: "9:00 AM",
      cash: 0,
      status: "completed",
      kind: "history",
      completedAt: event.at,
    }));
  return [...sampleTasks, ...routeTasks, ...history];
}

let accepting = false;
export async function acceptDemoAssignment(id: string) {
  if (accepting) throw new Error("ASSIGNMENT_UNAVAILABLE");
  const task = demoTasks(useDemo.getState().events).find(
    (item) => item.id === id && item.status === "new" && item.kind === "offer",
  );
  if (!task) throw new Error("ASSIGNMENT_UNAVAILABLE");
  const initial = useDemo.getState();
  if (lastActiveOffer(initial.events) || hasOpenIssue(initial.events))
    throw new Error("ACTIVE_ASSIGNMENT");
  accepting = true;
  try {
    initial.offer(Date.now() + initial.clockOffset + 25000, task.cash);
    const offerId = useDemo.getState().offerId;
    if (!offerId) throw new Error("ASSIGNMENT_UNAVAILABLE");
    await riderDemo.accept(offerId, `accept:${offerId}`);
    useDemo
      .getState()
      .record({
        id: `link:${offerId}`,
        kind: "assignment-linked",
        stopId: offerId,
        data: id,
      });
  } catch (error) {
    useDemo.getState().offer(null);
    throw error;
  } finally {
    accepting = false;
  }
}

export function rejectDemoAssignment(id: string) {
  const task = demoTasks(useDemo.getState().events).find(
    (item) => item.id === id && item.status === "new" && item.kind === "offer",
  );
  if (!task) return;
  useDemo
    .getState()
    .record({ id: `reject:${id}`, kind: "assignment-rejected", stopId: id });
}
