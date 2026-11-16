import type {
  DB, Store, City, Zone, WorkforceAccount, StoreManagerAssignment, Order, OrderItem, PickingTask,
  PickLine, PickingTaskStatus, ReturnParcel, RiderApplication, CodDeposit, InventoryBatch, StockReceipt, StockCount,
  StockAdjustment, StoreStatusChange, StoreNotification, Rider, ProductIcon,
} from '../types'
import { wfAp2Id as WF_AP2, wfAp3Id as WF_AP3, wfAp4Id as WF_AP4, wfAp5Id as WF_AP5 } from './staffIds'
import type { RNG } from './rng'
import { int, pick, chance } from './rng'

// Everything the Store Manager Portal needs, seeded into the SAME dataset the admin
// portal reads. Store-scoped: the two AP stores + their tasks/returns/applications/
// deposits/inventory. All figures reconcile (see task corrections in the spec).

type NewKeys = 'storeManagers' | 'binLocations' | 'pickingTasks' | 'returns' | 'riderApplications' | 'codDeposits' | 'inventoryBatches' | 'stockReceipts' | 'stockCounts' | 'stockAdjustments' | 'storeStatusChanges' | 'storeNotifications' | 'storeNotificationPrefs'
type SeedBase = Omit<DB, NewKeys> & Partial<Pick<DB, NewKeys>>

const iso = (d: Date) => d.toISOString()
const D = (day: number, hh: number, mm: number) => iso(new Date(2026, 0, day, hh, mm))
const plusMin = (d: Date, mins: number) => iso(new Date(d.getTime() + mins * 60000))
const r5 = (n: number) => Math.round(n / 5) * 5

const iconFor = (productName: string): ProductIcon => {
  const n = productName.toLowerCase()
  if (n.includes('milk') && !n.includes('flavored')) return 'milk'
  if (n.includes('paneer')) return 'paneer'
  if (n.includes('ghee')) return 'ghee'
  if (n.includes('curd')) return 'curd'
  if (n.includes('butter')) return 'butter'
  if (n.includes('lassi')) return 'lassi'
  if (n.includes('chaas') || n.includes('buttermilk')) return 'buttermilk'
  if (n.includes('cream')) return 'cream'
  if (n.includes('cheese')) return 'cheese'
  if (n.includes('khoya')) return 'khoya'
  if (n.includes('tofu')) return 'paneer'
  return 'flavored_milk'
}

