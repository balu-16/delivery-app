import { mulberry32, int, pick, chance, shuffle, type RNG } from './rng'
import { buildStorePortalData } from './seedStorePortal'
import type {
  DB, Order, OrderItem, PaymentAttempt, Refund, WalletLedgerEntry, Store, Zone, LegalEntity,
  City, Product, Variant, VariantAvailability, StockLevel, StockBatch, InventoryMovement, MovementType,
  Rider, WorkforceAccount, Customer, Payout, PayoutCorrection, Coupon, PushCampaign, AdminNotification,
  DeliverySlot, SubscriptionHoliday, SubscriptionRun, Ticket, SavedResponse, Rating, Approval,
  FraudFinding, ReconciliationFinding, ErasureRequest, LegalHold, ExportJob, BackgroundJob,
  OperationalNotification, InvoiceFailure, SystemSettings, ProductCategory, Brand,
} from '../types'

// ── Demo clock ──────────────────────────────────────────────────
export const DEMO_NOW = new Date(2026, 0, 24, 11, 5, 0) // Sat, 24 Jan 2026 ~11:05 AM
const iso = (d: Date) => d.toISOString()
const D = (day: number, hh: number, mm: number) => iso(new Date(2026, 0, day, hh, mm))
const plusMin = (d: Date, mins: number) => iso(new Date(d.getTime() + mins * 60000))
const r5 = (n: number) => Math.round(n / 5) * 5
const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// ── helpers ─────────────────────────────────────────────────────
/** Amounts (multiples of 5) that sum EXACTLY to total. */
function hitSum(rng: RNG, count: number, total: number, min: number, max: number): number[] {
  const avg = total / count
  const out: number[] = []
  let remaining = total
  for (let i = 0; i < count - 1; i++) {
    const left = count - i - 1
    const hi = Math.min(max, remaining - min * left)
    const lo = Math.max(min, remaining - max * left)
    out.push(clampN(r5(avg * (0.55 + rng() * 0.9)), lo, hi))
    remaining -= out[i]!
  }
  out.push(clampN(r5(remaining), min, max))
  let drift = total - out.reduce((a, b) => a + b, 0)
  let guard = 0
  while (drift !== 0 && guard++ < 20000) {
    const i = int(rng, 0, count - 1)
    const step = drift > 0 ? 5 : -5
    if (out[i]! + step >= min && out[i]! + step <= max) { out[i]! += step; drift -= step }
  }
  return out
}

function largestRemainder(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map((w) => (w / sum) * total)
  const base = raw.map((x) => Math.floor(x))
  let left = total - base.reduce((a, b) => a + b, 0)
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < left; k++) base[order[k % order.length]!.i]! += 1
  return base
}

// ── Name pools (unique per entity type) ─────────────────────────
const CUSTOMER_NAMES = [
  'Aditya Deshpande', 'Meera Kulkarni', 'Rutuja Jadhav', 'Prateek Nair', 'Nikhil Wagh',
  'Ananya Sharma', 'Vedant Tiwari', 'Sanika Pawar', 'Arjun Malhotra', 'Ishita Bose',
  'Karan Mehra', 'Divya Raghavan', 'Akash Sonawane', 'Shraddha Mahajan', 'Yash Thakker',
  'Pooja Shetty', 'Rohit Vazirani', 'Kavita Belsare', 'Sanket Khoje', 'Aarti Bhilare',
  'Sahil Kapadia', 'Tanvi Raythatha', 'Onkar Teli', 'Bhavana Rokade', 'Zaid Ansari',
  'Grace Mathew', 'Chirag Bathija', 'Sneha Sonkamble', 'Abhishek Dey', 'Vaishnavi Ghate',
  'Rishab Jain', 'Trupti Sathe', 'Manav Chauhan', 'Reema Qureshi', 'Sarthak Mahadik',
  'Nupur Karmarkar', 'Ayan Mistry', 'Shreya Balan', 'Vivek Anchan', 'Priyanka Waman',
  'Devansh Bhatnagar', 'Kalyani Rane', 'Sushant Kadam', 'Anjali Sabnis', 'Mayuresh Dalvi',
  'Fatima Shaikh', 'Rohan Bhosale', 'Snehal Dhabekar', 'Ketan Bhagwat', 'Mitali Paingankar',
]
const CUSTOMER_FIRST = ['Aarav', 'Vivaan', 'Ishaan', 'Anika', 'Diya', 'Advait', 'Kabir', 'Myra', 'Reyansh', 'Anvi', 'Arnav', 'Prisha', 'Vihaan', 'Aadhya', 'Rudra', 'Sara', 'Atharv', 'Kiara', 'Ved', 'Riya']
const CUSTOMER_LAST = ['Gokhale', 'Dandekar', 'Hegde', 'Bhat', 'Pillai', 'Chavan', 'Joshi', 'Kunte', 'Naik', 'Salian', 'Save', 'Tupe', 'Wadekar', 'Bagwe', 'Mhaskar']
const RIDER_NAMES = ['Sandeep Patil', 'Rahul More', 'Vikram Desai', 'Ajay Pawar', 'Suresh Kadam', 'Manoj Thorat', 'Ravi Shinde', 'Ganesh Salunkhe', 'Pravin Chavan', 'Deepak Jadhav', 'Kiran Bhosale', 'Sachin Landge']
const WORKFORCE_NAMES = [
  'Arjun Mehta',
  'Rohit Kulkarni', 'Kavya Deshpande', 'Nilesh Bhosale', 'Priya Kamat', 'Sameer Joshi', 'Neha Wagh', 'Amit Salvi', 'Pooja Rane', // store managers
  'Lalita Bisht', 'Farhan Qureshi', 'Meghna Rao', // support agents
  'Charu Bhatia', 'Ankit Verma', // extra workforce (invited / blocked)
]

