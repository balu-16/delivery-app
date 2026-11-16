export const profileUser = {
  name: 'Rahul Sharma',
  firstName: 'Rahul',
  phone: '+91 98765 43210',
  email: 'rahul.sharma@gmail.com',
  memberSince: 'March 2024',
  walletBalance: 250,
  loyaltyPoints: 1240,
  verified: true,
  address: 'HSR Layout, Bengaluru',
} as const;

export const profileQuickActions = [
  { key: 'addresses', label: 'Addresses', icon: 'home-outline' },
  { key: 'payments', label: 'Payment Methods', icon: 'card-outline' },
  { key: 'wallet', label: 'Wallet', icon: 'wallet-outline' },
  { key: 'refer', label: 'Refer & Earn', icon: 'gift-outline' },
] as const;

export type ProfileQuickAction = (typeof profileQuickActions)[number];

export type SupportItem = {
  key: string;
  label: string;
  icon: 'headset' | 'help' | 'shield' | 'document' | 'information';
  body: string;
};

export const supportItems: SupportItem[] = [
  {
    key: 'help',
    label: 'Help & Support',
    icon: 'headset',
    body: 'Our farm support team is available every day from 6 AM to 9 PM. Call +91 98765 43210 or write to care@dairydirect.in.',
  },
  {
    key: 'faq',
    label: 'FAQs',
    icon: 'help',
    body: 'Find answers about delivery slots, subscription pauses, bottle returns and payments in the help centre.',
  },
  {
    key: 'privacy',
    label: 'Privacy Policy',
    icon: 'shield',
    body: 'Your address, order history and payment details stay private. We never sell personal data to third parties.',
  },
  {
    key: 'terms',
    label: 'Terms & Conditions',
    icon: 'document',
    body: 'Subscriptions renew every month. Pause until 9 PM for a delivery-free morning. Bottles are reused after sanitisation.',
  },
  {
    key: 'about',
    label: 'About DairyDirect',
    icon: 'information',
    body: 'DairyDirect works with 150+ small farms to bring single-origin milk and dairy to your door within hours of milking.',
  },
];

export type SavedAddress = {
  id: string;
  label: string;
  line1: string;
  line2: string;
  isDefault: boolean;
};

export const savedAddresses: SavedAddress[] = [
  {
    id: 'home',
    label: 'Home',
    line1: '402, Lotus Residency',
    line2: 'HSR Layout, Bengaluru 560102',
    isDefault: true,
  },
  {
    id: 'work',
    label: 'Office',
    line1: 'WeWork Galaxy, Residency Road',
    line2: 'Ashok Nagar, Bengaluru 560025',
    isDefault: false,
  },
];

export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  time: string;
  tint: 'green' | 'peach';
};

export const notifications: NotificationItem[] = [
  {
    id: 'n1',
    title: 'Your milk is on the way',
    body: 'Ravi has picked up your morning crate. ETA 6:42 AM.',
    time: '6:10 AM',
    tint: 'green',
  },
  {
    id: 'n2',
    title: 'May bill is ready',
    body: 'Your 30-delivery subscription bill of ₹1,680 is due on 7 May.',
    time: 'Yesterday',
    tint: 'peach',
  },
  {
    id: 'n3',
    title: 'Weekend pause confirmed',
    body: 'Deliveries on Saturday and Sunday are paused. Resume any time.',
    time: '2 days ago',
    tint: 'green',
  },
];

export const walletTransactions = [
  { id: 'w1', title: 'Cashback · May subscription', amount: 100, type: 'credit', date: '2 May' },
  { id: 'w2', title: 'Referral bonus · Ananya', amount: 100, type: 'credit', date: '28 Apr' },
  { id: 'w3', title: 'Wallet applied · Order #1052', amount: 50, type: 'debit', date: '21 Apr' },
] as const;

export const trustPoints = [
  { key: 'farm', title: '150+ happy farms', body: 'Small, independent dairy farms' },
  { key: 'fresh', title: 'Milked at dawn', body: 'At your door within 4 hours' },
  { key: 'pure', title: 'Nothing added', body: 'No preservatives, ever' },
] as const;
