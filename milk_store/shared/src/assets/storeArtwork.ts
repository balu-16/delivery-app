/** Images are requested only when their section is rendered. */
const asset = (name: string) => `${import.meta.env.BASE_URL}images/store/${name}.webp`

export const storeArtwork = {
  dashboard: asset('dashboard'),
  ordersPicking: asset('orders-picking'),
  inventory: asset('inventory'),
  returns: asset('returns'),
  riderApplications: asset('rider-applications'),
  codDeposits: asset('cod-deposits'),
  storeStatus: asset('store-status'),
  staffWorkload: asset('staff-workload'),
  notifications: asset('notifications'),
} as const

export type StoreArtwork = keyof typeof storeArtwork