// ── Build the dataset ───────────────────────────────────────────
export function buildSeedData(): DB {
  const rng = mulberry32(20260124)

  // ── Cities ──
  const cities: City[] = [
    { id: 'mumbai', name: 'Mumbai', coords: [19.076, 72.8777] },
    { id: 'pune', name: 'Pune', coords: [18.5204, 73.8567] },
    { id: 'nashik', name: 'Nashik', coords: [19.9975, 73.7898] },
    { id: 'nagpur', name: 'Nagpur', coords: [21.1458, 79.0882] },
    { id: 'aurangabad', name: 'Aurangabad', coords: [19.8762, 75.3433] },
  ]

  // ── Legal entities ──
  const legalEntities: LegalEntity[] = [
    { id: 'le-1', name: 'DairyDirect Retail Pvt Ltd', gstin: '27AABCD1234A1Z5', address: 'Unit 4, Trade Center, BKC, Mumbai 400051', invoicePrefix: 'DDR' },
    { id: 'le-2', name: 'DairyDirect Logistics LLP', gstin: '27AAFFD5678B1Z3', address: 'Plot 12, MIDC Andheri, Mumbai 400093', invoicePrefix: 'DDL' },
    { id: 'le-3', name: 'DairyDirect Nashik Foods', gstin: '27AACDN9012C1Z8', address: 'Satpur MIDC, Nashik 422007', invoicePrefix: 'DDN' },
  ]

  // ── Stores ──
  const defaultHours = () => [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, open: '06:00', close: '22:00' }))
  const storeDefs: Array<Partial<Store> & { id: string; name: string; location: string; cityId: string; status: Store['status']; backlog: number }> = [
    { id: 'st-1', name: 'Colaba Fresh Store', location: 'Shop 7, Colaba Causeway, Mumbai', cityId: 'mumbai', status: 'online', backlog: 3 },
    { id: 'st-2', name: 'Andheri West Store', location: 'Unit 12, Lokhandwala, Andheri West, Mumbai', cityId: 'mumbai', status: 'paused', backlog: 0 },
    { id: 'st-3', name: 'Powai Store', location: 'G Block, Hiranandani Gardens, Powai, Mumbai', cityId: 'mumbai', status: 'online', backlog: 38 },
    { id: 'st-4', name: 'Baner Store', location: 'Survey 42, Baner Road, Pune', cityId: 'pune', status: 'online', backlog: 6 },
    { id: 'st-5', name: 'Kothrud Store', location: 'Karve Road, Kothrud, Pune', cityId: 'pune', status: 'online', backlog: 4 },
    { id: 'st-6', name: 'Panchavati Store', location: 'Gadhe Marg, Panchavati, Nashik', cityId: 'nashik', status: 'online', backlog: 5 },
    { id: 'st-7', name: 'Dharampeth Store', location: 'West High Court Road, Dharampeth, Nagpur', cityId: 'nagpur', status: 'online', backlog: 2 },
    { id: 'st-8', name: 'Nirala Bazaar Store', location: 'Nirala Bazaar, Aurangabad', cityId: 'aurangabad', status: 'paused', backlog: 0 },
  ]
  const stores: Store[] = storeDefs.map((s, i) => ({
    id: s.id, code: `ST-00${i + 1}`, name: s.name, location: s.location, cityId: s.cityId,
    coords: cities.find((c) => c.id === s.cityId)!.coords,
    capacityOrdersPerDay: [260, 200, 240, 220, 180, 150, 130, 120][i]!,
    status: s.status, codAvailable: s.id !== 'st-2',
    legalEntityId: s.cityId === 'nashik' ? 'le-3' : s.cityId === 'mumbai' && i % 2 === 1 ? 'le-2' : 'le-1',
    managerIds: [`wf-${i + 2}`], // store managers seeded right after admin
    openedOn: `202${3 + (i % 3)}-${String(1 + (i % 12)).padStart(2, '0')}-05`,
    imageVariant: i % 8,
    hours: defaultHours(),
    holidays: [
      { date: '2026-01-26', name: 'Republic Day' },
      ...(i === 3 ? [{ date: '2026-01-28', name: 'Store maintenance' }] : []),
    ],
    pickingBacklog: s.backlog,
    note: 'A store manager can pause/resume their own store; the admin controls wider configuration (capacity, COD, legal entity, zones).',
  }))
  const storesByCity: Record<string, Store[]> = {}
  for (const s of stores) (storesByCity[s.cityId] ??= []).push(s)

  // ── Zones (polygon per zone) ──
  const zoneNames: Record<string, string[]> = {
    mumbai: ['Colaba–Nariman Point', 'Bandra West', 'Powai–Vikhroli', 'Andheri West'],
    pune: ['Baner–Aundh', 'Kothrud–Karve Nagar'],
    nashik: ['Panchavati Ring'],
    nagpur: ['Dharampeth Belt'],
    aurangabad: ['Nirala–CIDCO'],
  }
  const zones: Zone[] = []
  for (const city of cities) {
    const names = zoneNames[city.id]!
    names.forEach((name, idx) => {
      const store = storesByCity[city.id]![idx % storesByCity[city.id]!.length]!
      const poly: [number, number][] = []
      const lat0 = city.coords[0] + (idx - names.length / 2) * 0.02
      const lng0 = city.coords[1] + (idx - names.length / 2) * 0.025
      poly.push([lat0, lng0], [lat0 + 0.035, lng0 + 0.006], [lat0 + 0.042, lng0 + 0.03], [lat0 + 0.012, lng0 + 0.034])
      zones.push({
        id: `z-${city.id}-${idx + 1}`, storeId: store.id, cityId: city.id, name,
        priority: (idx % 3 === 0 ? 1 : idx % 3 === 1 ? 2 : 3) as 1 | 2 | 3,
        pincodes: `4${String(2100 + idx * 11).slice(0, 4)} ${String(idx + 1).padStart(3, '0')}`,
        polygon: poly.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)] as [number, number]),
      })
    })
  }

  // ── Workforce (roles: admin, store_manager, rider, support_agent) ──
  const workforce: WorkforceAccount[] = []
  const wfPush = (a: Omit<WorkforceAccount, 'avatar' | 'password'> & { avatar?: number; password?: string }) => {
    const fallbackPassword = a.role === 'admin' ? 'Admin@123' : a.role === 'support_agent' ? 'Support@123' : 'Store@123'
    workforce.push({ ...a, password: a.password ?? fallbackPassword, avatar: a.avatar ?? workforce.length % 12 })
  }
  wfPush({ id: 'wf-1', name: 'Arjun Mehta', email: 'admin@dairydirect.in', phone: '+91 98200 11001', role: 'admin', storeId: null, status: 'active', lastLogin: D(24, 8, 2), joinedOn: '2024-02-01' })
  for (let i = 0; i < stores.length; i++) {
    const name = WORKFORCE_NAMES[i + 1]!
    wfPush({
      id: `wf-${i + 2}`, name, email: `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.')}@dairydirect.in`,
      phone: `+91 98200 11${String(i + 2).padStart(3, '0')}`, role: 'store_manager', storeId: stores[i]!.id,
      status: i === 7 ? 'blocked' : 'active', lastLogin: i === 7 ? D(20, 17, 12) : D(int(rng, 22, 24), int(rng, 7, 19), int(rng, 0, 59)),
      joinedOn: `202${3 + (i % 3)}-0${1 + (i % 9)}-12`,
    })
  }
  const supportIds = [9, 10, 11]
  for (let i = 0; i < 3; i++) {
    const name = WORKFORCE_NAMES[supportIds[i]!]!
    wfPush({
      id: `wf-${11 + i}`, name, email: `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.')}@dairydirect.in`,
      phone: `+91 98200 22${String(i + 1).padStart(3, '0')}`, role: 'support_agent', storeId: null, status: 'active',
      lastLogin: D(int(rng, 22, 24), int(rng, 8, 20), int(rng, 0, 59)), joinedOn: `2025-0${3 + i}-18`,
    })
  }
  wfPush({ id: 'wf-14', name: 'Charu Bhatia', email: 'charu.bhatia@dairydirect.in', phone: '+91 98200 22011', role: 'support_agent', storeId: null, status: 'invited', joinedOn: '2026-01-20' })
  const managers = workforce.filter((w) => w.role === 'store_manager')

  // ── Riders (delivery partners; applications reviewed by store managers) ──
  const riders: Rider[] = RIDER_NAMES.map((name, i) => {
    const store = stores[i % stores.length]!
    const status: Rider['status'] = i < 8 ? 'active' : i === 8 || i === 9 ? 'application_pending' : i === 10 ? 'application_rejected' : 'suspended'
    const docStatus = (k: number): Rider['documents'][number]['status'] =>
      status === 'application_pending' ? (k === 0 ? 'verified' : k === 1 ? 'submitted' : 'pending')
      : status === 'application_rejected' ? (k === 2 ? 'rejected' : 'verified')
      : 'verified'
    return {
      id: `rd-${i + 1}`, name, phone: `+91 98${String(21000000 + i * 137711).slice(0, 8)}`, avatar: i % 12,
      storeId: store.id, status, appliedOn: `202${5 + (i % 2)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(2 + (i % 26)).padStart(2, '0')}`,
      vehicle: pick(rng, ['Activa', 'Bajaj Chetak', 'TVS iQube', 'Ather 450X', 'Ola S1']),
      documents: [
        { type: 'license', status: docStatus(0) },
        { type: 'id_proof', status: docStatus(1) },
        { type: 'bank_details', status: docStatus(2) },
      ],
      reviewedByStoreManager: status !== 'application_pending',
      reviewNote: status === 'application_rejected' ? 'License verification failed — rejected by store manager' : undefined,
      deliveriesPeriod: status === 'active' ? [248, 231, 198, 187, 176, 164, 158, 149][i]! : int(rng, 4, 40),
      rating: +(4.2 + rng() * 0.7).toFixed(1),
    }
  })
  const activeRiders = riders.filter((r) => r.status === 'active')

  // ── Catalog: categories, brands, products, variants ──
  const categories: ProductCategory[] = [
    { id: 'cat-milk', name: 'Milk' },
    { id: 'cat-paneer', name: 'Paneer & Cheese' },
    { id: 'cat-ghee', name: 'Ghee & Oils' },
    { id: 'cat-curd', name: 'Curd & Cultured' },
    { id: 'cat-other', name: 'Other' },
  ]
  const brands: Brand[] = [
    { id: 'br-1', name: 'DairyDirect Classic' },
    { id: 'br-2', name: 'Pasture Fresh' },
    { id: 'br-3', name: 'Village Craft' },
  ]
  const productDefs: Array<{ name: string; cat: string; brand: string; tax: number; shelf: number; storage: Product['storage']; variants: Array<[string, number]>; subscribable: boolean; reorder: number }> = [
    { name: 'Cow Milk', cat: 'cat-milk', brand: 'br-1', tax: 0, shelf: 3, storage: 'chilled', variants: [['500 ml', 40], ['1 L', 75]], subscribable: true, reorder: 20 },
    { name: 'Toned Milk', cat: 'cat-milk', brand: 'br-1', tax: 0, shelf: 3, storage: 'chilled', variants: [['500 ml', 30]], subscribable: true, reorder: 15 },
    { name: 'Buffalo Milk', cat: 'cat-milk', brand: 'br-2', tax: 0, shelf: 3, storage: 'chilled', variants: [['1 L', 80]], subscribable: false, reorder: 12 },
    { name: 'Chaas (Buttermilk)', cat: 'cat-milk', brand: 'br-3', tax: 5, shelf: 5, storage: 'chilled', variants: [['200 ml', 20], ['500 ml', 35]], subscribable: false, reorder: 18 },
    { name: 'Flavored Milk', cat: 'cat-milk', brand: 'br-3', tax: 12, shelf: 12, storage: 'chilled', variants: [['200 ml', 45]], subscribable: false, reorder: 18 },
    { name: 'Paneer', cat: 'cat-paneer', brand: 'br-1', tax: 5, shelf: 7, storage: 'chilled', variants: [['200 g', 120], ['500 g', 280]], subscribable: false, reorder: 15 },
    { name: 'Cheese Slices', cat: 'cat-paneer', brand: 'br-2', tax: 12, shelf: 30, storage: 'chilled', variants: [['200 g', 145]], subscribable: false, reorder: 14 },
    { name: 'Ghee', cat: 'cat-ghee', brand: 'br-1', tax: 12, shelf: 240, storage: 'ambient', variants: [['500 ml', 220], ['1 L', 420]], subscribable: false, reorder: 10 },
    { name: 'Fresh Cream', cat: 'cat-ghee', brand: 'br-2', tax: 12, shelf: 14, storage: 'chilled', variants: [['250 ml', 110]], subscribable: false, reorder: 12 },
    { name: 'Curd', cat: 'cat-curd', brand: 'br-1', tax: 5, shelf: 5, storage: 'chilled', variants: [['400 g', 60]], subscribable: true, reorder: 16 },
    { name: 'Sweet Lassi', cat: 'cat-curd', brand: 'br-3', tax: 12, shelf: 6, storage: 'chilled', variants: [['200 ml', 50]], subscribable: false, reorder: 18 },
    { name: 'Butter', cat: 'cat-other', brand: 'br-2', tax: 12, shelf: 90, storage: 'chilled', variants: [['500 g', 230]], subscribable: false, reorder: 14 },
    { name: 'Tofu', cat: 'cat-other', brand: 'br-3', tax: 5, shelf: 6, storage: 'chilled', variants: [['200 g', 60]], subscribable: false, reorder: 12 },
  ]
  const products: Product[] = []
  const variants: Variant[] = []
  productDefs.forEach((p, i) => {
    const pid = `pr-${String(i + 1).padStart(2, '0')}`
    products.push({
      id: pid, name: p.name, categoryId: p.cat, brandId: p.brand,
      description: `${p.name} sourced from partner dairies and quality-checked daily.`,
      taxRatePct: p.tax, shelfLifeDays: p.shelf, storage: p.storage,
      imageVariant: i % 8,
      reorderLevel: p.reorder,
      publishState: i === 11 ? 'unpublished' : 'published',
      subscribable: p.subscribable,
      pendingChangeLabel: undefined,
      pendingApprovalId: undefined,
    })
    p.variants.forEach(([label, price], k) => {
      const vid = `v-${String(i + 1).padStart(2, '0')}${k + 1}`
      variants.push({
        id: vid, productId: pid, label,
        sku: `DD-${String(i + 1).padStart(2, '0')}${k + 1}-${int(rng, 100, 999)}`,
        barcode: `89${int(rng, 100000000000, 999999999999)}`,
        price, active: true,
      })
    })
  })
  // one sensitive price change awaiting approval (linked to approvals seed below)
  const ghee500 = variants.find((v) => v.sku.startsWith('DD-08'))!
  const flavored = products.find((p) => p.name === 'Flavored Milk')!

  // per-store availability: all stores carry milk range; smaller stores skip niche items
  const storeVariants: VariantAvailability[] = []
  for (const v of variants) {
    for (const s of stores) {
      const niche = ['v-042', 'v-051', 'v-062', 'v-091', 'v-111', 'v-121'].includes(v.id)
      storeVariants.push({ variantId: v.id, storeId: s.id, available: !(niche && (s.id === 'st-7' || s.id === 'st-8')), priceOverride: null })
    }
  }

  // ── Customers ──
  const customers: Customer[] = []
  let cIdx = 0
  const pushCustomer = (name: string, cityId?: string) => {
    const c: Customer = {
      id: `C${String(10001 + cIdx)}`, name, cityId: cityId ?? pick(rng, cities).id,
      phone: `+91 ${int(rng, 70, 99)}${int(rng, 10, 99)} ${int(rng, 10000, 99999)}`,
      email: name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.') + '@gmail.com',
      avatar: cIdx % 12, joinedOn: `202${int(rng, 4, 6)}-${String(int(rng, 1, 12)).padStart(2, '0')}-${String(int(rng, 1, 28)).padStart(2, '0')}`,
      status: 'active',
    }
    customers.push(c); cIdx++
    return c
  }
  const fixedCustomers: Record<string, Customer> = {}
  for (const n of ['Aditya Deshpande', 'Meera Kulkarni', 'Rutuja Jadhav', 'Prateek Nair', 'Nikhil Wagh', 'Ananya Sharma', 'Vedant Tiwari', 'Sanika Pawar', 'Arjun Malhotra', 'Ishita Bose']) {
    fixedCustomers[n] = pushCustomer(n)
  }
  for (const n of CUSTOMER_NAMES.slice(5)) pushCustomer(n)
  while (customers.length < 480) pushCustomer(`${pick(rng, CUSTOMER_FIRST)} ${pick(rng, CUSTOMER_LAST)}`)
  // blocked customers (People > Customers shows block/unblock)
  customers[10]!.status = 'blocked'; customers[10]!.blockedReason = 'Repeated COD refusals — blocked by admin'
  customers[25]!.status = 'blocked'; customers[25]!.blockedReason = 'Fraud finding FR-003 confirmed'

  // ── Orders (1,248; one source of truth for orders/payments/payouts/support/reports) ──
  const orders: Order[] = []
  const fixedSpecs: Array<{ num: number; name: string; storeId: string; amount: number; method: Order['paymentMethod']; status: Order['status']; placed: [number, number, number]; attention?: Order['attentionReason'] }> = [
    { num: 10489, name: 'Aditya Deshpande', storeId: 'st-1', amount: 420, method: 'online_upi', status: 'delivered', placed: [24, 10, 34] },
    { num: 10488, name: 'Meera Kulkarni', storeId: 'st-2', amount: 780, method: 'online_upi', status: 'out_for_delivery', placed: [24, 10, 12] },
    { num: 10487, name: 'Rutuja Jadhav', storeId: 'st-6', amount: 320, method: 'online_upi', status: 'picking', placed: [24, 9, 56] },
    { num: 10486, name: 'Prateek Nair', storeId: 'st-7', amount: 1240, method: 'online_card', status: 'delivered', placed: [24, 9, 20] },
    { num: 10485, name: 'Nikhil Wagh', storeId: 'st-8', amount: 560, method: 'cod', status: 'picking', placed: [24, 8, 48] },
    { num: 10484, name: 'Ananya Sharma', storeId: 'st-3', amount: 660, method: 'online_upi', status: 'on_hold', placed: [24, 9, 5], attention: 'on_hold' },
    { num: 10483, name: 'Vedant Tiwari', storeId: 'st-3', amount: 430, method: 'online_upi', status: 'out_for_delivery', placed: [24, 8, 40], attention: 'wrong_address' },
    { num: 10482, name: 'Sanika Pawar', storeId: 'st-4', amount: 350, method: 'cod', status: 'out_for_delivery', placed: [24, 8, 22], attention: 'code_locked' },
    { num: 10481, name: 'Arjun Malhotra', storeId: 'st-1', amount: 910, method: 'online_card', status: 'placed', placed: [24, 10, 48], attention: 'payment_failed' },
    { num: 10480, name: 'Ishita Bose', storeId: 'st-7', amount: 540, method: 'online_upi', status: 'delivered', placed: [24, 8, 5] },
  ]
  const statusPlan = largestRemainder([988, 104, 62, 48, 34, 12], 1248 - fixedSpecs.length)
  // [delivered, inProgress(confirmed/picking/ready), out_for_delivery, placed, cancelled, on_hold]
  type Slot = { status: Order['status']; day: number; hh: number; mm: number }
  const slots: Slot[] = []
  const deliveredByDay = largestRemainder(Array.from({ length: 23 }, (_, d) => 30 + d * 0.85), statusPlan[0]!)
  for (let day = 1; day <= 23; day++) {
    for (let k = 0; k < deliveredByDay[day - 1]!; k++) slots.push({ status: 'delivered', day, hh: int(rng, 6, 19), mm: int(rng, 0, 59) })
  }
  const inProgMix: Order['status'][] = ['confirmed', 'picking', 'ready']
  for (let k = 0; k < statusPlan[1]!; k++) slots.push({ status: inProgMix[k % 3]!, day: 24, hh: int(rng, 6, 10), mm: int(rng, 0, 55) })
  for (let k = 0; k < statusPlan[2]!; k++) slots.push({ status: 'out_for_delivery', day: 23, hh: int(rng, 18, 23), mm: int(rng, 0, 59) })
  for (let k = 0; k < statusPlan[3]!; k++) slots.push({ status: 'placed', day: 24, hh: int(rng, 7, 10), mm: int(rng, 0, 55) })
  for (let k = 0; k < statusPlan[4]!; k++) slots.push({ status: 'cancelled', day: int(rng, 1, 23), hh: int(rng, 8, 21), mm: int(rng, 0, 59) })
  for (let k = 0; k < statusPlan[5]!; k++) slots.push({ status: 'on_hold', day: int(rng, 22, 24), hh: int(rng, 8, 12), mm: int(rng, 0, 59) })
  const shuffledSlots = shuffle(rng, slots)

  const methods: Order['paymentMethod'][] = ['online_upi', 'online_upi', 'online_upi', 'online_card', 'online_netbanking', 'wallet', 'cod', 'cod']
  const CANCEL_REASONS = ['Customer changed mind', 'Item out of stock', 'Address not serviceable', 'Duplicate order', 'Payment failed', 'Delivery slot missed']
  const HOLD_REASONS = ['Stock unconfirmed at store', 'Customer requested hold', 'Waiting for payment retry']

  let idNum = 9242
  const orderSeedRows: Array<{ amount: number; storeId: string }> = []
  // distribute orders across stores proportional to capacity
  const storeWeights = stores.map((s) => s.capacityOrdersPerDay)
  const ordersPerStore = largestRemainder(storeWeights, 1248 - fixedSpecs.length)
  stores.forEach((s, i) => { for (let k = 0; k < ordersPerStore[i]!; k++) orderSeedRows.push({ amount: 0, storeId: s.id }) })
  const amounts = hitSum(rng, orderSeedRows.length, 1245000, 240, 2200)
  orderSeedRows.forEach((row, i) => { row.amount = amounts[i]! })

  const exactFitItems = (amount: number, storeVariantsList: Variant[]): { items: OrderItem[]; fee: number } => {
    let remaining = amount
    const feeBase = remaining < 400 ? 40 : 0
    remaining -= feeBase
    const items: OrderItem[] = []
    let distinct = 0
    let guard = 0
    while (remaining >= 20 && guard++ < 120) {
      const avail = storeVariantsList.filter((v) => v.price <= remaining && (!items.some((it) => it.variantId === v.id) || distinct >= 4))
      if (avail.length === 0) break
      const v = pick(rng, avail)
      const qty = int(rng, 1, Math.max(1, Math.min(3, Math.floor(remaining / v.price))))
      items.push({ variantId: v.id, name: `${products.find((p) => p.id === v.productId)!.name} – ${v.label}`, qty, price: v.price, total: v.price * qty })
      remaining -= v.price * qty
      distinct++
    }
    const merged: OrderItem[] = []
    for (const it of items) {
      const f = merged.find((m) => m.variantId === it.variantId)
      if (f) { f.qty += it.qty; f.total += it.total } else merged.push({ ...it })
    }
    return { items: merged, fee: feeBase + Math.max(0, remaining) }
  }

  const buildOrder = (row: { amount: number; storeId: string }, slot: Slot, num: number): Order => {
    const placed = new Date(2026, 0, slot.day, slot.hh, slot.mm)
    const cust = pick(rng, customers)
    const store = stores.find((s) => s.id === row.storeId)!
    const storeVariantsList = storeVariants.filter((sv) => sv.storeId === store.id && sv.available).map((sv) => variants.find((v) => v.id === sv.variantId)!)
    const { items, fee } = exactFitItems(row.amount, storeVariantsList)
    const t: Order['timeline'] = { placed: iso(placed) }
    const rider = (slot.status === 'out_for_delivery' || slot.status === 'delivered') ? pick(rng, activeRiders.filter((r) => r.storeId === store.id)).id : slot.status === 'on_hold' || slot.status === 'placed' ? null : chance(rng, 0.8) ? pick(rng, activeRiders).id : null
    if (slot.status !== 'placed') t.confirmed = plusMin(placed, int(rng, 6, 25))
    if (slot.status === 'picking' || slot.status === 'ready' || slot.status === 'out_for_delivery' || slot.status === 'delivered') t.picked = plusMin(placed, int(rng, 12, 40))
    if (slot.status === 'ready' || slot.status === 'out_for_delivery' || slot.status === 'delivered') t.ready = plusMin(placed, int(rng, 20, 60))
    if (slot.status === 'out_for_delivery' || slot.status === 'delivered') t.outForDelivery = plusMin(placed, int(rng, 25, 90))
    if (slot.status === 'delivered') t.delivered = plusMin(placed, int(rng, 40, 1300))
    if (slot.status === 'cancelled') t.cancelled = plusMin(placed, int(rng, 30, 400))
    if (slot.status === 'on_hold') t.held = plusMin(placed, int(rng, 15, 90))
    return {
      id: `DD${num}`, storeId: store.id, customerId: cust.id, customerName: cust.name,
      customerPhone: cust.phone, customerAvatar: cust.avatar,
      amount: items.reduce((a, i) => a + i.total, 0) + fee, deliveryFee: fee, discount: 0,
      paymentMethod: slot.status === 'cancelled' && chance(rng, 0.5) ? 'cod' : pick(rng, methods),
      status: slot.status, placedAt: iso(placed), riderId: rider,
      deliveryCode: String(int(rng, 1000, 9999)), deliveryCodeLocked: false,
      requiresAttention: false, correctionRequests: [], items, timeline: t,
      cancelReason: slot.status === 'cancelled' ? pick(rng, CANCEL_REASONS) : undefined,
      holdReason: slot.status === 'on_hold' ? pick(rng, HOLD_REASONS) : undefined,
    }
  }

  // fixed 10 orders
  for (const spec of fixedSpecs) {
    const placed = new Date(2026, 0, spec.placed[0], spec.placed[1], spec.placed[2])
    const store = stores.find((s) => s.id === spec.storeId)!
    const cust = fixedCustomers[spec.name]!
    const storeVariantsList = storeVariants.filter((sv) => sv.storeId === store.id && sv.available).map((sv) => variants.find((v) => v.id === sv.variantId)!)
    const { items, fee } = exactFitItems(spec.amount, storeVariantsList)
    const t: Order['timeline'] = { placed: iso(placed), confirmed: plusMin(placed, 6) }
    if (spec.status === 'picking') t.picked = plusMin(placed, 14)
    if (spec.status === 'delivered') { t.picked = plusMin(placed, 18); t.ready = plusMin(placed, 21); t.outForDelivery = plusMin(placed, 21); t.delivered = plusMin(placed, 24) }
    if (spec.status === 'out_for_delivery') { t.picked = plusMin(placed, 24); t.ready = plusMin(placed, 30); t.outForDelivery = plusMin(placed, 36) }
    if (spec.status === 'on_hold') t.held = plusMin(placed, 40)
    orders.push({
      id: `DD${spec.num}`, storeId: store.id, customerId: cust.id, customerName: cust.name,
      customerPhone: cust.phone, customerAvatar: cust.avatar,
      amount: items.reduce((a, i) => a + i.total, 0) + fee, deliveryFee: fee, discount: 0,
      paymentMethod: spec.method, status: spec.status, placedAt: iso(placed),
      riderId: spec.status === 'out_for_delivery' ? riders.find((r) => r.name === 'Rahul More')!.id : spec.status === 'delivered' ? riders.find((r) => r.name === 'Sandeep Patil')!.id : null,
      deliveryCode: String(4000 + spec.num - 10480), deliveryCodeLocked: spec.attention === 'code_locked',
      wrongAddressReportedAt: spec.attention === 'wrong_address' ? plusMin(placed, 50) : undefined,
      requiresAttention: !!spec.attention, attentionReason: spec.attention,
      holdReason: spec.status === 'on_hold' ? 'Customer requested hold' : undefined,
      correctionRequests: [], items, timeline: t,
    })
  }
  // random orders
  let slotIdx = 0
  for (const row of orderSeedRows) {
    const slot = shuffledSlots[slotIdx++]!
    orders.push(buildOrder(row, slot, idNum++))
  }
  // mark attention rows beyond the fixed set
  const attentionPool = shuffle(rng, orders.filter((o) => Number(o.id.slice(2)) < 10480))
  let aIdx = 0
  for (let k = 0; k < 4; k++) { const o = attentionPool[aIdx++]!; o.attentionReason = 'wrong_address'; o.wrongAddressReportedAt = plusMin(new Date(o.placedAt), 60); o.requiresAttention = true }
  for (let k = 0; k < 3; k++) { const o = attentionPool[aIdx++]!; o.attentionReason = 'code_locked'; o.deliveryCodeLocked = true; o.requiresAttention = true }
  for (let k = 0; k < 3; k++) { const o = attentionPool[aIdx++]!; o.attentionReason = 'payment_failed'; o.requiresAttention = true }

  // ── Payment attempts (gateway) ──
  const paymentAttempts: PaymentAttempt[] = []
  let attemptNo = 928374
  const sortedOrders = [...orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt))
  for (const o of sortedOrders) {
    if (o.paymentMethod === 'cod') continue // no gateway attempt until COD is collected
    if (o.paymentMethod === 'wallet') continue // wallet payments live in the wallet ledger
    const amount = o.amount
    if (o.attentionReason === 'payment_failed') {
      paymentAttempts.push({ id: `TXN${attemptNo--}`, orderId: o.id, attemptNo: 1, method: o.paymentMethod, amount, status: 'failed', gateway: 'GatewayPro', failureReason: pick(rng, ['Insufficient funds', 'Bank decline', 'UPI timeout']), at: o.placedAt })
    } else {
      paymentAttempts.push({ id: `TXN${attemptNo--}`, orderId: o.id, attemptNo: 1, method: o.paymentMethod, amount, status: 'captured', gateway: 'GatewayPro', gatewayRef: `GP${int(rng, 100000, 999999)}`, at: o.placedAt })
    }
  }
  // some failed-then-recovered attempts
  const recovered = orders.filter((o) => o.paymentMethod !== 'cod' && o.attentionReason !== 'payment_failed').slice(0, 34)
  for (const o of recovered) {
    if (o.paymentMethod === 'cod' || o.paymentMethod === 'wallet') continue
    paymentAttempts.push({ id: `TXN${attemptNo--}`, orderId: o.id, attemptNo: 2, method: o.paymentMethod, amount: o.amount, status: 'failed', gateway: 'GatewayPro', failureReason: 'UPI timeout', at: plusMin(new Date(o.placedAt), 1) })
  }

  // ── Refunds (statuses exactly as returned; Σ paid computed) ──
  const refunds: Refund[] = []
  const refundedCancelOrders = shuffle(rng, orders.filter((o) => o.status === 'cancelled' && o.paymentMethod !== 'cod')).slice(0, 24)
  refundedCancelOrders.forEach((o, i) => {
    const status: Refund['status'] = i < 17 ? 'paid' : i < 20 ? 'processing' : i < 22 ? 'requested' : 'failed'
    refunds.push({
      id: `RF-${o.id}`, orderId: o.id, amount: o.amount, status,
      reason: o.cancelReason ?? 'Order cancelled', source: 'system',
      createdAt: o.timeline.cancelled ?? o.placedAt,
      paidAt: status === 'paid' ? plusMin(new Date(o.timeline.cancelled ?? o.placedAt), int(rng, 60, 600)) : undefined,
      evidence: status === 'paid' && i % 5 === 0 ? { reference: `MBR${int(rng, 100000, 999999)}`, fileName: 'manual-refund-proof.pdf' } : undefined,
    })
  })
  const dd10487 = orders.find((o) => o.id === 'DD10487')!
  refunds.push({ id: 'RF-DD10487', orderId: 'DD10487', amount: 120, status: 'paid', reason: 'Item out of stock – partial refund', source: 'admin', createdAt: D(24, 10, 30), paidAt: D(24, 10, 45), evidence: { reference: 'MBR220451', fileName: 'upi-receipt.png' } })
  // a few requested refunds on delivered orders (support/admin raised, pending review)
  const refundCandidates = shuffle(rng, orders.filter((o) => o.status === 'delivered' && o.paymentMethod !== 'cod' && !refunds.some((r) => r.orderId === o.id)))
  for (let k = 0; k < 4; k++) {
    const o = refundCandidates[k]!
    refunds.push({ id: `RF-${o.id}`, orderId: o.id, amount: r5(o.amount * 0.5), status: k < 2 ? 'requested' : 'processing', reason: pick(rng, ['Missing item', 'Late delivery compensation', 'Quality issue']), source: k === 0 ? 'support' : 'admin', createdAt: D(24, int(rng, 8, 10), int(rng, 0, 59)) })
  }
  const paidRefundsTotal = refunds.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount, 0)

  // ── Wallet ledger (top-ups / payments / refund credits / authorized adjustments) ──
  const walletLedger: WalletLedgerEntry[] = []
  const walletCustomers = shuffle(rng, customers).slice(0, 60)
  const balances = new Map<string, number>()
  let wlNo = 1
  const pushWl = (c: Customer, type: WalletLedgerEntry['type'], amount: number, reason: string, at: string, authorizedBy?: string) => {
    const bal = (balances.get(c.id) ?? 0) + amount
    balances.set(c.id, bal)
    walletLedger.push({ id: `WL${String(wlNo++).padStart(5, '0')}`, customerId: c.id, customerName: c.name, type, amount, balanceAfter: bal, reason, at, authorizedBy })
  }
  for (let d = 1; d <= 24; d++) {
    for (let k = 0; k < int(rng, 8, 16); k++) {
      const c = pick(rng, walletCustomers)
      pushWl(c, 'topup', r5(pick(rng, [200, 300, 500, 500, 1000, 2000])), 'Wallet top-up via UPI', D(d, int(rng, 6, 21), int(rng, 0, 59)))
    }
  }
  for (const o of orders.filter((x) => x.paymentMethod === 'wallet' && x.status !== 'cancelled').slice(0, 150)) {
    const c = customers.find((x) => x.id === o.customerId)!
    pushWl(c, 'order_payment', -o.amount, `Payment for #${o.id}`, o.placedAt)
  }
  for (const r of refunds.filter((x) => x.status === 'paid')) {
    const o = orders.find((x) => x.id === r.orderId)!
    if (o.paymentMethod === 'wallet') {
      const c = customers.find((x) => x.id === o.customerId)!
      pushWl(c, 'refund_credit', r.amount, `Refund for #${o.id}`, r.paidAt ?? r.createdAt)
    }
  }
  for (let k = 0; k < 5; k++) {
    const c = pick(rng, walletCustomers)
    pushWl(c, 'adjustment', pick(rng, [-50, 50, 100]), pick(rng, ['Goodwill credit — late delivery', 'Loyalty correction', 'Duplicate top-up reversal']), D(int(rng, 20, 24), int(rng, 9, 18), int(rng, 0, 59)), 'Arjun Mehta')
  }
  const walletTopUpsTotal = walletLedger.filter((e) => e.type === 'topup').reduce((a, e) => a + e.amount, 0)

  // ── Inventory: stock levels, batches, movements ──
  const stockLevels: StockLevel[] = []
  const stockBatches: StockBatch[] = []
  for (const s of stores) {
    for (const v of variants) {
      const available = storeVariants.some((sv) => sv.storeId === s.id && sv.variantId === v.id && sv.available)
      if (!available) continue
      const qty = int(rng, 4, 180)
      stockLevels.push({ storeId: s.id, variantId: v.id, qty, lowStockThreshold: int(rng, 15, 30) })
    }
  }
  // low stock rows (below threshold)
  const lowStockTargets = shuffle(rng, stockLevels).slice(0, 14)
  for (const row of lowStockTargets) row.qty = int(rng, 1, Math.max(2, row.lowStockThreshold - 2))
  // batches incl. expiring soon (≤ 7 days from demo date)
  const perishable = variants.filter((v) => ['v-011', 'v-012', 'v-021', 'v-041', 'v-042', 'v-051', 'v-061', 'v-071', 'v-101', 'v-111'].includes(v.id))
  for (const s of stores.slice(0, 6)) {
    for (const v of perishable) {
      const daysOut = pick(rng, [2, 3, 4, 5, 6, 9, 14, 20, 45, 120])
      stockBatches.push({ id: `b-${s.id}-${v.id}`, storeId: s.id, variantId: v.id, qty: int(rng, 6, 60), expiryDate: iso(new Date(2026, 0, 24 + daysOut)) })
    }
  }
  const movements: InventoryMovement[] = []
  let mvNo = 1
  for (let d = 1; d <= 24; d++) {
    for (let k = 0; k < int(rng, 12, 20); k++) {
      const s = pick(rng, stores)
      const v = pick(rng, variants)
      const type = pick(rng, ['sale', 'sale', 'sale', 'receipt', 'adjustment', 'damage', 'expiry', 'transfer'] as MovementType[])
      const flagged = type === 'damage' || type === 'expiry' || (type === 'adjustment' && chance(rng, 0.18))
      movements.push({
        id: `MV${String(mvNo++).padStart(5, '0')}`, storeId: s.id, variantId: v.id, type,
        qtyDelta: type === 'receipt' ? int(rng, 20, 120) : type === 'sale' ? -int(rng, 1, 12) : type === 'transfer' ? int(rng, 5, 40) : -int(rng, 1, 14),
        reason: type === 'receipt' ? 'Morning stock receipt' : type === 'sale' ? 'Customer order dispatch' : type === 'damage' ? pick(rng, ['Broken during handling', 'Leaked pouch']) : type === 'expiry' ? 'Expired stock written off' : type === 'transfer' ? 'Transfer to sister store' : pick(rng, ['Cycle correction', 'System recount', 'Unexplained variance']),
        actor: managers.find((m) => m.storeId === s.id)?.name ?? 'Store system',
        at: D(d, int(rng, 5, 22), int(rng, 0, 59)),
        flagged, flagReason: type === 'damage' ? 'damage' : type === 'expiry' ? 'expiry' : flagged ? 'unusual_adjustment' : undefined,
      })
    }
  }

  // ── Rider payouts & COD offsets ──
  const payouts: Payout[] = []
  const payoutCorrections: PayoutCorrection[] = []
  const cycles = [
    { period: '27 Dec – 02 Jan', end: 3, paid: true },
    { period: '03 – 09 Jan', end: 10, paid: true },
    { period: '10 – 16 Jan', end: 17, paid: true },
    { period: '17 – 23 Jan', end: 24, paid: false },
  ]
  let pyNo = 1
  for (const cyc of cycles) {
    for (const rider of activeRiders) {
      const deliveries = Math.round(rider.deliveriesPeriod / 4)
      const gross = r5(deliveries * 38)
      const codCollected = r5(deliveries * 12 * (0.4 + rng() * 0.6))
      const adjustments = pick(rng, [0, 0, 0, -50, 100])
      const net = gross + adjustments
      let status: Payout['status'] = cyc.paid ? 'paid' : 'pending_review'
      if (cyc.paid && rider.id === 'rd-1') status = 'failed'
      if (!cyc.paid && (rider.id === 'rd-2' || rider.id === 'rd-3')) status = 'approved'
      if (!cyc.paid && rider.id === 'rd-4') status = 'on_hold'
      payouts.push({
        id: `PO-${String(pyNo++).padStart(3, '0')}`, riderId: rider.id, riderName: rider.name, storeId: rider.storeId,
        period: cyc.period, deliveriesCount: deliveries, grossAmount: gross, codCollected, adjustments, netAmount: net,
        status, canApprove: status === 'pending_review',
        approvedAt: status !== 'pending_review' ? D(cyc.end, 12, 0) : undefined,
        paidAt: status === 'paid' ? D(cyc.end, 18, int(rng, 0, 59)) : undefined,
        paymentReference: status === 'paid' ? `UPI/NDTL/${int(rng, 100000, 999999)}` : undefined,
        evidenceFileName: status === 'paid' && chance(rng, 0.4) ? 'payout-proof.pdf' : undefined,
        holdReason: status === 'on_hold' ? 'Rider documents under re-verification' : undefined,
      })
    }
  }
  // corrections & COD offsets
  const pcDefs: Array<[string, PayoutCorrection['kind'], number, string, string]> = [
    ['PO-001', 'correction', 120, 'Missing delivery incentive added', D(5, 10, 0)],
    ['PO-002', 'cod_offset', -340, 'COD shortfall adjusted against payout', D(5, 12, 0)],
    ['PO-005', 'correction', -90, 'Excess distance bonus reversed', D(11, 9, 0)],
    ['PO-007', 'cod_offset', -210, 'Two COD remittances short', D(11, 15, 0)],
    ['PO-013', 'correction', 150, 'Rain incentive applied', D(18, 10, 0)],
    ['PO-018', 'cod_offset', -180, 'COD packet returned uncollected', D(18, 14, 0)],
    ['PO-025', 'correction', 60, 'Festival bonus correction', D(23, 11, 0)],
    ['PO-026', 'cod_offset', -120, 'COD to be remitted with next cycle', D(23, 16, 0)],
  ]
  for (const [pid, kind, amount, reason, at] of pcDefs) {
    const p = payouts.find((x) => x.id === pid) ?? payouts[0]!
    payoutCorrections.push({ id: `PC-${payoutCorrections.length + 1}`, payoutId: p.id, kind, amount, reason, at })
  }

  // ── Reconciliation findings & fraud ──
  const reconciliationFindings: ReconciliationFinding[] = [
    { id: 'RC-01', kind: 'mismatch', ref: '#DD10221', summary: 'Gateway settlement ₹40 lower than captured amount', expected: 1240, actual: 1200, status: 'open', at: D(22, 9, 15) },
    { id: 'RC-02', kind: 'unresolved_payment', ref: 'TXN927881', summary: 'Captured at gateway but no order linked', expected: 660, actual: 0, status: 'open', at: D(22, 14, 40) },
    { id: 'RC-03', kind: 'missing_payout', ref: 'PO-014', summary: 'Payout marked paid but bank file row missing', expected: 4830, actual: 0, status: 'investigating', at: D(23, 10, 5) },
    { id: 'RC-04', kind: 'mismatch', ref: '#DD09913', summary: 'Duplicate capture reversed partially', expected: 430, actual: 415, status: 'open', note: 'Waiting for gateway confirmation', at: D(23, 16, 22) },
    { id: 'RC-05', kind: 'unresolved_payment', ref: 'TXN927654', summary: 'Webhook retry pending for capture event', expected: 890, actual: 890, status: 'resolved', note: 'Auto-resolved after webhook replay', at: D(20, 11, 30) },
    { id: 'RC-06', kind: 'missing_payout', ref: 'PO-029', summary: 'COD remittance attached to wrong cycle', expected: 2140, actual: 0, status: 'open', at: D(24, 8, 45) },
  ]
  const fraudFindings: FraudFinding[] = [
    { id: 'FR-001', ref: 'C10021', kind: 'refund_abuse', riskLevel: 'high', summary: '7 refunds in 10 days on different orders, same device', status: 'open', at: D(23, 9, 0) },
    { id: 'FR-002', ref: '#DD09874', kind: 'promo_abuse', riskLevel: 'medium', summary: 'Coupon MILK15 used 11× across linked accounts', status: 'open', at: D(22, 15, 10) },
    { id: 'FR-003', ref: 'C10026', kind: 'account_takeover', riskLevel: 'high', summary: 'Login from 3 cities within an hour; password reset twice', status: 'confirmed', at: D(21, 19, 45) },
    { id: 'FR-004', ref: 'RD-11', kind: 'cod_shortfall', riskLevel: 'medium', summary: 'Repeated short COD remittance at same store', status: 'open', at: D(23, 12, 20) },
    { id: 'FR-005', ref: 'C10188', kind: 'promo_abuse', riskLevel: 'low', summary: 'Referral code self-usage pattern', status: 'cleared', note: 'Verified as family account', at: D(19, 10, 0) },
  ]

  // ── Invoice failures ──
  const invoiceFailures: InvoiceFailure[] = [
    { id: 'INV-901', invoiceId: 'DDR-2026-004512', orderId: '#DD10102', reason: 'Template render timeout (gateway slow)', status: 'suspended', causeFixed: true, at: D(23, 8, 20) },
    { id: 'INV-902', invoiceId: 'DDL-2026-000981', orderId: '#DD10155', reason: 'Legal entity GSTIN field empty on invoice template', status: 'suspended', causeFixed: false, at: D(23, 9, 40) },
    { id: 'INV-903', invoiceId: 'DDN-2026-000443', orderId: '#DD10234', reason: 'Storage temporarily unavailable', status: 'suspended', causeFixed: true, at: D(24, 7, 55) },
    { id: 'INV-904', invoiceId: 'DDR-2026-004530', orderId: '#DD10298', reason: 'Queued — waiting for renderer slot', status: 'rendering', causeFixed: false, at: D(24, 10, 12) },
  ]

  // ── Coupons & push campaigns ──
  const coupons: Coupon[] = [
    { id: 'cp-1', code: 'DAIRY10', kind: 'percentage', value: 10, minOrderValue: 300, startsOn: '2026-01-01', endsOn: '2026-01-31', usageLimit: 500, usedCount: 312, eligibleStoreIds: stores.slice(0, 5).map((s) => s.id), eligibleProductIds: products.slice(0, 5).map((p) => p.id), status: 'active' },
    { id: 'cp-2', code: 'FRESH50', kind: 'flat', value: 50, minOrderValue: 400, startsOn: '2026-01-01', endsOn: '2026-01-31', usageLimit: 300, usedCount: 128, eligibleStoreIds: stores.map((s) => s.id), eligibleProductIds: products.map((p) => p.id), status: 'active' },
    { id: 'cp-3', code: 'GHEE20', kind: 'percentage', value: 20, minOrderValue: 800, startsOn: '2026-01-05', endsOn: '2026-01-31', usageLimit: 150, usedCount: 41, eligibleStoreIds: [stores[0]!.id, stores[1]!.id], eligibleProductIds: products.filter((p) => p.categoryId === 'cat-ghee').map((p) => p.id), status: 'active' },
    { id: 'cp-4', code: 'MILK15', kind: 'percentage', value: 15, minOrderValue: 250, startsOn: '2026-01-01', endsOn: '2026-01-31', usageLimit: 400, usedCount: 259, eligibleStoreIds: stores.map((s) => s.id), eligibleProductIds: products.filter((p) => p.categoryId === 'cat-milk').map((p) => p.id), status: 'active' },
    { id: 'cp-5', code: 'FREEDLY', kind: 'free_delivery', value: 0, minOrderValue: 499, startsOn: '2026-01-10', endsOn: '2026-01-31', usageLimit: 1000, usedCount: 487, eligibleStoreIds: stores.map((s) => s.id), eligibleProductIds: products.map((p) => p.id), status: 'active' },
    { id: 'cp-6', code: 'NEWYEAR75', kind: 'flat', value: 75, minOrderValue: 999, startsOn: '2026-01-26', endsOn: '2026-01-31', usageLimit: 200, usedCount: 0, eligibleStoreIds: stores.map((s) => s.id), eligibleProductIds: products.filter((p) => p.publishState === 'published').map((p) => p.id), status: 'scheduled' },
    { id: 'cp-7', code: 'WELCOME25', kind: 'flat', value: 25, minOrderValue: 199, startsOn: '2025-11-01', endsOn: '2026-03-31', usageLimit: 1000, usedCount: 643, eligibleStoreIds: stores.map((s) => s.id), eligibleProductIds: products.map((p) => p.id), status: 'active' },
    { id: 'cp-8', code: 'SANKRANTI', kind: 'percentage', value: 25, minOrderValue: 599, startsOn: '2025-12-20', endsOn: '2026-01-14', usageLimit: 100, usedCount: 98, eligibleStoreIds: stores.slice(0, 4).map((s) => s.id), eligibleProductIds: products.map((p) => p.id), status: 'expired' },
  ]
  const pushCampaigns: PushCampaign[] = [
    { id: 'pmc-1', name: 'New Year Dairy Fest push', audience: 'all_customers', selectedUserIds: [], title: 'Fresh dairy, festive prices 🥛', body: 'Enjoy 20% off on ghee and paneer baskets till 31 Jan.', status: 'sent', scheduledAt: undefined, sentAt: '2025-12-26T09:00:00.000Z', recipients: 28140 },
    { id: 'pmc-2', name: 'Republic Day COD reminder', audience: 'selected_users', selectedUserIds: customers.slice(0, 40).map((c) => c.id), title: 'COD now available in your area', body: 'Pay cash on delivery for orders up to ₹5,000. Order today!', status: 'scheduled', scheduledAt: '2026-01-26T08:00:00.000Z', recipients: 40 },
    { id: 'pmc-3', name: 'Winter lassi comeback (draft)', audience: 'subscription_users', selectedUserIds: [], title: 'Your winter favourite is back', body: 'Sweet lassi has returned to the catalog — try it with breakfast.', status: 'draft', recipients: 0 },
  ]

  // ── Admin's own notifications ──
  const adminNotifications: AdminNotification[] = [
    { id: 'n-1', title: 'Payout batch ready for review', body: '5 rider payouts for 17 – 23 Jan are pending review', kind: 'payout', at: D(24, 8, 30), read: false },
    { id: 'n-2', title: 'Price change needs approval', body: 'Ghee 500 ml ₹220 → ₹240 requested by Baner Store manager', kind: 'approval', at: D(24, 8, 10), read: false },
    { id: 'n-3', title: 'Refund requested', body: '₹270 refund requested from ticket TCK-2041 (missing item)', kind: 'support', at: D(24, 9, 12), read: false },
    { id: 'n-4', title: 'Powai picking backlog high', body: '38 orders in picking queue — above threshold 30', kind: 'store', at: D(24, 9, 40), read: false },
    { id: 'n-5', title: 'Order #DD10484 put on hold', body: 'Stock unconfirmed at Powai Store', kind: 'order', at: D(24, 10, 5), read: true },
    { id: 'n-6', title: 'Reconciliation finding opened', body: 'Gateway settlement mismatch on #DD10221', kind: 'system', at: D(22, 9, 15), read: true },
    { id: 'n-7', title: 'Rider application submitted', body: 'Deepak Jadhav applied at Panchavati Store', kind: 'store', at: D(23, 17, 45), read: true },
    { id: 'n-8', title: 'Subscription run partial', body: 'Jan 23 run: 3 generations failed — retry available', kind: 'system', at: D(23, 21, 5), read: true },
  ]

  // ── Subscriptions config ──
  const deliverySlots: DeliverySlot[] = [
    { id: 'slot-1', label: 'Early morning', window: '06:00 – 08:00' },
    { id: 'slot-2', label: 'Morning', window: '08:00 – 10:00' },
    { id: 'slot-3', label: 'Evening', window: '18:00 – 20:00' },
    { id: 'slot-4', label: 'Night', window: '20:00 – 22:00' },
  ]
  const subscriptionHolidays: SubscriptionHoliday[] = [
    { date: '2026-01-26', name: 'Republic Day — no deliveries' },
    { date: '2026-03-04', name: 'Holi — no milk subscriptions' },
    { date: '2026-01-28', name: 'Baner Store maintenance' },
  ]
  const subscriptionRuns: SubscriptionRun[] = []
  for (let d = 1; d <= 24; d++) {
    const generated = int(rng, 880, 1100)
    let status: SubscriptionRun['status'] = 'completed'
    const failures: SubscriptionRun['failures'] = []
    if (d === 23) {
      status = 'partial'
      for (const f of [['SUB-8821', 'Ananya Sharma', 'Variant out of stock at Powai Store'], ['SUB-7312', 'Vedant Tiwari', 'Store paused at slot time'], ['SUB-9044', 'Karan Mehra', 'Delivery slot closed']]) {
        failures.push({ subscriptionRef: f[0], customerName: f[1], reason: f[2], retryable: true })
      }
    } else if (d === 14) {
      status = 'partial'
      failures.push({ subscriptionRef: 'SUB-6614', customerName: 'Divya Raghavan', reason: 'Payment on file declined', retryable: true })
    } else if (d === 8) {
      status = 'failed'
      failures.push({ subscriptionRef: 'RUN-ALL', customerName: '—', reason: 'Generator worker crashed (OOM)', retryable: true }, { subscriptionRef: 'SUB-4120', customerName: 'Onkar Teli', reason: 'Not generated — run aborted', retryable: true })
    }
    subscriptionRuns.push({ id: `run-${String(d).padStart(2, '0')}`, date: D(d, 4, 30), generated: status === 'failed' ? 0 : generated, status, failures })
  }

  // ── Support tickets, saved responses, ratings ──
  const savedResponses: SavedResponse[] = [
    { id: 'sr-1', title: 'Refund initiated', body: 'Your refund has been initiated and will reflect in 3–5 working days depending on your bank.' },
    { id: 'sr-2', title: 'Wrong item delivered', body: 'We are sorry about the mix-up. Please keep the item; our rider will collect it and the correct one will be delivered today.' },
    { id: 'sr-3', title: 'Delivery slot change', body: 'Your delivery slot has been updated as requested. The new window applies from your next order.' },
    { id: 'sr-4', title: 'Wallet credit note', body: 'The goodwill credit has been added to your wallet and can be used on your next order.' },
    { id: 'sr-5', title: 'Password reset guide', body: 'Use "Forgot password" on the login screen. The reset link is valid for 30 minutes.' },
  ]
  const tickets: Ticket[] = []
  const ticketDefs: Array<[string, string, Ticket['category'], Ticket['status'], Ticket['priority'], string | null, string | undefined, string]> = [
    ['TCK-2041', 'Missing paneer in order #DD10188', 'order_issue', 'open', 'high', 'C10006', 'DD10188', D(24, 8, 12)],
    ['TCK-2042', 'Refund not received for cancelled order', 'refund_request', 'pending', 'high', 'C10011', 'DD10074', D(24, 7, 40)],
    ['TCK-2043', 'Wrong item delivered — flavored milk', 'order_issue', 'open', 'normal', 'C10001', 'DD10488', D(24, 10, 30)],
    ['TCK-2044', 'Wallet top-up debited twice', 'payment', 'pending', 'high', 'C10033', undefined, D(24, 6, 55)],
    ['TCK-2045', 'Rider behaviour complaint', 'other', 'open', 'normal', 'C10018', undefined, D(23, 19, 10)],
    ['TCK-2046', 'App shows delivered but not received', 'order_issue', 'open', 'high', 'C10022', 'DD10221', D(23, 18, 5)],
    ['TCK-2038', 'Cannot login — OTP issues', 'account', 'pending', 'normal', 'C10027', undefined, D(23, 11, 25)],
    ['TCK-2035', 'Curd packet leaked', 'product_quality', 'open', 'low', 'C10030', 'DD10145', D(22, 20, 15)],
    ['TCK-2031', 'Change delivery address permanently', 'account', 'pending', 'low', 'C10035', undefined, D(22, 12, 0)],
    ['TCK-2028', 'Invoice GSTIN incorrect', 'payment', 'open', 'normal', 'C10039', 'DD09961', D(21, 15, 45)],
    ['TCK-2024', 'Milk smelled off', 'product_quality', 'open', 'high', 'C10042', 'DD09902', D(21, 8, 30)],
    ['TCK-2021', 'Subscription not generated today', 'other', 'pending', 'normal', 'C10046', 'DD09871', D(23, 4, 50)],
  ]
  const resolvedRefs: Array<[string, string, Ticket['category'], string | undefined, string]> = [
    ['TCK-2016', 'Late delivery compensation', 'order_issue', 'DD09650', D(20, 10, 0)],
    ['TCK-2011', 'OTP not accepted at delivery', 'order_issue', 'DD09544', D(19, 16, 20)],
    ['TCK-2008', 'Double charge on UPI', 'payment', 'DD09501', D(18, 9, 35)],
    ['TCK-2005', 'Rider asked for extra cash', 'other', 'DD09487', D(17, 18, 10)],
    ['TCK-2002', 'Butter pack damaged', 'product_quality', 'DD09412', D(16, 11, 5)],
    ['TCK-1999', 'App crash on checkout', 'account', undefined, D(15, 14, 40)],
    ['TCK-1995', 'Subscription slot change request', 'other', undefined, D(14, 10, 15)],
  ]
  let msgNo = 1
  const buildMessages = (first: string, custName: string, count: number, internalOne = false): Ticket['messages'] => {
    const msgs: Ticket['messages'] = [{ id: `m-${msgNo++}`, author: 'customer', body: first, at: '', internal: false }]
    for (let k = 0; k < count; k++) {
      const internal = internalOne && k === count - 1
      msgs.push({
        id: `m-${msgNo++}`, author: internal ? 'admin' : chance(rng, 0.5) ? 'admin' : 'customer',
        body: internal ? 'Checked gateway logs — duplicate capture confirmed, refund queued.' : pick(rng, ['Thanks for the update.', 'Looking into this with the store team.', 'Our rider will reach out shortly.', 'Noted, please prioritize.']),
        at: '', internal,
      })
    }
    return msgs
  }
  for (const [ref, subject, category, status, priority, customerId, orderId, createdAt] of ticketDefs) {
    const cust = customerId ? customers.find((c) => c.id === customerId)! : null
    const messages = buildMessages(subject, cust?.name ?? 'Guest', int(rng, 1, 3), chance(rng, 0.4))
    let at = createdAt
    for (const m of messages) { at = plusMin(new Date(at), int(rng, 20, 180)); m.at = at }
    tickets.push({
      id: ref, ref, subject, category, status, priority,
      customerId: cust?.id ?? null, customerName: cust?.name ?? 'Guest', orderId,
      createdAt, updatedAt: at, messages,
      attachments: chance(rng, 0.3) ? [
        { id: `at-${ref}-1`, name: 'photo-of-item.jpg', sizeKb: int(rng, 120, 900), authorized: true },
        ...(chance(rng, 0.4) ? [{ id: `at-${ref}-2`, name: 'bank-statement.pdf', sizeKb: int(rng, 200, 800), authorized: chance(rng, 0.7) }] : []),
      ] : [],
    })
  }
  for (const [ref, subject, category, orderId, createdAt] of resolvedRefs) {
    const cust = pick(rng, customers)
    const status: Ticket['status'] = chance(rng, 0.6) ? 'resolved' : 'closed'
    const messages = buildMessages(subject, cust.name, 2)
    let at = createdAt
    for (const m of messages) { at = plusMin(new Date(at), int(rng, 20, 180)); m.at = at }
    tickets.push({
      id: ref, ref, subject, category, status, priority: 'normal', customerId: cust.id, customerName: cust.name, orderId,
      createdAt, updatedAt: at, messages, attachments: [],
    })
  }
  // ratings
  const ratings: Rating[] = []
  const ratedOrders = shuffle(rng, orders.filter((o) => o.status === 'delivered')).slice(0, 40)
  ratedOrders.forEach((o, i) => {
    const stars = i < 6 ? 2 : i < 14 ? 3 : i < 30 ? 4 : 5
    const moderationRequired = stars <= 2 || (stars === 3 && chance(rng, 0.3))
    ratings.push({
      id: `rt-${1000 + i}`, orderId: o.id, storeId: o.storeId, customerName: o.customerName,
      stars, comment: stars >= 4 ? pick(rng, ['Fresh and on time.', 'Great morning delivery.', 'Loved the paneer.']) : pick(rng, ['Milk was warm on arrival.', 'Delivery 40 minutes late.', 'Packaging leaked.', 'Curd was sour before expiry.']),
      at: plusMin(new Date(o.timeline.delivered ?? o.placedAt), int(rng, 60, 700)),
      moderationRequired,
      moderationStatus: moderationRequired ? (i < 5 ? 'pending' : 'approved') : 'approved',
      moderationReason: moderationRequired && i >= 5 ? 'Contains competitor brand name' : undefined,
    })
  })
  ratings.push({ id: 'rt-1099', orderId: 'DD09874', storeId: 'st-1', customerName: customers[26]!.name, stars: 1, comment: 'Absolute nonsense service #DairyDirectSucks — try Amul instead', at: D(22, 10, 0), moderationRequired: true, moderationStatus: 'removed', moderationReason: 'Abusive language + competitor spam' })
  ratings.push({ id: 'rt-1098', orderId: 'DD09821', storeId: 'st-3', customerName: customers[31]!.name, stars: 2, comment: 'Driver was rude on phone', at: D(21, 18, 0), moderationRequired: true, moderationStatus: 'pending' })

  // ── Approvals, erasure, holds ──
  const approvals: Approval[] = [
    { id: 'ap-1', action: 'Variant price change', targetType: 'variant_price', targetLabel: `Ghee – 500 ml (${ghee500.sku})`, details: 'Price ₹220 → ₹240 (+9.1%)', reason: 'Cream input cost up 8% this month', requesterName: 'Priya Kamat', requesterRole: 'Store manager (Baner Store)', status: 'pending', requestedAt: D(24, 8, 10), canApprove: true, expiresAt: D(31, 23, 59) },
    { id: 'ap-2', action: 'Variant price change', targetType: 'variant_price', targetLabel: `Cow Milk – 1 L (${variants.find((v) => v.id === 'v-012')!.sku})`, details: 'Price ₹75 → ₹78 (+4%)', reason: 'Align with store-level cost revision', requesterName: 'Rohit Kulkarni', requesterRole: 'Store manager (Colaba Fresh Store)', status: 'pending', requestedAt: D(24, 7, 40), canApprove: true, expiresAt: D(31, 23, 59) },
    { id: 'ap-3', action: 'Variant price change', targetType: 'variant_price', targetLabel: `Paneer – 500 g (${variants.find((v) => v.id === 'v-062')!.sku})`, details: 'Price ₹280 → ₹295 (+5.4%)', reason: 'Festive demand pricing window', requesterName: 'Kavya Deshpande', requesterRole: 'Store manager (Andheri West Store)', status: 'pending', requestedAt: D(23, 18, 20), canApprove: true, expiresAt: D(30, 23, 59) },
    { id: 'ap-4', action: 'Role change — admin access', targetType: 'workforce_role', targetLabel: 'Meghna Rao (Support agent)', details: 'Role: support_agent → admin', reason: 'Covering ops during audit week', requesterName: 'Arjun Mehta', requesterRole: 'Admin', status: 'pending', requestedAt: D(24, 6, 15), canApprove: false, cannotApproveReason: 'Policy: role changes to Admin cannot be approved by the requesting admin — needs another admin', expiresAt: D(31, 23, 59) },
    { id: 'ap-5', action: 'Refund override', targetType: 'refund_override', targetLabel: 'Order #DD09913', details: 'Full refund ₹430 outside 7-day window', reason: 'Compensation for repeated late deliveries', requesterName: 'Lalita Bisht', requesterRole: 'Support agent', status: 'pending', requestedAt: D(23, 20, 5), canApprove: true, expiresAt: D(28, 23, 59) },
    { id: 'ap-6', action: 'Product publish', targetType: 'product_publish', targetLabel: 'Butter – 500 g', details: 'Publish to all stores in Pune', reason: 'Butter trial succeeded at 2 stores', requesterName: 'Nilesh Bhosale', requesterRole: 'Store manager (Dharampeth Store)', status: 'pending', requestedAt: D(24, 9, 30), canApprove: true, expiresAt: D(31, 23, 59) },
    { id: 'ap-7', action: 'Variant price change', targetType: 'variant_price', targetLabel: `Curd – 400 g (${variants.find((v) => v.id === 'v-101')!.sku})`, details: 'Price ₹60 → ₹65 (+8.3%)', reason: ' approved after cost check', requesterName: 'Priya Kamat', requesterRole: 'Store manager (Baner Store)', status: 'completed', requestedAt: D(21, 10, 0), decidedAt: D(21, 15, 30), decidedBy: 'Arjun Mehta', canApprove: false, expiresAt: D(28, 23, 59) },
    { id: 'ap-8', action: 'Role change — admin access', targetType: 'workforce_role', targetLabel: 'Farhan Qureshi (Support agent)', details: 'Role: support_agent → admin', reason: 'Promotion approved by leadership', requesterName: 'Arjun Mehta', requesterRole: 'Admin', status: 'completed', requestedAt: D(18, 9, 0), decidedAt: D(18, 17, 0), decidedBy: 'Arjun Mehta', canApprove: false, expiresAt: D(25, 23, 59) },
    { id: 'ap-9', action: 'Coupon config', targetType: 'coupon_config', targetLabel: 'SANKRANTI', details: 'Increase usage limit 100 → 300', reason: 'Higher redemption than planned', requesterName: 'Meghna Rao', requesterRole: 'Support agent', status: 'rejected', requestedAt: D(12, 11, 0), decidedAt: D(13, 9, 0), decidedBy: 'Arjun Mehta', canApprove: false, expiresAt: D(19, 23, 59) },
    { id: 'ap-10', action: 'Variant price change', targetType: 'variant_price', targetLabel: `Chaas – 200 ml (${variants.find((v) => v.id === 'v-041')!.sku})`, details: 'Price ₹20 → ₹25 (+25%)', reason: 'Stale request — never decided', requesterName: 'Sameer Joshi', requesterRole: 'Store manager (Powai Store)', status: 'expired', requestedAt: D(10, 9, 0), canApprove: false, cannotApproveReason: 'Request expired on 17 Jan 2026', expiresAt: D(17, 23, 59) },
  ]
  const erasureRequests: ErasureRequest[] = [
    { id: 'er-1', customerId: customers[40]!.id, customerName: customers[40]!.name, requestedAt: D(23, 12, 0), status: 'pending', eligible: true },
    { id: 'er-2', customerId: customers[25]!.id, customerName: customers[25]!.name, requestedAt: D(22, 9, 30), status: 'pending', eligible: false, ineligibleReason: 'Active legal hold LH-1 on this account' },
    { id: 'er-3', customerId: customers[44]!.id, customerName: customers[44]!.name, requestedAt: D(15, 10, 0), status: 'completed', eligible: true, note: 'Account erased on 17 Jan 2026' },
    { id: 'er-4', customerId: customers[45]!.id, customerName: customers[45]!.name, requestedAt: D(12, 16, 0), status: 'rejected', eligible: false, ineligibleReason: 'Open unpaid COD liability' },
  ]
  const legalHolds: LegalHold[] = [
    { id: 'LH-1', subjectName: customers[25]!.name, reason: 'Ongoing fraud investigation FR-003', placedAt: D(21, 14, 0), status: 'active' },
    { id: 'LH-2', subjectName: customers[48]!.name, reason: 'Chargeback dispute with bank', placedAt: D(5, 10, 0), releasedAt: D(19, 12, 0), status: 'released' },
  ]

  // ── Reports & exports ──
  const exportJobs: ExportJob[] = [
    { id: 'ex-1', tab: 'financial', label: 'Financial activity', filtersSummary: '01 Jan – 24 Jan 2026 · all stores', status: 'complete', rowCount: 1248, fileName: 'financial-activity-jan.xlsx', authorized: true, createdAt: D(24, 7, 40), completedAt: D(24, 7, 41) },
    { id: 'ex-2', tab: 'catalog_stock', label: 'Catalog & stock', filtersSummary: 'All stores · low stock only', status: 'complete', rowCount: 14, fileName: 'low-stock-report.xlsx', authorized: true, createdAt: D(23, 18, 20), completedAt: D(23, 18, 21) },
    { id: 'ex-3', tab: 'rider_activity', label: 'Rider activity', filtersSummary: '17 – 23 Jan · all stores', status: 'complete', rowCount: 8, fileName: 'rider-activity-w3.xlsx', authorized: true, createdAt: D(23, 12, 0), completedAt: D(23, 12, 1) },
    { id: 'ex-4', tab: 'picking', label: 'Picking & store performance', filtersSummary: '24 Jan · Mumbai stores', status: 'pending', authorized: true, createdAt: D(24, 10, 40) },
    { id: 'ex-5', tab: 'support', label: 'Support activity', filtersSummary: '01 – 24 Jan · all categories', status: 'failed', authorized: true, createdAt: D(23, 20, 10), error: 'Report renderer timed out after 120s' },
  ]

  // ── Background jobs & operational notifications ──
  const backgroundJobs: BackgroundJob[] = [
    { id: 'job-1', name: 'Invoice render — retry batch', kind: 'invoice_render', status: 'failed', lastRunAt: D(24, 6, 30), attempts: 3, error: 'Renderer timeout after 3 attempts', recovery: 'retry', canRetry: true, retryAfterFix: 'Cause cleared at 07:15 — safe to retry' },
    { id: 'job-2', name: 'Webhook delivery — gateway captures', kind: 'webhook_delivery', status: 'failed', lastRunAt: D(24, 8, 45), attempts: 5, error: 'Gateway endpoint returned 503', recovery: 'retry', canRetry: false, retryAfterFix: 'Gateway status must recover first (monitor)' },
    { id: 'job-3', name: 'Subscription generation — 08 Jan', kind: 'subscription_generate', status: 'failed', lastRunAt: D(8, 4, 30), attempts: 1, error: 'Worker crashed (OOM)', recovery: 'requeue', canRetry: true, retryAfterFix: 'Worker pool has capacity now' },
    { id: 'job-4', name: 'Payout export — week 3', kind: 'payout_export', status: 'failed', lastRunAt: D(23, 22, 10), attempts: 2, error: 'Bank file row count mismatch', recovery: 'retry', canRetry: true, retryAfterFix: 'Re-count finished — mismatch resolved' },
    { id: 'job-5', name: 'Report email — weekly digest', kind: 'report_email', status: 'failed', lastRunAt: D(23, 7, 0), attempts: 1, error: 'SMTP relay rejected sender', recovery: 'skip', canRetry: false, retryAfterFix: 'Digest regenerated from reports anyway' },
    { id: 'job-6', name: 'Subscription generation — 24 Jan', kind: 'subscription_generate', status: 'running', lastRunAt: D(24, 4, 30), attempts: 1, error: undefined, recovery: 'retry', canRetry: false },
  ]
  const operationalNotifications: OperationalNotification[] = [
    { id: 'on-1', title: 'Powai Store picking backlog above threshold', body: '38 orders in picking queue (threshold 30). Consider pausing new orders.', severity: 'warning', at: D(24, 9, 40) },
    { id: 'on-2', title: 'Gateway elevated failure rate', body: 'UPI failures at 4.2% in the last hour (normal ~1.5%).', severity: 'warning', at: D(24, 9, 5) },
    { id: 'on-3', title: 'Invoice renderer recovered', body: 'Renderer slot capacity restored at 07:15; retry batch can run.', severity: 'info', at: D(24, 7, 15) },
    { id: 'on-4', title: 'Andheri West Store paused by manager', body: 'Paused at 06:40 — manager note: stock receipt delayed.', severity: 'critical', at: D(24, 6, 40) },
    { id: 'on-5', title: 'Nirala Bazaar Store paused by admin', body: 'Paused for stock audit; resume expected 25 Jan.', severity: 'info', at: D(23, 21, 0) },
  ]

  // ── System settings (feature flags + business rules) ──
  const systemSettings: SystemSettings = {
    features: { cod: true, wallets: true, subscriptions: true },
    rules: {
      deliveryFee: 40, freeDeliveryAbove: 499, minOrderValue: 149,
      maxOrdersPerSlotPerStore: 120, dispatchRadiusKm: 6, dispatchBatchSize: 8,
      codMaxOrderValue: 5000, walletMaxBalance: 10000, refundWindowDays: 7,
      riderRequiredDocs: ['license', 'id_proof', 'bank_details'],
    },
    subscription: { orderCutoffTime: '20:00', autoRetryFailed: true, defaultSlotId: 'slot-1' },
  }

  // apply the pending approval to the live catalog price (pending state)
  ghee500.price = 220
  products.find((p) => p.id === ghee500.productId)!.pendingApprovalId = 'ap-1'
  products.find((p) => p.id === ghee500.productId)!.pendingChangeLabel = 'Price change pending approval'
  flavored.pendingApprovalId = undefined

  const db = {
    demoNow: iso(DEMO_NOW),
    cities, legalEntities, stores, zones, workforce,
    products, variants, categories, brands, storeVariants,
    stockLevels, stockBatches, movements,
    customers, riders, orders, paymentAttempts, refunds, walletLedger, reconciliationFindings, invoiceFailures,
    payouts, payoutCorrections,
    coupons, pushCampaigns, adminNotifications,
    deliverySlots, subscriptionHolidays, subscriptionRuns,
    savedResponses, tickets, ratings,
    approvals, fraudFindings, erasureRequests, legalHolds,
    exportJobs, backgroundJobs, operationalNotifications, systemSettings,
    meta: {
      salesCaptured: 0, // computed in selectors
      walletTopUpsTotal,
      paidRefundsTotal,
      walletBalances: Object.fromEntries(balances),
    },
  }
  buildStorePortalData(db as DB, rng)
  return db as DB
}
