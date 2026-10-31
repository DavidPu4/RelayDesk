import { useCallback, useDeferredValue, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck,
  CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, Code2,
  Copy, Inbox, Layers3, LoaderCircle, MailWarning, Play, Plus, Radio,
  RotateCcw, Search, Send, ShieldCheck, Terminal, Waypoints, X,
} from 'lucide-react';
import { api, errorMessage } from './api';
import type { Attempt, Behavior, Delivery, DeliveryDetail, Endpoint, Health, Overview, Page, Status } from './types';

const STATUS_LABELS: Record<Status, string> = {
  queued: 'Queued', processing: 'Processing', retrying: 'Retrying', delivered: 'Delivered', dead_letter: 'Dead letter',
};
const BEHAVIORS: Record<Behavior, { label: string; description: string }> = {
  healthy: { label: 'Healthy', description: 'Accepts signed deliveries immediately.' },
  flaky: { label: 'Intermittent', description: 'Fails twice, then accepts the event.' },
  failing: { label: 'Failing', description: 'Returns an error on every attempt.' },
};
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const numberFormat = new Intl.NumberFormat();
const shortId = (value: string) => value.length > 17 ? `${value.slice(0, 9)}…${value.slice(-5)}` : value;
const relativeTime = (timestamp: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 5 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : dateFormat.format(timestamp);
};

function Logo() {
  return <span className="brand-symbol" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 7h13a7 7 0 0 1 0 14h-4v-5h4a2 2 0 0 0 0-4H5z" /><path d="M5 15h5v10H5zm10 7h6l6 7h-7z" /></svg></span>;
}

function StatusBadge({ status }: { status: Status }) {
  const Icon = status === 'delivered' ? CheckCircle2 : status === 'retrying' ? RotateCcw : status === 'dead_letter' ? CircleAlert : status === 'processing' ? LoaderCircle : Clock3;
  return <span className={`status-badge status-${status}`}><Icon size={12} className={status === 'processing' ? 'spin' : ''} />{STATUS_LABELS[status]}</span>;
}

function Modal({ children, titleId, onClose, className = '' }: { children: ReactNode; titleId: string; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}

function useWorkspace(status: string, query: string, revision: number) {
  const [data, setData] = useState<{ overview: Overview; endpoints: Endpoint[]; deliveries: Delivery[]; health: Health } | null>(null);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      try {
        const search = new URLSearchParams({ status, q: query, limit: '100' });
        const options = { signal: controller.signal };
        const [overview, endpoints, deliveries, health] = await Promise.all([
          api<Overview>('/api/overview', options),
          api<{ items: Endpoint[] }>('/api/endpoints', options),
          api<{ items: Delivery[] }>(`/api/deliveries?${search}`, options),
          api<Health>('/api/health', options),
        ]);
        if (!stopped) { setData({ overview, endpoints: endpoints.items, deliveries: deliveries.items, health }); setError(''); setUpdatedAt(Date.now()); }
      } catch (failure) { if (!stopped) setError(errorMessage(failure)); }
      finally { if (!stopped) timer = setTimeout(poll, 1500); }
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [status, query, revision]);
  return { data, error, updatedAt };
}

