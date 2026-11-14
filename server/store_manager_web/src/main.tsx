import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreApi, type Application, type Page, type PickItem, type PickTask, type Rider, type StoreOrder, type StoreProfile } from './api';
import { changeTemporaryPassword, forgotPassword, resetPassword, signIn, signOut, type Challenge, type Tokens } from './auth';
import './style.css';

const documentNames: Record<string, string> = { licence: 'Driving licence', vehicle_rc: 'Vehicle registration', id_proof: 'Identity proof', bank_proof: 'Bank proof' };
const statusName = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const completedTasks = (orders: StoreOrder[], storeId: string): PickTask[] => orders
  .filter((order) => order.pickTaskId && order.pickTaskStatus === 'COMPLETED' && ['PICKING', 'PACKED'].includes(order.status))
  .map((order) => ({ id: order.pickTaskId!, orderId: order.orderId, storeId, status: 'COMPLETED', assignedTo: null,
    slaDueAt: order.placedAt ?? new Date().toISOString(), items: [], itemCount: order.itemCount, orderStatus: order.status }));
const uniqueTasks = (items: PickTask[]) => [...new Map(items.map((item) => [item.id, item])).values()];

function Login({ onLogin }: { onLogin: (tokens: Tokens) => Promise<void> }) {
  const [stage, setStage] = useState<'login' | 'newPassword' | 'forgot' | 'reset'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [code, setCode] = useState(''); const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [challenge, setChallenge] = useState<Challenge | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    try {
      if (stage === 'forgot') { await forgotPassword(email.trim()); setStage('reset'); setNotice('If the account is eligible, a verification code has been sent.'); }
      else if (stage === 'reset') { await resetPassword(email.trim(), code.trim(), password); setPassword(''); setStage('login'); setNotice('Password updated. Sign in with your new password.'); }
      else if (stage === 'newPassword' && challenge) { const tokens = await changeTemporaryPassword(challenge, password, attributes); setChallenge(null); await onLogin(tokens); }
      else { const result = await signIn(email.trim(), password); setPassword(''); if ('session' in result) { setChallenge(result); setStage('newPassword'); } else await onLogin(result); }
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  const title = stage === 'login' ? 'Welcome back' : stage === 'newPassword' ? 'Choose a new password' : stage === 'forgot' ? 'Reset your password' : 'Check your email';
  return <main className="login-shell"><section className="login-art"><div className="brand brand-inverse"><img className="brand-mark" src="/logo.png" alt="" /><span>DairyDirect<small>STORE OPERATIONS</small></span></div><div className="art-copy"><span className="eyebrow light">STORE OPERATIONS</span><h1>Your store, ready for the day.</h1><p>Prepare customer orders and review delivery partner applications.</p></div><div className="art-hills" /></section>
    <section className="login-main"><div className="mobile-brand brand"><img className="brand-mark" src="/logo.png" alt="" /><span>DairyDirect<small>STORE OPERATIONS</small></span></div><div className="login-form"><span className="eyebrow">STORE MANAGER</span><h1>{title}</h1><p className="muted">{stage === 'newPassword' ? 'Set a password for your new store account.' : 'Sign in with the account invited by your administrator.'}</p>
      <form onSubmit={(e) => void submit(e)}>
        {stage !== 'newPassword' && <label>Email address<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required /></label>}
        {stage === 'reset' && <label>Verification code<input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></label>}
        {stage !== 'forgot' && <label>{stage === 'login' ? 'Password' : 'New password'}<input type="password" autoComplete={stage === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
        {stage === 'newPassword' && challenge?.required.map((key) => <label key={key}>{statusName(key)}<input value={attributes[key] ?? ''} onChange={(e) => setAttributes((old) => ({ ...old, [key]: e.target.value }))} required /></label>)}
        {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
        <button className="button primary full" disabled={busy}>{busy ? 'Please wait…' : stage === 'login' ? 'Sign in' : stage === 'forgot' ? 'Send verification code' : stage === 'reset' ? 'Reset password' : 'Save password'}</button>
      </form>
      {stage !== 'newPassword' && <button className="text-button" onClick={() => { setStage(stage === 'login' ? 'forgot' : 'login'); setError(''); setNotice(''); }}>{stage === 'login' ? 'Forgot password?' : 'Back to sign in'}</button>}
    </div><p className="login-footer">DairyDirect · Store operations</p></section></main>;
}

function App() {
  const [api, setApi] = useState<StoreApi | null>(null); const [profile, setProfile] = useState<StoreProfile | null>(null);
  async function login(tokens: Tokens) {
    const next = new StoreApi(tokens); const me = await next.request<StoreProfile>('/v1/store/me');
    if (!me.roles.includes('STORE_MANAGER')) throw new Error('This account is not a store manager.');
    setProfile(me); setApi(next);
  }
  async function logout() {
    const previous = api; setApi(null); setProfile(null);
    if (previous) await signOut(previous.getTokens()).catch(() => undefined);
  }
  return !api || !profile ? <Login onLogin={login} /> : <Workspace api={api} profile={profile} onLogout={() => void logout()} />;
}

function Workspace({ api, profile, onLogout }: { api: StoreApi; profile: StoreProfile; onLogout: () => void }) {
  const [storeId, setStoreId] = useState(profile.stores[0]?.storeId ?? ''); const [tab, setTab] = useState<'orders' | 'riders'>('orders');
  const [tasks, setTasks] = useState<PickTask[]>([]); const [riders, setRiders] = useState<Rider[]>([]);
  const [riderFilter, setRiderFilter] = useState('UNDER_REVIEW'); const [selectedRider, setSelectedRider] = useState<Rider | null>(null);
  const [application, setApplication] = useState<Application | null>(null); const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [pickCursor, setPickCursor] = useState<string | null>(null); const [orderCursor, setOrderCursor] = useState<string | null>(null); const [riderCursor, setRiderCursor] = useState<string | null>(null);
  const [moreOrders, setMoreOrders] = useState(false); const [moreRiders, setMoreRiders] = useState(false);
  const keys = useRef(new Map<string, string>()); const busyRef = useRef(false);
  const loadSequence = useRef(0);
  const task = tasks.find((item) => item.id === selectedTask) ?? null;
  const currentStore = profile.stores.find((store) => store.storeId === storeId);
  const load = useCallback(async () => {
    if (!storeId) return; const sequence = ++loadSequence.current; setLoading(true); setMoreOrders(false); setMoreRiders(false); setError('');
    try {
      const [picks, orders, applications] = await Promise.allSettled([
        api.request<Page<PickTask>>(`/v1/store/pick-tasks?storeId=${encodeURIComponent(storeId)}&scope=ALL&limit=100`),
        api.request<Page<StoreOrder>>(`/v1/store/orders?storeId=${encodeURIComponent(storeId)}&limit=100`),
        api.request<Page<Rider>>(`/v1/store/rider-applications?storeId=${encodeURIComponent(storeId)}&status=${encodeURIComponent(riderFilter)}`),
      ]);
      if (sequence !== loadSequence.current) return;
      setTasks(uniqueTasks([...(picks.status === 'fulfilled' ? picks.value.items : []),
        ...completedTasks(orders.status === 'fulfilled' ? orders.value.items : [], storeId)]));
      setRiders(applications.status === 'fulfilled' ? applications.value.items : []);
      setPickCursor(picks.status === 'fulfilled' ? picks.value.nextCursor : null);
      setOrderCursor(orders.status === 'fulfilled' ? orders.value.nextCursor : null);
      setRiderCursor(applications.status === 'fulfilled' ? applications.value.nextCursor : null);
      const failed = [picks.status === 'rejected' ? 'picking tasks' : '', orders.status === 'rejected' ? 'orders awaiting handover' : '', applications.status === 'rejected' ? 'rider applications' : ''].filter(Boolean);
      if (failed.length) setError(`Could not load ${failed.join(', ')}. Check your connection and refresh.`);
    } catch (failure) { if (sequence === loadSequence.current) setError(message(failure)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [api, storeId, riderFilter]);
  useEffect(() => { setSelectedRider(null); setApplication(null); setSelectedTask(null); void load(); }, [load]);
  async function loadMoreRiders() {
    if (!riderCursor || moreRiders) return;
    const sequence = loadSequence.current; setMoreRiders(true); setError('');
    try {
      const page = await api.request<Page<Rider>>(`/v1/store/rider-applications?storeId=${encodeURIComponent(storeId)}&status=${encodeURIComponent(riderFilter)}&before=${encodeURIComponent(riderCursor)}`);
      if (sequence !== loadSequence.current) return;
      setRiders((previous) => [...new Map([...previous, ...page.items].map((item) => [item.userId, item])).values()]);
      setRiderCursor(page.nextCursor);
    } catch (failure) { if (sequence === loadSequence.current) setError(message(failure)); }
    finally { if (sequence === loadSequence.current) setMoreRiders(false); }
  }
  async function loadMoreOrders() {
    if ((!pickCursor && !orderCursor) || moreOrders) return;
    const sequence = loadSequence.current; setMoreOrders(true); setError('');
    try {
      const [picks, orders] = await Promise.all([
        pickCursor ? api.request<Page<PickTask>>(`/v1/store/pick-tasks?storeId=${encodeURIComponent(storeId)}&scope=ALL&limit=100&cursor=${encodeURIComponent(pickCursor)}`) : Promise.resolve(null),
        orderCursor ? api.request<Page<StoreOrder>>(`/v1/store/orders?storeId=${encodeURIComponent(storeId)}&limit=100&cursor=${encodeURIComponent(orderCursor)}`) : Promise.resolve(null),
      ]);
      if (sequence !== loadSequence.current) return;
      setTasks((previous) => uniqueTasks([...previous, ...(picks?.items ?? []), ...completedTasks(orders?.items ?? [], storeId)]));
      setPickCursor(picks?.nextCursor ?? null); setOrderCursor(orders?.nextCursor ?? null);
    } catch (failure) { if (sequence === loadSequence.current) setError(message(failure)); }
    finally { if (sequence === loadSequence.current) setMoreOrders(false); }
  }
  useEffect(() => {
    const mine = tasks.filter((item) => item.assignedTo === profile.userId && ['ASSIGNED', 'IN_PROGRESS'].includes(item.status));
    if (!mine.length) return;
    const timer = window.setInterval(() => { for (const item of mine) void api.request(`/v1/store/pick-tasks/${item.id}/heartbeat`, { method: 'POST' }).catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, [api, tasks, profile.userId]);
  async function action(path: string, body?: unknown, withKey = false) {
    if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(''); setNotice('');
    const fingerprint = `${path}:${JSON.stringify(body ?? null)}`;
    if (withKey && !keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    try {
      await api.request(path, { method: 'POST', ...(body === undefined ? {} : { body }), ...(withKey ? { key: keys.current.get(fingerprint)! } : {}) });
      keys.current.delete(fingerprint); await load(); setNotice('Saved successfully.'); return true;
    } catch (failure) { setError(message(failure)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function openRider(rider: Rider) {
    setSelectedRider(rider); setApplication(null); setError('');
    try { setApplication(await api.request<Application>(`/v1/store/rider-applications/${rider.userId}`)); }
    catch (failure) { setError(message(failure)); }
  }
  async function review(id: string, approved: boolean, reason: string) {
    if (await action(`/v1/store/rider-documents/${id}/review`, { approved, reason })) {
      if (selectedRider) await openRider(selectedRider);
    }
  }
  async function openDocument(id: string) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Allow pop-ups to open the document.'); return; }
    tab.opener = null;
    try {
      const result = await api.request<{ url: string }>(`/v1/store/rider-documents/${id}/read-url`);
      const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
      const target = new URL(result.url, base);
      if (!['http:', 'https:'].includes(target.protocol) || (import.meta.env.PROD && target.protocol !== 'https:')) throw new Error('The document link is invalid.');
      tab.location.replace(target.href);
    } catch (failure) { tab.close(); setError(message(failure)); }
  }
  if (!profile.stores.length) return <div className="empty-page"><div className="brand"><img className="brand-mark" src="/logo.png" alt="" /><span>DairyDirect<small>STORE OPERATIONS</small></span></div><section className="panel empty"><h2>No store assigned yet</h2><p>Ask your administrator to assign this account to a store.</p><button className="button outline" onClick={onLogout}>Sign out</button></section></div>;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><img className="brand-mark" src="/logo.png" alt="" /><span>DairyDirect<small>STORE OPERATIONS</small></span></div><p className="nav-label">WORKSPACE</p><nav><button className={tab === 'orders' ? 'nav active' : 'nav'} onClick={() => setTab('orders')}><span>◫</span> Orders &amp; picking</button><button className={tab === 'riders' ? 'nav active' : 'nav'} onClick={() => setTab('riders')}><span>♧</span> Rider applications</button></nav><div className="sidebar-foot"><span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span><div><strong>{profile.name}</strong><small>Store manager</small></div><button className="text-button" onClick={onLogout}>Sign out</button></div></aside>
    <main className="workspace"><header className="topbar"><div><span className="eyebrow">YOUR STORE</span><h1>{tab === 'orders' ? 'Orders & picking' : 'Rider applications'}</h1><p>{tab === 'orders' ? 'Prepare every order with care.' : 'Help your next delivery partners get started.'}</p></div><div className="top-actions"><label className="store-select"><span>Store</span><select value={storeId} onChange={(e) => setStoreId(e.target.value)}>{profile.stores.map((store) => <option key={store.storeId} value={store.storeId}>{store.name}</option>)}</select></label><button className="button outline" onClick={() => void load()} disabled={loading}>↻ Refresh</button></div></header>
      <div className="mobile-nav"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Orders &amp; picking</button><button className={tab === 'riders' ? 'active' : ''} onClick={() => setTab('riders')}>Rider applications</button><button onClick={onLogout}>Sign out</button></div>
      <section className="welcome"><div><span className="eyebrow light">{currentStore?.name?.toUpperCase() ?? 'YOUR STORE'}</span><h2>Your store at a glance</h2><p>Manage picking and delivery partner reviews for this store.</p></div><span className="welcome-icon">✳</span></section>
      {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      {tab === 'riders' ? <><div className="section-heading"><div><span className="eyebrow">PEOPLE</span><h2>Partner applications</h2></div><label className="inline-select">Status <select value={riderFilter} onChange={(e) => setRiderFilter(e.target.value)}><option value="UNDER_REVIEW">Needs review</option><option value="PENDING">Incomplete</option><option value="APPROVED">Approved</option><option value="REJECTED">Needs changes</option><option value="SUSPENDED">Suspended</option></select></label></div>
        <div className="columns"><section className="panel list-panel">{loading ? <p className="empty">Loading applications…</p> : riders.length ? <>{riders.map((rider) => <button key={rider.userId} className={`list-item ${selectedRider?.userId === rider.userId ? 'selected' : ''}`} onClick={() => void openRider(rider)}><span className="avatar">{rider.name.slice(0, 1).toUpperCase()}</span><span className="grow"><strong>{rider.name}</strong><small>{rider.email}</small></span><span className="badge">{statusName(rider.status)}</span></button>)}{riderCursor && <button className="button outline full" disabled={moreRiders} onClick={() => void loadMoreRiders()}>{moreRiders ? 'Loading…' : 'Show more applications'}</button>}</> : <div className="empty"><div className="empty-icon">✳</div><h3>Nothing in this list</h3><p>Applications for this store will appear here.</p></div>}</section>
          <section className="panel detail">{!selectedRider ? <div className="empty"><h3>Select an application</h3><p>Review vehicle details and submitted documents here.</p></div> : !application ? <p>Loading application…</p> : <RiderDetail rider={selectedRider} application={application} busy={busy} onRead={(id) => void openDocument(id)} onReview={(id, approved, reason) => void review(id, approved, reason)} />}</section></div></>
      : <><div className="section-heading"><div><span className="eyebrow">TODAY'S WORK</span><h2>Picking queue</h2></div><span className="count">{tasks.length} tasks loaded</span></div><div className="columns"><section className="panel list-panel">{loading ? <p className="empty">Loading orders…</p> : tasks.length || pickCursor || orderCursor ? <>{tasks.map((item) => <button key={item.id} className={`list-item ${selectedTask === item.id ? 'selected' : ''}`} onClick={() => setSelectedTask(item.id)}><span className="task-icon">◫</span><span className="grow"><strong>Order {item.orderId.slice(-8).toUpperCase()}</strong><small>{item.itemCount ?? item.items.length} items · {item.status === 'COMPLETED' ? (item.orderStatus === 'PACKED' ? 'Ready for handover' : 'Ready to pack') : `Due ${new Date(item.slaDueAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`}</small></span><span className="badge">{statusName(item.status)}</span></button>)}{(pickCursor || orderCursor) && <button className="button outline full" disabled={moreOrders} onClick={() => void loadMoreOrders()}>{moreOrders ? 'Loading…' : 'Show more orders'}</button>}</> : <div className="empty"><div className="empty-icon">✓</div><h3>All caught up</h3><p>New picking tasks will appear here.</p></div>}</section>
        <section className="panel detail">{task ? <TaskDetail key={task.id} task={task} profile={profile} busy={busy} action={action} /> : <div className="empty"><h3>Select an order</h3><p>Claim a task, pick the items, then pack and hand it to the rider.</p></div>}</section></div></>}
    </main></div>;
}

function RiderDetail({ rider, application, busy, onRead, onReview }: { rider: Rider; application: Application; busy: boolean; onRead: (id: string) => void; onReview: (id: string, approved: boolean, reason: string) => void }) {
  const [rejection, setRejection] = useState<string | null>(null); const [reason, setReason] = useState('');
  return <><div className="detail-heading"><div><span className="eyebrow">RIDER APPLICATION</span><h2>{rider.name}</h2><p className="muted">{rider.email}</p></div><span className="badge">{statusName(application.status)}</span></div><div className="info-grid"><div><small>Vehicle</small><strong>{application.vehicleType || 'Not provided'}</strong></div><div><small>Registration</small><strong>{application.vehicleNo || 'Not provided'}</strong></div></div><h3>Required documents</h3><p className="muted small">Review each document before approving the partner.</p>
    {application.requiredDocuments.map((type) => { const doc = application.documents.find((item) => item.type === type); return <div className="document" key={type}><div className="document-row"><span className="task-icon">▤</span><div className="grow"><strong>{documentNames[type] ?? statusName(type)}</strong><small>{doc ? statusName(doc.status) : 'Not uploaded'}</small></div>{doc && <button className="button outline small-button" onClick={() => onRead(doc.id)}>View</button>}</div>{doc?.reason && <p className="muted small">Reason: {doc.reason}</p>}
      {doc?.status === 'PENDING' && application.status === 'UNDER_REVIEW' && <div className="actions"><button className="button primary small-button" disabled={busy} onClick={() => onReview(doc.id, true, '')}>Approve</button><button className="button outline small-button" disabled={busy} onClick={() => { setRejection(doc.id); setReason(''); }}>Request replacement</button></div>}
      {doc && rejection === doc.id && <div className="reject-box"><label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain what needs to be corrected" /></label><div className="actions"><button className="button danger small-button" disabled={busy || !reason.trim()} onClick={() => { onReview(doc.id, false, reason.trim()); setRejection(null); }}>Send request</button><button className="text-button" onClick={() => setRejection(null)}>Cancel</button></div></div>}
    </div>; })}</>;
}

function TaskDetail({ task, profile, busy, action }: { task: PickTask; profile: StoreProfile; busy: boolean; action: (path: string, body?: unknown, withKey?: boolean) => Promise<boolean> }) {
  const [bags, setBags] = useState('1'); const [seal, setSeal] = useState(''); const [coldChain, setColdChain] = useState(false); const [code, setCode] = useState('');
  const mine = task.assignedTo === profile.userId; const prefix = `/v1/store/pick-tasks/${task.id}`;
  return <><div className="detail-heading"><div><span className="eyebrow">PICKING TASK</span><h2>Order {task.orderId.slice(-8).toUpperCase()}</h2><p className="muted">{task.status === 'COMPLETED' ? 'Picking complete' : `Due ${new Date(task.slaDueAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`}</p></div><span className="badge">{statusName(task.status)}</span></div>
    {task.status === 'PENDING' && <button className="button primary" disabled={busy} onClick={() => void action(`${prefix}/claim`, undefined, true)}>Claim task</button>}
    {task.status === 'ASSIGNED' && mine && <button className="button primary" disabled={busy} onClick={() => void action(`${prefix}/start`, undefined, true)}>Start picking</button>}
    {task.assignedTo && !mine && <p className="muted">This task is assigned to another manager.</p>}
    {!!task.items.length && <h3>Items</h3>}{task.items.map((item) => <PickLine key={item.id} item={item} active={task.status === 'IN_PROGRESS' && mine} busy={busy} prefix={prefix} action={action} />)}
    {task.status === 'IN_PROGRESS' && mine && <button className="button primary full" disabled={busy} onClick={() => void action(`${prefix}/complete`, undefined, true)}>Complete picking</button>}
    {task.status === 'COMPLETED' && task.orderStatus !== 'PACKED' && <><h3>Pack order</h3><div className="form-grid"><label>Bags<input value={bags} onChange={(e) => setBags(e.target.value)} inputMode="numeric" /></label><label>Seal code<input value={seal} onChange={(e) => setSeal(e.target.value)} /></label></div><label className="check"><input type="checkbox" checked={coldChain} onChange={(e) => setColdChain(e.target.checked)} /> Cold chain packed</label><button className="button outline" disabled={busy || !seal.trim() || !/^[1-9]\d{0,2}$/.test(bags)} onClick={() => void action(`/v1/store/orders/${task.orderId}/pack`, { bags, sealCode: seal.trim(), coldChain }, true)}>Mark as packed</button></>}
    {task.status === 'COMPLETED' && task.orderStatus === 'PACKED' && <><h3>Hand over to rider</h3><label>Rider's handover code<input value={code} onChange={(e) => setCode(e.target.value)} /></label><button className="button primary" disabled={busy || !code.trim()} onClick={() => void action(`/v1/store/orders/${task.orderId}/handover`, { handoverCode: code.trim() })}>Verify handover</button></>}
  </>;
}

function PickLine({ item, active, busy, prefix, action }: { item: PickItem; active: boolean; busy: boolean; prefix: string; action: (path: string, body?: unknown, withKey?: boolean) => Promise<boolean> }) {
  const [barcode, setBarcode] = useState(''); const [quantity, setQuantity] = useState(item.expectedQty); const [batch, setBatch] = useState(item.fefoSuggestions?.[0]?.batchId ?? ''); const [short, setShort] = useState('OUT_OF_STOCK');
  const [substitution, setSubstitution] = useState(false); const [candidate, setCandidate] = useState(''); const [replacementBarcode, setReplacementBarcode] = useState(''); const [replacementBatch, setReplacementBatch] = useState('');
  return <div className="document"><div className="document-row"><div className="grow"><strong>{item.name}</strong><small>{item.pickedQty} of {item.expectedQty} picked · {statusName(item.status)}</small></div><span className="badge">{statusName(item.status)}</span></div>
    {active && item.status === 'PENDING' && <><div className="form-grid"><label>Scan barcode<input value={barcode} onChange={(e) => setBarcode(e.target.value)} /></label><label>Quantity<input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label></div><label>Batch<select value={batch} onChange={(e) => setBatch(e.target.value)}><option value="">Choose a batch</option>{(item.fefoSuggestions ?? []).map((option) => <option key={option.batchId} value={option.batchId}>{option.batchCode} · {option.availableQty} available</option>)}</select></label><div className="actions"><button className="button primary small-button" disabled={busy || !barcode.trim() || !/^[1-9]\d*$/.test(quantity) || !batch} onClick={() => void action(`${prefix}/items/${item.id}/pick`, { scannedBarcode: barcode.trim(), quantity, batchId: batch }, true)}>Pick item</button><select aria-label="Reason item is unavailable" value={short} onChange={(e) => setShort(e.target.value)}><option value="OUT_OF_STOCK">Out of stock</option><option value="DAMAGED">Damaged</option><option value="EXPIRED">Expired</option><option value="NOT_FOUND">Not found</option></select><button className="button outline small-button" disabled={busy} onClick={() => void action(`${prefix}/items/${item.id}/short`, { reason: short }, true)}>Mark unavailable</button><button className="text-button" onClick={() => setSubstitution((value) => !value)}>Substitute item</button></div>
      {substitution && <div className="reject-box"><p className="muted small">Substitutions are available when enabled for this order.</p><label>Replacement variant ID<input value={candidate} onChange={(e) => setCandidate(e.target.value)} /></label><label>Replacement barcode<input value={replacementBarcode} onChange={(e) => setReplacementBarcode(e.target.value)} /></label><label>Replacement batch ID (if required)<input value={replacementBatch} onChange={(e) => setReplacementBatch(e.target.value)} /></label><button className="button outline small-button" disabled={busy || !candidate.trim() || !replacementBarcode.trim()} onClick={() => void action(`${prefix}/items/${item.id}/substitute`, { candidateVariantId: candidate.trim(), scannedBarcode: replacementBarcode.trim(), ...(replacementBatch.trim() ? { batchId: replacementBatch.trim() } : {}) }, true)}>Use substitute</button></div>}</>}
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