export function buildStorePortalData(db: SeedBase, rng: RNG): void {
  // ── City + AP stores ────────────────────────────────────────
  const guntur: City = { id: 'guntur', name: 'Guntur', coords: [16.3067, 80.4365] }
  db.cities = [...db.cities, guntur]
  const apStores: Store[] = [
    { id: 'st-ap1', code: 'ST-0045', name: 'SRM AP Store', location: 'SRM University AP, Neerukonda, Guntur', cityId: 'guntur', coords: [16.3067, 80.4365], capacityOrdersPerDay: 120, status: 'online', codAvailable: true, legalEntityId: 'le-1', managerIds: ['wf-chn', 'wf-ap2', 'wf-ap3', 'wf-ap4', 'wf-ap5', 'wf-ap6'], openedOn: '2025-08-01', imageVariant: 2, hours: [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, open: '06:00', close: '22:00' })), holidays: [{ date: '2026-01-26', name: 'Republic Day' }], pickingBacklog: 18, note: 'A store manager can pause/resume their own store; the admin controls wider configuration.' },
    { id: 'st-ap2', code: 'ST-0046', name: 'Guntur Central Store', location: 'Arundelpet, Guntur, Andhra Pradesh', cityId: 'guntur', coords: [16.3120, 80.4300], capacityOrdersPerDay: 90, status: 'online', codAvailable: true, legalEntityId: 'le-1', managerIds: ['wf-chn'], openedOn: '2025-11-15', imageVariant: 5, hours: [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, open: '06:30', close: '21:30' })), holidays: [], pickingBacklog: 5, note: 'A store manager can pause/resume their own store; the admin controls wider configuration.' },
  ]
  db.stores = [...db.stores, ...apStores]

  const apZones: Zone[] = [
    { id: 'z-guntur-1', storeId: 'st-ap1', cityId: 'guntur', name: 'Neerukonda Zone', priority: 1, pincodes: '522 240', polygon: [[16.289, 80.418], [16.322, 80.425], [16.328, 80.452], [16.295, 80.458]] },
    { id: 'z-guntur-2', storeId: 'st-ap2', cityId: 'guntur', name: 'Guntur Central Zone', priority: 2, pincodes: '522 004', polygon: [[16.300, 80.428], [16.318, 80.431], [16.321, 80.444], [16.303, 80.447]] },
  ]
  db.zones = [...db.zones, ...apZones]

  // ── Workforce: signed-in manager + AP staff (with passwords) ──
  const wfChn: WorkforceAccount = { id: 'wf-chn', name: 'Chaitanya Raju', email: 'chaitanya.raju@srm.edu.in', phone: '+91 90000 40001', role: 'store_manager', storeId: 'st-ap1', status: 'active', lastLogin: D(24, 8, 5), joinedOn: '2025-08-01', avatar: 4, password: 'Store@123' }
  const apStaff: WorkforceAccount[] = [
    { id: 'wf-ap2', name: 'Vikram Varma', email: 'vikram.varma@dairydirect.in', phone: '+91 90000 40002', role: 'store_manager', storeId: 'st-ap1', status: 'active', lastLogin: D(24, 7, 40), joinedOn: '2025-08-10', avatar: 5, password: 'Store@123' },
    { id: 'wf-ap3', name: 'Sneha Yadav', email: 'sneha.yadav@dairydirect.in', phone: '+91 90000 40003', role: 'store_manager', storeId: 'st-ap1', status: 'active', lastLogin: D(24, 7, 25), joinedOn: '2025-08-10', avatar: 7, password: 'Store@123' },
    { id: 'wf-ap4', name: 'Arjun Reddy', email: 'arjun.reddy@dairydirect.in', phone: '+91 90000 40004', role: 'store_manager', storeId: 'st-ap1', status: 'active', lastLogin: D(23, 19, 10), joinedOn: '2025-09-02', avatar: 9, password: 'Store@123' },
    { id: 'wf-ap5', name: 'Meera Nair', email: 'meera.nair@dairydirect.in', phone: '+91 90000 40005', role: 'store_manager', storeId: 'st-ap1', status: 'active', lastLogin: D(23, 18, 45), joinedOn: '2025-09-02', avatar: 11, password: 'Store@123' },
    { id: 'wf-ap6', name: 'Nithin Sai', email: 'nithin.sai@dairydirect.in', phone: '+91 90000 40006', role: 'store_manager', storeId: 'st-ap1', status: 'inactive' as WorkforceAccount['status'], lastLogin: D(12, 16, 20), joinedOn: '2025-10-11', avatar: 2, password: 'Store@123' },
  ]
  db.workforce = [...db.workforce, wfChn, ...apStaff]
  // set passwords for existing accounts (demo sign-in)
  db.workforce = db.workforce.map((w) => ({ ...w, password: w.password ?? (w.role === 'admin' ? 'Admin@123' : w.role === 'support_agent' ? 'Support@123' : 'Store@123') }))

  const storeManagers: StoreManagerAssignment[] = [
    { id: 'sm-1', workforceId: 'wf-chn', storeId: 'st-ap1' },
    { id: 'sm-2', workforceId: 'wf-chn', storeId: 'st-ap2' },
    ...apStaff.map((w, i) => ({ id: `sm-ap${i + 3}`, workforceId: w.id, storeId: 'st-ap1' })),
    ...db.stores.filter((s) => !s.id.startsWith('st-ap')).map((s, i) => ({ id: `sm-${s.id}`, workforceId: `wf-${i + 2}`, storeId: s.id })),
  ]
  db.storeManagers = storeManagers

  // ── AP customers (order-facing names) ───────────────────────
  const apCustomerNames = ['Ananya Rao', 'Vikram Rane', 'Sneha More', 'Arjun Das', 'Meera Iyer', 'Karthik Malladi', 'Divya Sri', 'Rohan Pillai']
  const apCustomers = apCustomerNames.map((name, i) => ({
    id: `C${90001 + i}`, name,
    phone: `+91 9${String(500000000 + i * 1111111).slice(0, 9)}`,
    email: name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.') + '@gmail.com',
    cityId: 'guntur', avatar: i % 12, joinedOn: `202${5 + (i % 2)}-0${1 + (i % 9)}-14`,
    status: 'active' as const,
  }))
  db.customers = [...db.customers, ...apCustomers]
  const allCustomers = [...db.customers]

  // ── AP catalog helpers ──────────────────────────────────────
  const apVariants = db.variants.map((v) => ({ v, product: db.products.find((p) => p.id === v.productId)! }))
  const apStoreVariants = apVariants.filter(({ v }) => v.price <= 300).slice(0, 24) // what the AP stores carry
  for (const sv of db.storeVariants) {
    if (sv.storeId === 'st-ap1' || sv.storeId === 'st-ap2') continue
  }
  db.storeVariants = [
    ...db.storeVariants,
    ...apStoreVariants.map(({ v }) => ({ variantId: v.id, storeId: 'st-ap1', available: true, priceOverride: null })),
    ...apStoreVariants.slice(0, 18).map(({ v }) => ({ variantId: v.id, storeId: 'st-ap2', available: true, priceOverride: null })),
  ]
  const variantOf = (vid: string) => apVariants.find((x) => x.v.id === vid)!

  // ── AP riders (approved riders power handover + COD) ─────────
  const applicantFirst = ['Rohit', 'Sandeep', 'Arjun', 'Vikram', 'Karthik', 'Nithin', 'Suresh', 'Mahesh', 'Ganesh', 'Naresh', 'Ramesh', 'Harish', 'Naveen', 'Praveen', 'Lokesh', 'Manish', 'Kiran', 'Raghu', 'Sunil', 'Anil', 'Kalyan', 'Vamsi', 'Tarun', 'Nikhil']
  const applicantLast = ['Kumar', 'Reddy', 'Naik', 'Rao']
  const applicantName = (i: number) => `${applicantFirst[i % 24]} ${applicantLast[Math.floor(i / 24) % 4]}`

  // rider applications (48): 7 pending / 4 under review / 32 approved / 5 rejected
  const riderApplications: RiderApplication[] = []
  const approvedRiderNames: string[] = []
  for (let i = 0; i < 48; i++) {
    const status: RiderApplication['status'] = i < 7 ? 'pending' : i < 11 ? 'under_review' : i < 43 ? 'approved' : 'rejected'
    const name = applicantName(i)
    if (status === 'approved') approvedRiderNames.push(name)
    const day = i < 7 ? 24 : i < 11 ? 24 - 1 - (i % 3) : 24 - 3 - (i % 17)
    const docs = (['license', 'vehicle_rc', 'aadhaar', 'insurance'] as const).map((type, k) => {
      const label = { license: 'Driving License', vehicle_rc: 'Vehicle Registration Certificate', aadhaar: 'Identity Proof (Aadhaar)', insurance: 'Vehicle Insurance' }[type]
      let docStatus: RiderApplication['documents'][number]['status'] = 'pending'
      if (status === 'approved') docStatus = 'approved'
      else if (status === 'under_review') docStatus = k < (i % 3) + 1 ? 'approved' : 'pending'
      else if (status === 'rejected') docStatus = k === 3 ? 'rejected' : 'approved'
      return {
        type, label,
        number: type === 'license' ? `DL-${int(rng, 10000000, 99999999)}`
          : type === 'vehicle_rc' ? `AP${int(rng, 10, 39)} ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i + 3) % 26))} ${int(rng, 1000, 9999)}`
          : type === 'aadhaar' ? `XXXX-XXXX-${int(rng, 1000, 9999)}`
          : `INS-${int(rng, 10000000, 99999999)}`,
        status: docStatus,
        decidedAt: docStatus !== 'pending' ? D(day, int(rng, 9, 18), int(rng, 0, 59)) : undefined,
        reason: docStatus === 'rejected' ? 'Document expired — rider to re-upload' : undefined,
      }
    })
    riderApplications.push({
      id: `APP-${1058 - i}`, storeId: 'st-ap1', riderName: name,
      phone: `+91 9${String(600000000 + i * 9876543).slice(0, 9)}`,
      email: name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.') + '@gmail.com',
      vehicle: { type: pick(rng, ['Motorcycle', 'Scooter']), makeModel: pick(rng, ['Hero Splendor+', 'Honda Activa 6G', 'TVS Jupiter', 'Bajaj Chetak', 'TVS iQube']), registration: `AP${int(rng, 10, 39)} ${String.fromCharCode(65 + (i % 26))} ${int(rng, 1000, 9999)}`, color: pick(rng, ['Black', 'Blue', 'Grey', 'Red']), year: 2021 + (i % 5) },
      appliedAt: D(day, int(rng, 9, 12), int(rng, 0, 59)),
      status, documents: docs,
    })
  }
  db.riderApplications = riderApplications

  const apRiders: Rider[] = approvedRiderNames.slice(0, 12).map((name, i) => ({
    id: `rd-ap${i + 1}`, name, phone: `+91 9${String(700000000 + i * 1212121).slice(0, 9)}`, avatar: i % 12,
    storeId: 'st-ap1', status: 'active', appliedOn: '2025-11-02', vehicle: pick(rng, ['Activa', 'Splendor+', 'iQube', 'Jupiter']),
    documents: [
      { type: 'license', status: 'verified' }, { type: 'id_proof', status: 'verified' }, { type: 'bank_details', status: 'verified' },
    ],
    reviewedByStoreManager: true, deliveriesPeriod: 120 + ((i * 17) % 120), rating: +(4.3 + (i % 6) * 0.1).toFixed(1),
  }))
  db.riders = [...db.riders, ...apRiders]

  // ── AP orders + picking tasks ───────────────────────────────
  const orders: Order[] = []
  const pickingTasks: PickingTask[] = []
  let ordNo = 78401
  let pickNo = 7840

  const makeLines = (count: number, pickedCount: number, opts: { unavailableAt?: number; substituteAt?: number } = {}): PickLine[] => {
    const lines: PickLine[] = []
    const chosen = [...apStoreVariants].sort(() => rng() - 0.5).slice(0, count)
    for (let i = 0; i < count; i++) {
      const { v, product } = chosen[i]!
      const batch = `B${String(int(rng, 1000, 9999))}`
      const expiry = D(int(rng, 26, 60), 9, 0)
      const qtyOrdered = int(rng, 1, 3)
      const isPicked = i < pickedCount
      const isUnavailable = opts.unavailableAt === i
      const isSubstitute = opts.substituteAt === i
      lines.push({
        id: `pl-${ordNo}-${i + 1}`,
        variantId: v.id,
        name: `${product.name} – ${v.label}`,
        icon: iconFor(product.name),
        qtyOrdered,
        qtyPicked: isPicked ? qtyOrdered : 0,
        batchId: batch,
        batchExpiry: expiry,
        substitutionVariantId: isSubstitute ? 'v-131' : undefined, // Tofu – 200 g
        unavailableReason: isUnavailable ? pick(rng, ['Damaged pack in cold storage', 'Not received in morning stock']) : undefined,
        resolved: isPicked || isUnavailable || isSubstitute,
      })
    }
    return lines
  }

  const pushOrderAndTask = (opts: {
    status: PickingTaskStatus
    placed: [number, number, number]
    deadline?: [number, number]
    assignee?: string
    items?: number
    picked?: number
    lines?: PickLine[]
    completedAt?: string
    unavailableAt?: number
    substituteAt?: number
  }) => {
    const orderId = `ORD-${ordNo++}`
    const cust = pick(rng, apCustomers)
    const placed = new Date(2026, 0, opts.placed[0], opts.placed[1], opts.placed[2])
    const lineCount = opts.lines?.length ?? opts.items ?? int(rng, 3, 8)
    const lines = opts.lines ?? makeLines(lineCount, opts.picked ?? 0, { unavailableAt: opts.unavailableAt, substituteAt: opts.substituteAt })
    const itemsSubtotal = lines.reduce((a, l) => a + l.qtyOrdered * (l.substitutionVariantId ? apVariants.find((x) => x.v.id === l.substitutionVariantId)!.v.price : variantOf(l.variantId)!.v.price), 0)
    const amount = r5(itemsSubtotal + (itemsSubtotal < 499 ? 40 : 0)) || 240
    const items: OrderItem[] = lines.map((l) => ({ variantId: l.variantId, name: l.name, qty: l.qtyOrdered, price: variantOf(l.variantId)!.v.price, total: l.qtyOrdered * variantOf(l.variantId)!.v.price }))
    const fee = amount < 499 ? 40 : 0
    const taskId = `PICK-${pickNo++}`
    const adminStatus = opts.status === 'waiting_to_pick' ? 'placed'
      : opts.status === 'being_picked' ? 'picking'
      : opts.status === 'ready_to_pack' ? 'ready'
      : opts.status === 'ready_for_handover' ? 'out_for_delivery'
      : 'delivered'
    const deadline = opts.deadline ? D(24, opts.deadline[0], opts.deadline[1]) : D(24, int(rng, 12, 16), int(rng, 0, 59))
    const rider = opts.status === 'ready_for_handover' ? db.riders.find((r) => r.storeId === 'st-ap1') : null
    orders.push({
      id: orderId, storeId: 'st-ap1', customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
      customerAvatar: cust.avatar, amount: r5(amount) || 240, deliveryFee: fee, discount: 0,
      paymentMethod: chance(rng, 0.3) ? 'cod' : pick(rng, ['online_upi', 'online_upi', 'online_card', 'wallet'] as const),
      status: adminStatus as Order['status'], placedAt: iso(placed),
      riderId: rider?.id ?? null, deliveryCode: String(int(rng, 1000, 9999)), deliveryCodeLocked: false,
      requiresAttention: false, correctionRequests: [], items,
      timeline: { placed: iso(placed), confirmed: plusMin(placed, 5) },
    })
    pickingTasks.push({
      id: taskId, orderId, storeId: 'st-ap1', status: opts.status,
      assigneeId: opts.assignee ?? (opts.status === 'waiting_to_pick' ? null : pick(rng, [WF_AP2, WF_AP3, WF_AP4, WF_AP5])),
      claimedAt: opts.assignee || opts.status !== 'waiting_to_pick' ? plusMin(placed, 4) : undefined,
      deadline,
      createdAt: iso(placed), lines,
      packing: opts.status === 'ready_to_pack' || opts.status === 'ready_for_handover' ? { bags: int(rng, 1, 3), coldChain: chance(rng, 0.6), packedBy: 'Store staff', notes: undefined } : undefined,
      handover: opts.status === 'ready_for_handover' && rider ? { riderId: rider.id, riderName: rider.name, code: String(int(rng, 1000, 9999)), attempts: 0 } : undefined,
      completedAt: opts.completedAt,
    })
  }

  // being picked: assignees 4/4/3/1 = 12 (Vikram, Sneha, Arjun, Meera)
  const beingPickedAssignees = [WF_AP2, WF_AP2, WF_AP2, WF_AP2, WF_AP3, WF_AP3, WF_AP3, WF_AP3, WF_AP4, WF_AP4, WF_AP4, WF_AP5]
  // 3 overdue (deadlines already past) — 2 being picked + 1 waiting
  pushOrderAndTask({ status: 'being_picked', placed: [24, 9, 5], deadline: [10, 30], assignee: beingPickedAssignees[0], items: 5, picked: 2 })
  pushOrderAndTask({ status: 'being_picked', placed: [24, 9, 12], deadline: [10, 45], assignee: beingPickedAssignees[1], items: 6, picked: 3 })
  pushOrderAndTask({ status: 'waiting_to_pick', placed: [24, 9, 20], deadline: [10, 50], items: 4 })
  // 3 due soon
  pushOrderAndTask({ status: 'being_picked', placed: [24, 9, 30], deadline: [11, 15], assignee: beingPickedAssignees[2], items: 4, picked: 1 })
  pushOrderAndTask({ status: 'waiting_to_pick', placed: [24, 9, 40], deadline: [11, 20], items: 5 })
  pushOrderAndTask({ status: 'waiting_to_pick', placed: [24, 9, 45], deadline: [11, 25], items: 3 })
  // the crafted screenshot task: ORD-78422 → 8 lines, 2 picked, Paneer unavailable + Tofu substitute, Butter 0/2
  pushOrderAndTask({
    status: 'being_picked', placed: [24, 10, 20], deadline: [12, 45], assignee: beingPickedAssignees[3], picked: 2,
    lines: [
      { id: 'pl-x1', variantId: 'v-012', name: 'Cow Milk – 1 L', icon: 'milk', qtyOrdered: 2, qtyPicked: 2, batchId: 'ML-2403', batchExpiry: D(28, 9, 0), resolved: true },
      { id: 'pl-x2', variantId: 'v-101', name: 'Curd – 400 g', icon: 'curd', qtyOrdered: 1, qtyPicked: 1, batchId: 'CR-1124', batchExpiry: D(26, 9, 0), resolved: true },
      { id: 'pl-x3', variantId: 'v-061', name: 'Paneer – 200 g', icon: 'paneer', qtyOrdered: 1, qtyPicked: 0, batchId: 'PN-0903', batchExpiry: D(24, 9, 0), unavailableReason: 'Damaged pack in cold storage', substitutionVariantId: 'v-131', resolved: true },
      { id: 'pl-x4', variantId: 'v-121', name: 'Butter – 500 g', icon: 'butter', qtyOrdered: 2, qtyPicked: 0, batchId: 'BT-7781', batchExpiry: D(2, 9, 0) + ' ', resolved: false },
      { id: 'pl-x5', variantId: 'v-011', name: 'Cow Milk – 500 ml', icon: 'milk', qtyOrdered: 1, qtyPicked: 0, batchId: 'ML-2410', batchExpiry: D(28, 9, 0), resolved: false },
      { id: 'pl-x6', variantId: 'v-081', name: 'Ghee – 500 ml', icon: 'ghee', qtyOrdered: 1, qtyPicked: 0, batchId: 'GH-4401', batchExpiry: D(45, 9, 0), resolved: false },
      { id: 'pl-x7', variantId: 'v-111', name: 'Sweet Lassi – 200 ml', icon: 'lassi', qtyOrdered: 2, qtyPicked: 0, batchId: 'LS-2201', batchExpiry: D(6, 9, 0), resolved: false },
      { id: 'pl-x8', variantId: 'v-021', name: 'Toned Milk – 500 ml', icon: 'milk', qtyOrdered: 1, qtyPicked: 0, batchId: 'TM-1802', batchExpiry: D(28, 9, 0), resolved: false },
    ],
  })
  // remaining waiting (15 more → 18 total), being picked (8 more → 12), ready to pack (21), ready for handover (12)
  for (let k = 0; k < 15; k++) pushOrderAndTask({ status: 'waiting_to_pick', placed: [24, int(rng, 8, 10), int(rng, 0, 59)], items: int(rng, 3, 8) })
  for (let k = 0; k < 8; k++) pushOrderAndTask({ status: 'being_picked', placed: [24, int(rng, 8, 10), int(rng, 0, 59)], deadline: [int(rng, 12, 14), int(rng, 0, 59)], assignee: beingPickedAssignees[4 + (k % 8)], items: int(rng, 3, 7), picked: int(rng, 0, 2), unavailableAt: chance(rng, 0.55) ? int(rng, 2, 5) : undefined, substituteAt: chance(rng, 0.45) ? int(rng, 3, 6) : undefined })
  for (let k = 0; k < 21; k++) pushOrderAndTask({ status: 'ready_to_pack', placed: [24, int(rng, 6, 10), int(rng, 0, 59)], items: int(rng, 3, 8), unavailableAt: chance(rng, 0.3) ? int(rng, 1, 3) : undefined })
  for (let k = 0; k < 12; k++) pushOrderAndTask({ status: 'ready_for_handover', placed: [24, int(rng, 6, 9), int(rng, 0, 59)], items: int(rng, 2, 6) })
  // completed today (42) — durations centered on 4.8 min
  for (let k = 0; k < 42; k++) {
    const startMin = 6 * 60 + int(rng, 0, 120)
    const durMin = 4.8 * (0.72 + rng() * 0.56)
    const placed = new Date(2026, 0, 24, Math.floor(startMin / 60), startMin % 60)
    const orderId = `ORD-${ordNo++}`
    const cust = pick(rng, apCustomers)
    const lineCount = int(rng, 2, 6)
    const lines = makeLines(lineCount, lineCount)
    const items: OrderItem[] = lines.map((l) => ({ variantId: l.variantId, name: l.name, qty: l.qtyOrdered, price: variantOf(l.variantId)!.v.price, total: l.qtyOrdered * variantOf(l.variantId)!.v.price }))
    const amount = r5(items.reduce((a, i) => a + i.total, 0) + 40) || 240
    const claimed = plusMin(placed, 5)
    const completedAt = new Date(new Date(claimed).getTime() + durMin * 60000)
    orders.push({
      id: orderId, storeId: 'st-ap1', customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
      customerAvatar: cust.avatar, amount, deliveryFee: amount < 499 ? 40 : 0, discount: 0,
      paymentMethod: chance(rng, 0.3) ? 'cod' : pick(rng, ['online_upi', 'online_upi', 'online_card'] as const),
      status: 'delivered', placedAt: iso(placed), riderId: null, deliveryCode: String(int(rng, 1000, 9999)),
      deliveryCodeLocked: false, requiresAttention: false, correctionRequests: [], items,
      timeline: { placed: iso(placed), confirmed: plusMin(placed, 4), picked: claimed, delivered: iso(completedAt) },
    })
    pickingTasks.push({
      id: `PICK-${pickNo++}`, orderId, storeId: 'st-ap1', status: 'completed',
      assigneeId: pick(rng, [WF_AP2, WF_AP3, WF_AP4, WF_AP5]),
      claimedAt: claimed, deadline: D(24, 12, 0), createdAt: iso(placed), lines,
      completedAt: iso(completedAt),
    })
  }

  // past failed-delivery orders (returns link here) + past delivered
  const failedOrderIds: string[] = []
  for (let k = 0; k < 8; k++) {
    const day = 24 - 2 - (k % 5)
    const orderId = `ORD-${ordNo++}`
    failedOrderIds.push(orderId)
    const cust = pick(rng, apCustomers)
    const lineCount = int(rng, 2, 5)
    const lines = makeLines(lineCount, lineCount)
    const items: OrderItem[] = lines.map((l) => ({ variantId: l.variantId, name: l.name, qty: l.qtyOrdered, price: variantOf(l.variantId)!.v.price, total: l.qtyOrdered * variantOf(l.variantId)!.v.price }))
    const amount = r5(items.reduce((a, i) => a + i.total, 0) + 40) || 240
    orders.push({
      id: orderId, storeId: 'st-ap1', customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
      customerAvatar: cust.avatar, amount, deliveryFee: 40, discount: 0,
      paymentMethod: chance(rng, 0.5) ? 'cod' : pick(rng, ['online_upi', 'online_card'] as const),
      status: 'cancelled', placedAt: D(day, int(rng, 8, 18), int(rng, 0, 59)),
      riderId: pick(rng, db.riders.filter((r) => r.storeId === 'st-ap1')).id,
      deliveryCode: String(int(rng, 1000, 9999)), deliveryCodeLocked: false, requiresAttention: false,
      correctionRequests: [], items,
      timeline: { placed: D(day, int(rng, 7, 10), 0), cancelled: D(day + 1, int(rng, 10, 18), int(rng, 0, 59)) },
      cancelReason: 'Delivery failed',
    })
  }
  for (let k = 0; k < 40; k++) {
    const day = 23 - (k % 6)
    const orderId = `ORD-${ordNo++}`
    const cust = pick(rng, apCustomers)
    const lines = makeLines(int(rng, 2, 6), int(rng, 2, 6))
    const items: OrderItem[] = lines.map((l) => ({ variantId: l.variantId, name: l.name, qty: l.qtyOrdered, price: variantOf(l.variantId)!.v.price, total: l.qtyOrdered * variantOf(l.variantId)!.v.price }))
    const amount = r5(items.reduce((a, i) => a + i.total, 0) + 40) || 240
    orders.push({
      id: orderId, storeId: 'st-ap1', customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
      customerAvatar: cust.avatar, amount, deliveryFee: amount < 499 ? 40 : 0, discount: 0,
      paymentMethod: chance(rng, 0.3) ? 'cod' : pick(rng, ['online_upi', 'online_card'] as const),
      status: 'delivered', placedAt: D(day, int(rng, 7, 18), int(rng, 0, 59)), riderId: null,
      deliveryCode: String(int(rng, 1000, 9999)), deliveryCodeLocked: false, requiresAttention: false,
      correctionRequests: [], items,
      timeline: { placed: D(day, int(rng, 7, 10), 0), delivered: D(day, int(rng, 12, 20), int(rng, 0, 59)) },
    })
  }
  // st-ap2 light orders
  for (let k = 0; k < 8; k++) {
    const orderId = `ORD-${ordNo++}`
    const cust = pick(rng, apCustomers)
    const lines = makeLines(int(rng, 2, 5), 0)
    const items: OrderItem[] = lines.map((l) => ({ variantId: l.variantId, name: l.name, qty: l.qtyOrdered, price: variantOf(l.variantId)!.v.price, total: l.qtyOrdered * variantOf(l.variantId)!.v.price }))
    const amount = r5(items.reduce((a, i) => a + i.total, 0) + 40) || 240
    const status: Order['status'] = k < 5 ? 'placed' : k < 7 ? 'picking' : 'ready'
    orders.push({
      id: orderId, storeId: 'st-ap2', customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
      customerAvatar: cust.avatar, amount, deliveryFee: amount < 499 ? 40 : 0, discount: 0,
      paymentMethod: pick(rng, ['online_upi', 'cod'] as const), status,
      placedAt: D(24, int(rng, 8, 10), int(rng, 0, 59)), riderId: null,
      deliveryCode: String(int(rng, 1000, 9999)), deliveryCodeLocked: false, requiresAttention: false,
      correctionRequests: [], items,
      timeline: { placed: D(24, int(rng, 8, 10), int(rng, 0, 59)), confirmed: D(24, int(rng, 8, 10), 30) },
    })
    pickingTasks.push({
      id: `PICK-9${String(pickNo++).slice(-3)}`, orderId, storeId: 'st-ap2',
      status: status === 'placed' ? 'waiting_to_pick' : status === 'picking' ? 'being_picked' : 'ready_to_pack',
      assigneeId: status === 'placed' ? null : 'wf-chn', deadline: D(24, int(rng, 12, 15), 0),
      createdAt: D(24, int(rng, 8, 10), int(rng, 0, 59)), lines,
    })
  }
  db.orders = [...db.orders, ...orders]
  db.pickingTasks = pickingTasks



  // ── COD deposits (48; today 12 totalling ₹24,860) ────────────
  const codDeposits: CodDeposit[] = []
  const todayAmounts = [8420, 5760, 4320, 3180, 1880, 1300, 840, 720, 640, 560, 520, -1320]
  const todaySum = todayAmounts.reduce((a, b) => a + b, 0)
  const finalToday = [...todayAmounts.slice(0, 11), 24860 - todayAmounts.slice(0, 11).reduce((a, b) => a + b, 0)]
  let depSeq = 1
  for (let k = 0; k < 12; k++) {
    const rider = pick(rng, apRiders)
    codDeposits.push({
      id: `DEP-20260124-${String(++depSeq).padStart(2, '0')}`, storeId: 'st-ap1', riderId: rider.id, riderName: rider.name,
      amount: finalToday[k]!, reference: `DEP-20260124-${String(k + 1).padStart(2, '0')}`,
      outcome: k < 9 ? 'received' : k < 11 ? 'pending_verification' : 'discrepancy',
      remarks: k === 11 ? 'Short by ₹120 — rider notes pending' : undefined,
      at: D(24, int(rng, 9, 11), int(rng, 0, 59)),
    })
  }
  for (let k = 0; k < 36; k++) {
    const rider = pick(rng, apRiders)
    const day = 23 - (k % 7)
    codDeposits.push({
      id: `DEP-202601${String(17 + (k % 7)).padStart(2, '0')}-${String((k % 6) + 1).padStart(2, '0')}`,
      storeId: 'st-ap1', riderId: rider.id, riderName: rider.name,
      amount: r5(int(rng, 800, 9000)), reference: `DEP-202601${String(17 + (k % 7)).padStart(2, '0')}-${String((k % 6) + 1).padStart(2, '0')}`,
      outcome: 'received', at: D(day, int(rng, 10, 19), int(rng, 0, 59)),
    })
  }
  db.codDeposits = codDeposits

  // ── Inventory: batches, bins, receipts, counts, adjustments ──
  const bins = ['A1-01', 'A1-02', 'A2-01', 'A2-03', 'A3-01', 'A3-02', 'B1-01', 'B1-02', 'C1-01']
  db.binLocations = [{ storeId: 'st-ap1', bins }, { storeId: 'st-ap2', bins: bins.slice(0, 6) }]
  const inventoryBatches: InventoryBatch[] = []
  const lowVariantIdx = new Set([1, 3, 5, 8, 11, 14, 2, 7, 9, 10, 13, 15]) // 12 low-stock variants
  const expiringVariantIdx = new Set([0, 4, 6, 10, 12, 3, 5, 2]) // 8 expiring ≤ 7 days
  apStoreVariants.forEach(({ v, product }, idx) => {
    const low = lowVariantIdx.has(idx)
    const expiring = expiringVariantIdx.has(idx)
    const baseQty = low ? int(rng, 2, Math.max(3, product.reorderLevel - 2)) : int(rng, product.reorderLevel + 10, product.reorderLevel + 120)
    const expiryDays = expiring ? int(rng, 1, 6) : int(rng, 10, 120)
    inventoryBatches.push({ id: `B-${v.id}-1`, storeId: 'st-ap1', variantId: v.id, qty: baseQty, expiryDate: D(24 + expiryDays, 9, 0), binLocation: bins[idx % bins.length]! })
    if (chance(rng, 0.4)) {
      inventoryBatches.push({ id: `B-${v.id}-2`, storeId: 'st-ap1', variantId: v.id, qty: int(rng, 4, 30), expiryDate: D(24 + expiryDays + int(rng, 5, 30), 9, 0), binLocation: bins[(idx + 3) % bins.length]! })
    }
  })
  db.inventoryBatches = inventoryBatches
  // keep admin-side stock levels in sync for the AP stores
  const apLevels = db.stockLevels.filter((s) => s.storeId === 'st-ap1' || s.storeId === 'st-ap2')
  for (const row of apLevels) {
    const total = inventoryBatches.filter((b) => b.variantId === row.variantId && b.storeId === row.storeId).reduce((a, b) => a + b.qty, 0)
    row.qty = total
  }

  const stockReceipts: StockReceipt[] = Array.from({ length: 3 }).map((_, i) => {
    const { v, product } = apStoreVariants[i * 3]!
    return {
      id: `SR-90${i + 1}`, storeId: 'st-ap1', variantId: v.id, batchNo: `B${int(rng, 1000, 9999)}`,
      expiryDate: D(24 + int(rng, 20, 90), 9, 0), qty: int(rng, 40, 120), binLocation: bins[i % bins.length]!,
      at: D(24 - i, int(rng, 7, 9), int(rng, 0, 59)), by: 'Chaitanya Raju',
    }
  })
  db.stockReceipts = stockReceipts

  const stockCounts: StockCount[] = [{
    id: 'SC-101', storeId: 'st-ap1', startedAt: D(24, 8, 0), status: 'open',
    lines: apStoreVariants.slice(0, 5).map(({ v }, i) => ({
      variantId: v.id, name: `${db.products.find((p) => p.id === v.productId)!.name} – ${v.label}`,
      expected: inventoryBatches.filter((b) => b.variantId === v.id).reduce((a, b) => a + b.qty, 0) + (i === 2 ? 3 : 0),
      counted: null,
    })),
  }]
  db.stockCounts = stockCounts

  const stockAdjustments: StockAdjustment[] = []
  const adjDefs: Array<[number, number, string, string, string, StockAdjustment['approvalStatus']]> = [
    [-4, 8, 'Damaged pack written off', 'Vikram Varma', D(23, 15, 0), 'approved'],
    [+6, 11, 'Found unopened stock behind crate', 'Sneha Yadav', D(23, 16, 30), 'approved'],
    [-2, 14, 'Expired stock removed', 'Arjun Reddy', D(22, 18, 0), 'approved'],
    [-30, 6, 'Unexplained variance', 'Chaitanya Raju', D(24, 9, 40), 'pending'],
    [+10, 4, 'Cycle correction', 'Chaitanya Raju', D(24, 9, 55), 'pending'],
    [-1, 11, 'Sample given for quality check', 'Meera Nair', D(21, 12, 0), 'approved'],
    [-5, 7, 'Leakage in transit unload', 'Vikram Varma', D(20, 11, 0), 'approved'],
    [+3, 13, 'Return to stock after check', 'Sneha Yadav', D(19, 17, 0), 'approved'],
    [-2, 7, 'Damaged during receive', 'Arjun Reddy', D(18, 10, 0), 'approved'],
    [+1, 15, 'Recount correction', 'Meera Nair', D(17, 14, 0), 'approved'],
  ]
  for (const [delta, vIdx, reason, by, at, approvalStatus] of adjDefs) {
    const { v, product } = apStoreVariants[vIdx]!
    const adj: StockAdjustment = { id: `ADJ-${900 + stockAdjustments.length}`, storeId: 'st-ap1', variantId: v.id, delta, reason, by, at, approvalStatus }
    if (approvalStatus === 'pending') {
      adj.approvalId = `ap-stock-${stockAdjustments.length}`
      db.approvals = [{
        id: adj.approvalId, action: 'Stock adjustment', targetType: 'stock_adjustment',
        targetLabel: `${product.name} – ${v.label} (SRM AP Store)`,
        details: `Adjustment ${delta > 0 ? '+' : ''}${delta} units · reason: ${reason}`,
        reason, requesterName: by, requesterRole: 'Store manager (SRM AP Store)',
        status: 'pending', requestedAt: at, canApprove: true, expiresAt: D(31, 23, 59),
      }, ...db.approvals]
    }
    stockAdjustments.push(adj)
  }
  db.stockAdjustments = stockAdjustments

  // ── Returns (linked to past failed-delivery orders) ───────────
  const returns: ReturnParcel[] = []
  const returnStatuses: Array<ReturnParcel['status']> = ['pending', 'pending', 'pending', 'pending', 'under_inspection', 'under_inspection', 'under_inspection', 'under_inspection']
  returnStatuses.forEach((status, i) => {
    const orderId = failedOrderIds[i]!
    const order = db.orders.find((o) => o.id === orderId)!
    const items = order.items.slice(0, int(rng, 2, order.items.length)).map((it) => ({
      variantId: it.variantId, name: it.name, icon: iconFor(it.name.split(' – ')[0]!), qty: it.qty,
      batchId: `B${int(rng, 1000, 9999)}`,
      decision: (status === 'under_inspection' && i % 2 === 0 ? (i === 4 ? 'saleable' : i === 6 ? 'damaged' : 'expired') : undefined) as ReturnParcel['items'][number]['decision'],
    }))
    returns.push({
      id: `RTN-${1048 - i}`, orderId, storeId: 'st-ap1',
      returnedAt: D(24 - (i % 3), int(rng, 9, 12), int(rng, 0, 59)),
      reason: pick(rng, ['customer_unavailable', 'wrong_address', 'delivery_refused', 'rider_could_not_deliver']),
      status, items,
      note: status === 'under_inspection' ? 'Curd pack leaked. Paneer expired.' : undefined,
      stockAction: status === 'under_inspection' && i === 6 ? 'quarantine' : undefined,
      draft: false,
    })
  })
  // processed today (12) + quarantined (3) — historical
  for (let k = 0; k < 15; k++) {
    const orderId = failedOrderIds[(k + 3) % failedOrderIds.length]!
    const order = db.orders.find((o) => o.id === orderId)!
    returns.push({
      id: `RTN-${1040 - k}`, orderId, storeId: 'st-ap1',
      returnedAt: D(23 - (k % 4), int(rng, 9, 16), int(rng, 0, 59)),
      reason: pick(rng, ['customer_unavailable', 'delivery_refused', 'rider_could_not_deliver']),
      status: 'processed',
      items: order.items.slice(0, int(rng, 1, 3)).map((it) => ({
        variantId: it.variantId, name: it.name, icon: iconFor(it.name.split(' – ')[0]!), qty: it.qty,
        batchId: `B${int(rng, 1000, 9999)}`,
        decision: k < 3 ? ('damaged' as const) : ('saleable' as const),
      })),
      stockAction: k < 3 ? 'quarantine' : undefined,
      note: k < 3 ? 'Moved to quarantine — inspection note recorded' : undefined,
      draft: false, processedAt: D(24, int(rng, 8, 11), int(rng, 0, 59)),
    })
  }
  db.returns = returns

  // ── Store status changes ─────────────────────────────────────
  const storeStatusChanges: StoreStatusChange[] = [
    { id: 'ssc-1', storeId: 'st-ap1', status: 'paused', by: 'Chaitanya Raju', role: 'Store manager', at: D(23, 9, 20), reason: 'Stock receipt delayed' },
    { id: 'ssc-2', storeId: 'st-ap1', status: 'online', by: 'Chaitanya Raju', role: 'Store manager', at: D(23, 14, 0), reason: 'Stock received and shelved' },
    { id: 'ssc-3', storeId: 'st-ap1', status: 'online', by: 'System', role: 'Auto-open', at: D(24, 6, 0) },
    { id: 'ssc-4', storeId: 'st-ap2', status: 'online', by: 'System', role: 'Auto-open', at: D(24, 6, 30) },
    { id: 'ssc-5', storeId: 'st-2', status: 'paused', by: 'Kavya Deshpande', role: 'Store manager', at: D(24, 6, 40), reason: 'Manager note: stock receipt delayed' },
  ]
  db.storeStatusChanges = storeStatusChanges

  // ── Store notifications (24: 3 action + 16 operational + 5 system; 6 unread) ──
  const storeNotifications: StoreNotification[] = []
  const pushNotif = (kind: StoreNotification['kind'], requiresAction: boolean, read: boolean, title: string, body: string, at: string, link?: string) => {
    storeNotifications.push({ id: `sn-${storeNotifications.length + 1}`, storeId: 'st-ap1', title, body, kind, requiresAction, read, at, link })
  }
  // 3 action-required (unread)
  pushNotif('action', true, false, 'Low stock items need reordering', `${lowVariantIdx.size} products are below reorder level at SRM AP Store`, D(24, 7, 30), '/inventory?tab=low')
  pushNotif('action', true, false, 'Picking deadlines at risk', '3 tasks are due within 30 minutes', D(24, 10, 35), '/orders-picking')
  pushNotif('action', true, false, 'Rider applications waiting', '7 applications are pending review', D(24, 8, 15), '/rider-applications?status=pending')
  // 16 operational (3 unread)
  pushNotif('operational', false, false, 'New order in picking queue', 'ORD-78463 added — waiting to pick', D(24, 10, 52), '/orders-picking')
  pushNotif('operational', false, false, 'New order in picking queue', 'ORD-78462 added — waiting to pick', D(24, 10, 31), '/orders-picking')
  pushNotif('operational', false, false, 'COD deposit recorded', 'DEP-20260124-01 · ₹8,420 received', D(24, 11, 40), '/cod-deposits')
  pushNotif('operational', true, false, 'Adjustment pending approval', 'Paneer – 200 g: −30 units (unexplained variance)', D(24, 9, 40), '/inventory?tab=adjustments')
  pushNotif('operational', false, true, 'Stock receipt recorded', 'SR-901 · 3 batches received', D(24, 8, 10))
  pushNotif('operational', false, true, 'Expiring batches in ≤ 7 days', '8 batches need attention', D(24, 7, 0), '/inventory?tab=expiring')
  pushNotif('operational', false, true, 'Task overdue', 'PICK-7840 for ORD-78421 is past its deadline', D(24, 10, 30), '/orders-picking')
  pushNotif('operational', false, true, 'Task overdue', 'PICK-7841 for ORD-78422 is past its deadline', D(24, 10, 45), '/orders-picking')
  pushNotif('operational', false, true, 'Return parcel arrived', 'RTN-1048 from ORD-78301 — inspection pending', D(24, 11, 20), '/returns')
  pushNotif('operational', false, true, 'Return parcel arrived', 'RTN-1047 from ORD-78302 — inspection pending', D(24, 11, 5), '/returns')
  pushNotif('operational', false, true, 'Rider application submitted', 'New application for SRM AP Store', D(24, 11, 20), '/rider-applications')
  pushNotif('operational', false, true, 'COD deposit discrepancy', 'DEP-20260124-12 flagged — short by ₹120', D(24, 11, 44), '/cod-deposits')
  pushNotif('operational', false, true, 'Packing completed', '21 orders are ready to pack today', D(24, 10, 0))
  pushNotif('operational', false, true, 'Handover completed', '12 orders handed over to riders', D(24, 10, 10))
  // 5 system (2 unread)
  pushNotif('system', false, false, 'Store status updated', 'SRM AP Store resumed at 2:00 PM yesterday by Chaitanya Raju', D(23, 14, 0), '/status')
  pushNotif('system', false, true, 'Adjustment approved by admin', 'Damaged pack write-off approved', D(23, 18, 0))
  pushNotif('system', false, true, 'Password policy notice', 'Manager passwords expire every 180 days', D(22, 9, 0))
  pushNotif('system', false, true, 'Subscription run completed', 'Daily milk plan generated for tomorrow', D(24, 4, 45))
  pushNotif('system', false, false, 'Store opened automatically', 'SRM AP Store opened at 6:00 AM', D(24, 6, 0), '/status')
  db.storeNotifications = storeNotifications
  db.storeNotificationPrefs = [{
    workforceId: 'wf-chn',
    prefs: { pickingOrders: true, inventoryAlerts: true, riderApplications: true, codDeposits: true, storeStatus: true },
  }]
  void r5; void plusMin
}