function useDelivery(id: string | null, revision: number) {
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDetail(null); setError('');
    if (!id) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<DeliveryDetail>(`/api/deliveries/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!stopped) { setDetail(result); setError(''); }
      } catch (failure) { if (!stopped) setError(errorMessage(failure)); }
      finally { if (!stopped) timer = setTimeout(poll, 1500); }
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [id, revision]);
  return { detail, error };
}

function Metrics({ overview }: { overview: Overview }) {
  const metrics = [
    { name: 'Total deliveries', value: numberFormat.format(overview.totalDeliveries), note: `${numberFormat.format(overview.totalEvents)} unique events`, Icon: Send, tone: 'neutral' },
    { name: 'Delivery rate', value: overview.successRate == null ? '—' : `${overview.successRate.toFixed(1)}%`, note: 'Of completed deliveries', Icon: CheckCheck, tone: 'green' },
    { name: 'Recovered', value: numberFormat.format(overview.recovered), note: 'Delivered after a retry', Icon: RotateCcw, tone: 'amber' },
    { name: 'Dead letters', value: numberFormat.format(overview.deadLetter), note: 'Ready for your attention', Icon: Inbox, tone: 'red' },
  ];
  return <div className="metrics-grid">{metrics.map(({ name, value, note, Icon, tone }) => <section key={name} className={`metric metric-${tone}`}>
    <div className="metric-heading"><span>{name}</span><Icon size={16} /></div>
    <div className="metric-value">{value}</div><div className="metric-note">{note}</div>
  </section>)}</div>;
}

function ActivityChart({ activity }: { activity: Overview['activity'] }) {
  const peak = Math.max(1, ...activity.map(bucket => bucket.delivered + bucket.failed));
  const ceiling = Math.max(4, Math.ceil(peak / 4) * 4);
  const chartHeight = 108;
  const total = activity.reduce((sum, bucket) => sum + bucket.delivered + bucket.failed, 0);
  return <section className="panel activity-panel">
    <div className="panel-title-row"><div><h2>Delivery activity</h2><p>Actual attempts over the last 12 hours</p></div><span className="period-label"><Clock3 size={13} /> Last 12 hours</span></div>
    <div className="chart-wrap">
      <svg viewBox="0 0 650 158" role="img" aria-label={`Delivery attempts: ${activity.reduce((s, a) => s + a.delivered, 0)} successful and ${activity.reduce((s, a) => s + a.failed, 0)} failed in the last 12 hours`}>
        {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line x1="29" y1={14 + tick * 27} x2="644" y2={14 + tick * 27} stroke="#edf0f3" /><text x="19" y={18 + tick * 27} textAnchor="end" className="chart-label">{ceiling - tick * ceiling / 4}</text></g>)}
        {activity.map((bucket, index) => {
          const x = 42 + index * 50;
          const deliveredHeight = bucket.delivered / ceiling * chartHeight;
          const failedHeight = bucket.failed / ceiling * chartHeight;
          return <g key={bucket.hour}><title>{`${dateFormat.format(bucket.hour)}: ${bucket.delivered} delivered, ${bucket.failed} failed`}</title>
            <rect x={x} y={122 - deliveredHeight} width="23" height={deliveredHeight} rx="3" fill="#21a882" />
            <rect x={x} y={122 - deliveredHeight - failedHeight} width="23" height={failedHeight} rx="3" fill="#f4a194" />
            {(index % 2 === 0 || index === activity.length - 1) ? <text x={x + 11} y="148" textAnchor="middle" className="chart-label">{hourFormat.format(bucket.hour)}</text> : null}
          </g>;
        })}
        {!total ? <text x="336" y="65" textAnchor="middle" className="chart-empty">Your delivery activity will appear here.</text> : null}
      </svg>
    </div>
    <div className="chart-legend"><span><i className="legend-dot delivered-dot" />Delivered</span><span><i className="legend-dot failed-dot" />Failed attempt</span><span className="chart-total">{numberFormat.format(total)} attempts</span></div>
  </section>;
}

function QueueHealth({ overview }: { overview: Overview }) {
  return <section className="panel queue-panel"><div className="panel-title-row"><div><h2>Queue health</h2><p>Background delivery worker</p></div><Radio size={16} className="muted-icon" /></div>
    <div className="queue-rows"><div><span><i className="queue-dot blue" />In progress</span><strong>{overview.processing}</strong></div><div><span><i className="queue-dot amber" />Waiting to retry</span><strong>{overview.retrying}</strong></div><div><span><i className="queue-dot gray" />Queued</span><strong>{overview.queued}</strong></div></div>
    <div className="duplicate-stat"><ShieldCheck size={18} /><div><strong>{overview.duplicatesPrevented} duplicate{overview.duplicatesPrevented === 1 ? '' : 's'} prevented</strong><span>Same request. No extra delivery.</span></div></div>
  </section>;
}

function DeliveryTable({ deliveries, query, status, setQuery, setStatus, onSelect, onDemo, isDeadLetters, clearFilters }: {
  deliveries: Delivery[]; query: string; status: string; setQuery: (query: string) => void; setStatus: (status: string) => void;
  onSelect: (id: string) => void; onDemo: () => void; isDeadLetters: boolean; clearFilters: () => void;
}) {
  return <section className="panel delivery-panel"><div className="delivery-toolbar"><div className="table-title"><h2>{isDeadLetters ? 'Dead-letter queue' : 'Recent deliveries'}</h2><span className="count-label">{deliveries.length}</span></div><div className="table-controls"><label className="search-input"><Search size={15} /><input aria-label="Search deliveries" placeholder="Search events or endpoints…" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button> : null}</label>{!isDeadLetters ? <label className="select-control"><select aria-label="Filter by delivery status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label> : null}</div></div>
    <div className="table-scroll"><table><thead><tr><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Created</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{deliveries.map(delivery => <tr key={delivery.id} onClick={() => onSelect(delivery.id)}>
      <td><button className="open-delivery" onClick={event => { event.stopPropagation(); onSelect(delivery.id); }} aria-label={`View ${delivery.eventType} delivery`}><span className="event-icon"><Code2 size={15} /></span><span><strong>{delivery.eventType}</strong><small>{shortId(delivery.eventId)}</small></span></button></td>
      <td><span className="endpoint-cell">{delivery.endpointName}</span><small className="table-subtext">Local receiver</small></td><td><StatusBadge status={delivery.status} /></td><td><span className="attempt-count">{delivery.attemptCount}<span> / {delivery.maxAttempts}</span></span></td><td className="time-cell" title={dateFormat.format(delivery.createdAt)}>{relativeTime(delivery.createdAt)}</td><td><ArrowUpRight size={15} className="row-arrow" /></td>
    </tr>)}</tbody></table></div>
    {!deliveries.length ? <div className="empty-state"><span className="empty-icon">{isDeadLetters ? <CheckCircle2 size={24} /> : <Inbox size={24} />}</span><h3>{query || (status !== 'all' && !isDeadLetters) ? 'No matching deliveries' : isDeadLetters ? 'Nothing needs recovery' : 'Your first delivery starts here'}</h3><p>{query || (status !== 'all' && !isDeadLetters) ? 'Try another search or clear your filters.' : isDeadLetters ? 'Deliveries that exhaust their retry budget will appear here.' : 'Send an event or run the failure demo to watch real deliveries move through the queue.'}</p>{query || (status !== 'all' && !isDeadLetters) ? <button className="button button-secondary" onClick={clearFilters}>Clear filters</button> : !isDeadLetters ? <button className="button button-secondary" onClick={onDemo}><Play size={14} />Try the failure demo</button> : null}</div> : <div className="table-footer"><span>Showing {deliveries.length} most recent {deliveries.length === 1 ? 'delivery' : 'deliveries'}</span><span><i className="live-dot" />Updates automatically</span></div>}
  </section>;
}

function EndpointsView({ endpoints, pending, onUpdate, onCreate }: { endpoints: Endpoint[]; pending: string | null; onUpdate: (id: string, patch: Partial<Pick<Endpoint, 'behavior' | 'enabled'>>) => void; onCreate: () => void }) {
  return <><div className="section-intro"><div><h2>Your endpoints</h2><p>Included local receivers let you reproduce success, recovery, and failure.</p></div><button className="button button-secondary" onClick={onCreate}><Plus size={15} />Add endpoint</button></div><div className="endpoints-grid">{endpoints.map(endpoint => <section className="panel endpoint-card" key={endpoint.id}><div className="endpoint-card-top"><span className={`endpoint-avatar behavior-${endpoint.behavior}`}><Waypoints size={22} /></span><button className={`toggle ${endpoint.enabled ? 'toggle-on' : ''}`} role="switch" aria-checked={endpoint.enabled} aria-label={`${endpoint.enabled ? 'Pause' : 'Enable'} ${endpoint.name}`} disabled={pending === endpoint.id} onClick={() => onUpdate(endpoint.id, { enabled: !endpoint.enabled })}><span /></button></div><h3>{endpoint.name}</h3><p className="endpoint-id">{shortId(endpoint.id)}</p><span className={`behavior-pill behavior-${endpoint.behavior}`}><i />{endpoint.enabled ? BEHAVIORS[endpoint.behavior].label : 'Paused'}</span><div className="endpoint-setting"><label htmlFor={`behavior-${endpoint.id}`}>Receiver behavior</label><select id={`behavior-${endpoint.id}`} value={endpoint.behavior} disabled={pending === endpoint.id} onChange={event => onUpdate(endpoint.id, { behavior: event.target.value as Behavior })}><option value="healthy">Healthy · accepts immediately</option><option value="flaky">Intermittent · fails twice</option><option value="failing">Failing · always returns an error</option></select></div><p className="endpoint-description">{BEHAVIORS[endpoint.behavior].description}</p><div className="endpoint-card-footer"><ShieldCheck size={13} /><span>Signed requests verified</span><span>{pending === endpoint.id ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}</span></div></section>)}</div><div className="info-note"><CircleAlert size={16} /><p>To recover a dead letter, change its endpoint to <strong>Healthy</strong>, then retry the delivery. Pausing an endpoint prevents new events; already queued deliveries continue.</p></div></>;
}

function Guide({ onDemo, onEndpoints, onDeadLetters }: { onDemo: () => void; onEndpoints: () => void; onDeadLetters: () => void }) {
  return <div className="guide-layout"><section className="panel guide-main"><div className="guide-heading"><span className="eyebrow">THE 2-MINUTE WALKTHROUGH</span><h2>See reliability in action.</h2><p>Break a receiver, watch the retries, then recover the delivery with its full history intact.</p></div><ol className="walkthrough"><li><span className="step-number">01</span><div><h3>Send three example events</h3><p>The failure demo targets a healthy receiver, an intermittent receiver, and a failing receiver. The payloads are synthetic; the HTTP requests and records are real.</p><button className="text-action" onClick={onDemo}>Run the failure demo<ArrowRight size={15} /></button></div></li><li><span className="step-number">02</span><div><h3>Inspect every attempt</h3><p>Open a delivery to see the payload, timestamps, HTTP responses, and retry history. The intermittent receiver accepts its event on the third request.</p></div></li><li><span className="step-number">03</span><div><h3>Repair the failing endpoint</h3><p>After four failed attempts, that delivery moves to the dead-letter queue. Switch its receiver behavior to Healthy in Endpoints.</p><button className="text-action" onClick={onEndpoints}>Manage endpoints<ArrowRight size={15} /></button></div></li><li><span className="step-number">04</span><div><h3>Recover without losing the history</h3><p>Open the dead letter and select Retry delivery. Its next attempt succeeds, and the original failure history stays attached.</p><button className="text-action" onClick={onDeadLetters}>Open dead-letter queue<ArrowRight size={15} /></button></div></li></ol></section><aside className="guide-aside"><section className="panel"><ShieldCheck size={23} /><h3>A deliberate second send</h3><p>The demo submits one event twice with the same idempotency key. RelayDesk recognizes the duplicate and keeps one event and one delivery.</p></section><section className="panel"><Terminal size={23} /><h3>Everything stays local</h3><p>This workbench uses included receivers and a database on this computer. No cloud account, API key, or paid service is needed.</p></section><section className="guide-limits"><h3>What this demonstrates</h3><p>Delivery is at least once. Signed requests, persisted retry history, lease recovery, and receiver idempotency make the behavior inspectable. This is a local development tool, not a hosted multi-user service.</p></section></aside></div>;
}

function AttemptItem({ attempt }: { attempt: Attempt }) {
  const success = attempt.outcome === 'delivered';
  const pending = attempt.outcome === 'in_progress';
  return <li className={`attempt-item ${success ? 'attempt-success' : pending ? 'attempt-pending' : 'attempt-failed'}`}><span className="attempt-node">{success ? <Check size={12} /> : pending ? <LoaderCircle size={12} className="spin" /> : <X size={11} />}</span><div className="attempt-content"><div className="attempt-title"><strong>Attempt {attempt.number}</strong><span>{attempt.statusCode != null ? `HTTP ${attempt.statusCode}` : pending ? 'In progress' : attempt.outcome === 'lease_expired' ? 'Lease expired' : 'Connection error'}</span></div><div className="attempt-meta"><time dateTime={new Date(attempt.startedAt).toISOString()}>{clockFormat.format(attempt.startedAt)}</time><span>·</span><span>{attempt.durationMs == null ? 'Waiting for response' : `${Math.round(attempt.durationMs)} ms`}</span></div>{attempt.error ? <p className="attempt-error">{attempt.error}</p> : null}{attempt.responseBody ? <details><summary>Response body</summary><pre>{attempt.responseBody}</pre></details> : null}</div></li>;
}

function DeliveryDrawer({ id, revision, onClose, onRetry, busy, notify }: { id: string; revision: number; onClose: () => void; onRetry: (id: string) => void; busy: boolean; notify: (message: string) => void }) {
  const { detail, error } = useDelivery(id, revision);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); notify('Copied to clipboard.'); }
    catch { notify('Clipboard access is unavailable. You can select and copy the text.'); }
  };
  return <Modal titleId="delivery-title" onClose={onClose} className="drawer"><div className="drawer-header"><div><span className="eyebrow">DELIVERY DETAILS</span><h2 id="delivery-title">{detail?.eventType ?? 'Loading delivery…'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close delivery details"><X size={20} /></button></div>{error ? <div className="dialog-error" role="alert">{error}</div> : null}{!detail ? <div className="drawer-loading"><LoaderCircle size={22} className="spin" />Loading attempt history…</div> : <div className="drawer-body"><div className="detail-status-row"><StatusBadge status={detail.status} /><span>{dateFormat.format(detail.createdAt)}</span></div><dl className="detail-fields"><div><dt>Delivery ID</dt><dd><code>{shortId(detail.id)}</code><button className="icon-button" aria-label="Copy delivery ID" onClick={() => void copy(detail.id)}><Copy size={13} /></button></dd></div><div><dt>Event ID</dt><dd><code>{shortId(detail.eventId)}</code><button className="icon-button" aria-label="Copy event ID" onClick={() => void copy(detail.eventId)}><Copy size={13} /></button></dd></div><div><dt>Endpoint</dt><dd>{detail.endpointName}</dd></div><div><dt>Attempts</dt><dd>{detail.attemptCount} of {detail.maxAttempts}</dd></div></dl>{detail.status === 'retrying' && detail.nextAttemptAt ? <div className="detail-callout callout-amber"><Clock3 size={16} /><span>Next attempt {detail.nextAttemptAt > Date.now() ? `in ${Math.max(1, Math.ceil((detail.nextAttemptAt - Date.now()) / 1000))} seconds` : 'is ready to run'}.</span></div> : null}{detail.status === 'dead_letter' ? <div className="detail-callout callout-red"><MailWarning size={17} /><div><strong>This delivery needs attention</strong><p>Fix the endpoint, then retry. Existing attempts will remain in the history.</p><button className="button button-danger" disabled={busy} onClick={() => onRetry(detail.id)}>{busy ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}Retry delivery</button></div></div> : null}{detail.receipt ? <div className="detail-callout callout-green"><ShieldCheck size={17} /><div><strong>Accepted by the receiver</strong><p>One acceptance recorded{detail.receipt.duplicateCount ? `; ${detail.receipt.duplicateCount} duplicate request${detail.receipt.duplicateCount === 1 ? '' : 's'} recognized` : ''}.</p></div></div> : null}<div className="detail-section-heading"><h3>Event payload</h3><button className="text-action" onClick={() => void copy(JSON.stringify(detail.payload, null, 2))}><Copy size={13} />Copy JSON</button></div><pre className="payload-code">{JSON.stringify(detail.payload, null, 2)}</pre><div className="detail-section-heading"><h3>Attempt timeline</h3><span>{detail.attempts.length} {detail.attempts.length === 1 ? 'attempt' : 'attempts'}</span></div>{detail.attempts.length ? <ol className="attempt-timeline">{detail.attempts.map(attempt => <AttemptItem attempt={attempt} key={attempt.id} />)}</ol> : <p className="muted">The worker hasn’t attempted this delivery yet.</p>}</div>}</Modal>;
}

function NewEventDialog({ endpoints, onClose, onSent }: { endpoints: Endpoint[]; onClose: () => void; onSent: (message: string) => void }) {
  const [type, setType] = useState('order.created');
  const [endpointId, setEndpointId] = useState(() => endpoints.find(endpoint => endpoint.enabled)?.id ?? '');
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  const [payload, setPayload] = useState(`{
  "orderId": "order_demo_1042",
  "customer": "Demo customer",
  "items": 2,
  "source": "RelayDesk example"
}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    let value: unknown;
    try { value = JSON.parse(payload); } catch { setError('The payload must be valid JSON. Check quotation marks and commas.'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { setError('The payload must be a JSON object.'); return; }
    if (!endpointId) { setError('Choose an enabled endpoint first.'); return; }
    setBusy(true);
    try {
      const result = await api<{ eventId: string; replayed: boolean }>('/api/events', { method: 'POST', body: JSON.stringify({ type, payload: value, endpointIds: [endpointId], idempotencyKey: key }) });
      onSent(result.replayed ? 'Duplicate recognized. The original event was kept.' : 'Event queued. The worker will deliver it shortly.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <Modal titleId="new-event-title" onClose={onClose}><div className="modal-header"><span className="modal-icon"><Send size={21} /></span><button className="icon-button" onClick={onClose} aria-label="Close new event"><X size={19} /></button></div><h2 id="new-event-title">Send a new event</h2><p className="modal-description">Queue a signed delivery to one of your local receivers.</p><form onSubmit={event => void submit(event)}><div className="form-field"><label htmlFor="event-type">Event type</label><input id="event-type" value={type} onChange={event => setType(event.target.value)} maxLength={80} required autoFocus placeholder="order.created" /></div><div className="form-field"><label htmlFor="event-endpoint">Destination endpoint</label><select id="event-endpoint" value={endpointId} onChange={event => setEndpointId(event.target.value)} required><option value="" disabled>Select an endpoint</option>{endpoints.filter(endpoint => endpoint.enabled).map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.name} · {BEHAVIORS[endpoint.behavior].label}</option>)}</select></div><div className="form-field"><label htmlFor="event-payload">JSON payload<span>Example data</span></label><textarea id="event-payload" className="json-editor" value={payload} onChange={event => setPayload(event.target.value)} spellCheck={false} rows={7} required /></div><div className="form-field"><label htmlFor="event-key">Idempotency key</label><input id="event-key" className="mono-input" value={key} onChange={event => setKey(event.target.value)} maxLength={128} required /><small>Reusing this key with the same content prevents an extra delivery.</small></div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || !endpoints.some(endpoint => endpoint.enabled)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}Send event</button></div></form></Modal>;
}

function NewEndpointDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [behavior, setBehavior] = useState<Behavior>('healthy');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try { await api<Endpoint>('/api/endpoints', { method: 'POST', body: JSON.stringify({ name, behavior }) }); onCreated(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <Modal titleId="new-endpoint-title" onClose={onClose}><div className="modal-header"><span className="modal-icon"><Waypoints size={22} /></span><button className="icon-button" onClick={onClose} aria-label="Close new endpoint"><X size={19} /></button></div><h2 id="new-endpoint-title">Add a local endpoint</h2><p className="modal-description">Create a receiver with a controlled response to test delivery behavior.</p><form onSubmit={event => void submit(event)}><div className="form-field"><label htmlFor="endpoint-name">Endpoint name</label><input id="endpoint-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus placeholder="e.g. Inventory service" /></div><div className="form-field"><label htmlFor="endpoint-behavior">Receiver behavior</label><select id="endpoint-behavior" value={behavior} onChange={event => setBehavior(event.target.value as Behavior)}>{Object.entries(BEHAVIORS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}</select><small>{BEHAVIORS[behavior].description}</small></div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="modal-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Add endpoint</button></div></form></Modal>;
}

function DemoDialog({ onClose, onRun, busy }: { onClose: () => void; onRun: () => void; busy: boolean }) {
  return <Modal titleId="demo-title" onClose={onClose} className="demo-dialog"><div className="modal-header"><span className="modal-icon"><Play size={22} /></span><button className="icon-button" onClick={onClose} aria-label="Close failure demo"><X size={19} /></button></div><span className="eyebrow">A SMALL, CONTROLLED FAILURE</span><h2 id="demo-title">Three events. Three outcomes.</h2><p className="modal-description">Send synthetic order events through real HTTP deliveries and watch what happens next.</p><div className="demo-scenarios"><div><span className="scenario-icon green"><CheckCircle2 size={18} /></span><div><strong>A healthy receiver</strong><p>Accepts its delivery on the first attempt.</p></div><span className="scenario-count">01</span></div><div><span className="scenario-icon amber"><RotateCcw size={18} /></span><div><strong>An intermittent receiver</strong><p>Fails twice, then recovers automatically.</p></div><span className="scenario-count">02</span></div><div><span className="scenario-icon red"><MailWarning size={18} /></span><div><strong>A failing receiver</strong><p>Exhausts its attempts and becomes a dead letter.</p></div><span className="scenario-count">03</span></div></div><div className="demo-disclosure"><ShieldCheck size={17} /><p>One request is also sent twice to demonstrate duplicate prevention. Nothing is sent outside this computer.</p></div><div className="modal-actions"><button className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" onClick={onRun} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Run demo</button></div></Modal>;
}

export default function App() {
  const [page, setPage] = useState<Page>('deliveries');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<'event' | 'demo' | 'endpoint' | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [endpointPending, setEndpointPending] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const { data, error, updatedAt } = useWorkspace(page === 'deadletters' ? 'dead_letter' : status, deferredQuery, revision);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const notify = useCallback((message: string) => setToast(message), []);
  const closeModal = useCallback(() => setModal(null), []);
  const closeDrawer = useCallback(() => setSelectedId(null), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);
  const navigate = (nextPage: Page) => { setPage(nextPage); setQuery(''); setStatus('all'); };
  const runDemo = async () => {
    setDemoBusy(true);
    try { await api('/api/demo/run', { method: 'POST' }); setModal(null); navigate('deliveries'); refresh(); notify('Three demo events queued. Watch their delivery attempts below.'); }
    catch (failure) { notify(errorMessage(failure)); }
    finally { setDemoBusy(false); }
  };
  const retry = async (id: string) => {
    setRetryBusy(true);
    try { await api(`/api/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' }); refresh(); notify('Delivery queued for another attempt. Its history is preserved.'); }
    catch (failure) { notify(errorMessage(failure)); }
    finally { setRetryBusy(false); }
  };
  const updateEndpoint = async (id: string, patch: Partial<Pick<Endpoint, 'behavior' | 'enabled'>>) => {
    setEndpointPending(id);
    try { await api(`/api/endpoints/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); refresh(); notify('Endpoint updated.'); }
    catch (failure) { notify(errorMessage(failure)); }
    finally { setEndpointPending(null); }
  };
  const navItems: { id: Page; label: string; Icon: typeof Send }[] = [
    { id: 'deliveries', label: 'Deliveries', Icon: Layers3 }, { id: 'deadletters', label: 'Dead letters', Icon: Inbox },
    { id: 'endpoints', label: 'Endpoints', Icon: Waypoints }, { id: 'guide', label: 'Quick guide', Icon: BookOpen },
  ];
  const titles = { deliveries: 'Delivery overview', deadletters: 'Recover failed deliveries', endpoints: 'Endpoints', guide: 'A little failure. A lot to learn.' };
  const descriptions = { deliveries: 'Inspect every attempt. Keep your events moving.', deadletters: 'Fix the destination, then give these events another try.', endpoints: 'Control how your local receivers respond to deliveries.', guide: 'A hands-on tour of retries, recovery, and duplicate prevention.' };
  const effectiveStatus = page === 'deadletters' ? 'dead_letter' : status;
  const searchText = query.trim().toLowerCase();
  const visibleDeliveries = data?.deliveries.filter(delivery =>
    (effectiveStatus === 'all' || delivery.status === effectiveStatus) &&
    (!searchText || [delivery.eventId, delivery.eventType, delivery.endpointName].some(value => value.toLowerCase().includes(searchText)))
  ) ?? [];
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('deliveries'); }} aria-label="RelayDesk home"><Logo /><span>relaydesk<span className="brand-period">.</span></span></a><div className="workspace-switch"><span className="workspace-avatar">L</span><div><strong>Local workspace</strong><span>Development</span></div><ChevronDown size={14} /></div><span className="nav-heading">WORKSPACE</span><nav aria-label="Main navigation">{navItems.map(({ id, label, Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'deadletters' && data?.overview.deadLetter ? <span className="nav-count">{data.overview.deadLetter}</span> : null}{page === id ? <span className="active-indicator" /> : null}</button>)}</nav><div className="sidebar-demo"><span className="sidebar-demo-icon"><Activity size={21} /></span><h3>Make failure useful.</h3><p>Explore a complete delivery and recovery workflow.</p><button onClick={() => setModal('demo')}>Run failure demo<ArrowUpRight size={14} /></button></div><div className="sidebar-footer"><span className="terminal-icon"><Terminal size={17} /></span><div><strong>Runs on your machine</strong><span>No cloud account needed</span></div><span className="sidebar-online-dot" /></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{navItems.find(item => item.id === page)?.label}</strong></div><div className="topbar-right"><span className={`worker-status ${data?.health.workerRunning ? '' : 'worker-offline'}`}><i />{data?.health.workerRunning ? 'Worker online' : data ? 'Worker stopped' : 'Connecting'}</span><span className="environment-tag">LOCAL</span></div></header><main className="main-content"><div className="page-heading"><div><span className="eyebrow">WEBHOOK DELIVERY WORKBENCH</span><h1>{titles[page]}</h1><p>{descriptions[page]}</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => setModal('demo')}><Play size={15} />Run failure demo</button><button className="button button-primary" onClick={() => setModal('event')} disabled={!data}><Plus size={16} />New event</button></div></div>{error ? <div className="error-banner" role="alert"><CircleAlert size={17} /><div><strong>Connection interrupted</strong><span>{error} RelayDesk will reconnect automatically.</span></div><button onClick={refresh}>Try now<RotateCcw size={14} /></button></div> : null}{!data ? <div className="loading-workspace"><LoaderCircle size={26} className="spin" /><h2>Connecting to your workspace</h2><p>Loading the delivery queue and local endpoints.</p></div> : <>{page === 'deliveries' ? <><Metrics overview={data.overview} /><div className="overview-grid"><ActivityChart activity={data.overview.activity} /><QueueHealth overview={data.overview} /></div><DeliveryTable deliveries={visibleDeliveries} query={query} status={status} setQuery={setQuery} setStatus={setStatus} onSelect={setSelectedId} onDemo={() => setModal('demo')} isDeadLetters={false} clearFilters={() => { setQuery(''); setStatus('all'); }} /><div className="workspace-footnote"><ShieldCheck size={13} /><span>Signed requests. Persistent history. Every attempt accounted for.</span><span className="last-synced">Updated {updatedAt ? clockFormat.format(updatedAt) : 'just now'}</span></div></> : page === 'deadletters' ? <><div className="recovery-note"><span><MailWarning size={22} /></span><div><h2>Failures are a starting point.</h2><p>Inspect the response, repair the endpoint, then retry. No need to recreate the event.</p></div><button className="text-action" onClick={() => navigate('endpoints')}>Manage endpoints<ArrowRight size={15} /></button></div><DeliveryTable deliveries={visibleDeliveries} query={query} status="dead_letter" setQuery={setQuery} setStatus={setStatus} onSelect={setSelectedId} onDemo={() => setModal('demo')} isDeadLetters clearFilters={() => setQuery('')} /></> : page === 'endpoints' ? <EndpointsView endpoints={data.endpoints} pending={endpointPending} onUpdate={(id, patch) => void updateEndpoint(id, patch)} onCreate={() => setModal('endpoint')} /> : <Guide onDemo={() => setModal('demo')} onEndpoints={() => navigate('endpoints')} onDeadLetters={() => navigate('deadletters')} />}</>}</main><footer className="app-footer"><span>RelayDesk <span>v1.0.0</span></span><span>A local workbench for dependable delivery.</span></footer></div>{selectedId ? <DeliveryDrawer id={selectedId} revision={revision} onClose={closeDrawer} onRetry={id => void retry(id)} busy={retryBusy} notify={notify} /> : null}{modal === 'event' && data ? <NewEventDialog endpoints={data.endpoints} onClose={closeModal} onSent={message => { closeModal(); refresh(); notify(message); }} /> : modal === 'endpoint' ? <NewEndpointDialog onClose={closeModal} onCreated={() => { closeModal(); refresh(); notify('Local endpoint created.'); }} /> : modal === 'demo' ? <DemoDialog onClose={closeModal} onRun={() => void runDemo()} busy={demoBusy} /> : null}{toast ? <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div> : null}</div>;
}
