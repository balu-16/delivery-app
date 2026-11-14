/** Static decorative images are fetched only when their page is rendered. */
const asset = (name: string) => `${import.meta.env.BASE_URL}images/admin/${name}.webp`

export const headerArtwork = {
  dashboard: asset('dashboard'),
  stores: asset('stores'),
  products: asset('products'),
  inventory: asset('inventory'),
  orders: asset('orders'),
  people: asset('people'),
  payments: asset('payments'),
  payouts: asset('payouts'),
  offers: asset('offers-v2'),
  subscriptions: asset('subscriptions'),
  support: asset('support'),
  reports: asset('reports'),
  approvals: asset('approvals'),
  settings: asset('settings'),
} as const

export type HeaderArtwork = keyof typeof headerArtwork
