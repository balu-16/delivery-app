export type DeliveryDay = {
  label: string;
  active: boolean;
};

export type SubscriptionPlan = {
  id: string;
  title: string;
  productId: string;
  productName: string;
  size: string;
  farm: string;
  window: string;
  bottleCount: number;
  dailyPrice: number;
  monthlyTotal: number;
  deliveriesThisMonth: number;
  nextDeliveryLabel: string;
  nextDeliveryTime: string;
  cycleLabel: string;
  days: DeliveryDay[];
};

export const subscriptionPlan: SubscriptionPlan = {
  id: 'sub-a2-daily',
  title: 'Daily Milk Subscription',
  productId: 'a2-cow-milk',
  productName: 'A2 Cow Milk',
  size: '1 Litre',
  farm: 'Green Valley Farms',
  window: '6:00 AM - 7:00 AM',
  bottleCount: 1,
  dailyPrice: 56,
  monthlyTotal: 1680,
  deliveriesThisMonth: 16,
  nextDeliveryLabel: 'Tomorrow, 6 May',
  nextDeliveryTime: '6:00 AM - 7:00 AM',
  cycleLabel: '1 May - 31 May',
  days: [
    { label: 'M', active: true },
    { label: 'T', active: true },
    { label: 'W', active: true },
    { label: 'T', active: true },
    { label: 'F', active: true },
    { label: 'S', active: false },
    { label: 'S', active: false },
  ],
};

export type SubscriptionOrder = {
  id: string;
  title: string;
  date: string;
  items: string;
  amount: number;
  status: 'Delivered' | 'Scheduled' | 'Cancelled';
};

export const subscriptionOrders: SubscriptionOrder[] = [
  {
    id: 'ORD-1058',
    title: 'Morning delivery',
    date: 'Tomorrow · 6:00 AM',
    items: 'A2 Cow Milk · 1 Litre',
    amount: 56,
    status: 'Scheduled',
  },
  {
    id: 'ORD-1057',
    title: 'Morning delivery',
    date: 'Today · 6:42 AM',
    items: 'A2 Cow Milk · 1 Litre',
    amount: 56,
    status: 'Delivered',
  },
  {
    id: 'ORD-1056',
    title: 'Weekly top-up',
    date: '3 May · 8:10 AM',
    items: 'Paneer · 200 gm, Desi Ghee · 500 ml',
    amount: 400,
    status: 'Delivered',
  },
  {
    id: 'ORD-1055',
    title: 'Morning delivery',
    date: '2 May · 6:35 AM',
    items: 'A2 Cow Milk · 1 Litre',
    amount: 56,
    status: 'Delivered',
  },
];

export type DeliverySchedule = {
  day: string;
  date: string;
  milk: boolean;
  extras?: string;
  status: 'Delivered' | 'Scheduled' | 'Paused';
};

export const deliverySchedule: DeliverySchedule[] = [
  { day: 'Mon', date: '5', milk: true, status: 'Delivered' },
  { day: 'Tue', date: '6', milk: true, status: 'Scheduled' },
  { day: 'Wed', date: '7', milk: true, extras: 'Paneer 200 g', status: 'Scheduled' },
  { day: 'Thu', date: '8', milk: true, status: 'Scheduled' },
  { day: 'Fri', date: '9', milk: true, extras: 'Ghee 500 ml', status: 'Scheduled' },
  { day: 'Sat', date: '10', milk: false, status: 'Paused' },
  { day: 'Sun', date: '11', milk: false, status: 'Paused' },
];

export type DairyBill = {
  id: string;
  month: string;
  period: string;
  amount: number;
  deliveries: number;
  status: 'Paid' | 'Due';
};

export const dairyBills: DairyBill[] = [
  {
    id: 'BILL-2026-05',
    month: 'May 2026',
    period: '1 - 31 May',
    amount: 1680,
    deliveries: 30,
    status: 'Due',
  },
  {
    id: 'BILL-2026-04',
    month: 'April 2026',
    period: '1 - 30 April',
    amount: 1624,
    deliveries: 29,
    status: 'Paid',
  },
  {
    id: 'BILL-2026-03',
    month: 'March 2026',
    period: '1 - 31 March',
    amount: 1736,
    deliveries: 31,
    status: 'Paid',
  },
];

export const dairyQuickActions = [
  { key: 'manage', label: 'Manage', icon: 'settings-outline' },
  { key: 'pause', label: 'Pause', icon: 'pause-circle-outline' },
  { key: 'vacation', label: 'Set Vacation', icon: 'umbrella-outline' },
  { key: 'quantity', label: 'Change Quantity', icon: 'bag-handle-outline' },
] as const;

export type DairyQuickAction = (typeof dairyQuickActions)[number];
