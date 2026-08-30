import { useEffect, useState, Fragment, useCallback } from 'react'
import { api as authed, getUser, clearAuth, can } from './api'
import Login from './Login.jsx'
import Ledger from './Ledger.jsx'

/** Matching service (read-only, unauthenticated in this build). */
const api = (p) => fetch(`/api${p}`).then(r => { if (!r.ok) throw new Error(r.status); return r.json() })

function Attr({ a }) {
  return <span className={`attr t-${a.type}`}>{a.name}
    {a.resolved_by === 'vector_knn' && <small>kNN</small>}</span>
}

function Breakdown({ b }) {
  return (
    <div className="bd">
      {b.map(r => (
        <Fragment key={r.feature_type}>
          <div className="lab">{r.label}</div>
          <div className="cnt">{r.matched}/{r.required}</div>
          <div>
            {r.matched_names.length > 0 && <div className="names">{r.matched_names.join(', ')}</div>}
            {r.missing_names.length > 0 && <div className="miss">missing: {r.missing_names.join(', ')}</div>}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function Resolver() {
  const [q, setQ] = useState('ran cat6 above the ceiling grid')
  const [type, setType] = useState('skill')
  const [hits, setHits] = useState([])
  const go = () => api(`/resolve?q=${encodeURIComponent(q)}&attribute_type=${type}`)
    .then(d => setHits(d.matches)).catch(() => setHits([]))
  useEffect(() => { go() }, [])
  return (
    <div className="card">
      <h3>Live taxonomy resolution</h3>
      <div className="resolve">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
        <select value={type} onChange={e => setType(e.target.value)} style={{ width: 150 }}>
          {['skill', 'experience', 'experience_type', 'industry', 'experience_level', 'certification']
            .map(t => <option key={t}>{t}</option>)}
        </select>
        <button onClick={go}>Resolve</button>
      </div>
      {hits.map(h => (
        <div className="rhit" key={h.attribute_id}>
          <span>#{h.attribute_id} &nbsp; {h.canonical_name}</span>
          <b>{h.score.toFixed(3)}</b>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 8 }}>
        Free text is embedded and kNN'd against that taxonomy collection — this is the
        normalisation step that turns an advert phrase into a canonical attribute id.
      </div>
    </div>
  )
}

function DispatchPanel({ workOrderId, tech, assignments, onDispatched }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const mine = assignments.filter(a => a.technicianId === tech.technician_id)
  const ACTIVE = ['dispatched', 'accepted', 'submitted', 'completed']
  const live = mine.find(a => ACTIVE.includes(a.status))
  const past = mine.filter(a => !ACTIVE.includes(a.status))

  const act = async (verb, body) => {
    setBusy(true); setErr(null)
    try {
      await authed(`/wo/assignments/${live.id}/${verb}`, {
        method: 'POST', body: JSON.stringify(body || {}) })
      onDispatched()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const dispatch = async () => {
    setBusy(true); setErr(null)
    try {
      await authed('/wo/assignments', { method: 'POST', body: JSON.stringify({
        work_order_id: workOrderId, technician_id: tech.technician_id,
        match_score: tech.match_score }) })
      onDispatched()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (live) {
    return (
      <div className="assg">
        <span className={`st ${live.status}`}>{live.status}</span>
        {' · '}assignment #{live.id}
        {live.holdState !== 'none' && <> · escrow <b>{live.holdState}</b></>}
        {live.status === 'dispatched' && <> · awaiting response</>}
        {live.status === 'accepted' && <> · technician on the job</>}

        {live.status === 'submitted' && (
          <>
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              submitted{live.hoursWorked ? ` — ${live.hoursWorked}h` : ''}
              {live.completionNote ? ` · "${live.completionNote}"` : ''}
            </div>
            <div className="disp">
              <button onClick={() => act('approve')} disabled={busy || !can('workorder:approve')}>
                {busy ? '…' : 'Approve & release payment'}
              </button>
              <button onClick={() => act('rework', { reason: 'needs a return visit' })}
                      disabled={busy} style={{ background: 'transparent', borderColor: 'var(--line)', color: 'var(--muted)' }}>
                Request rework
              </button>
            </div>
            {!can('workorder:approve') &&
              <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 6 }}>
                your role cannot approve work</div>}
          </>
        )}

        {live.status === 'completed' &&
          <div style={{ marginTop: 6, color: 'var(--good)' }}>
            approved — escrow released to the technician
          </div>}

        {err && <div className="err">{err}</div>}
      </div>
    )
  }
  return (
    <>
      <div className="disp">
        <button onClick={dispatch} disabled={busy || !can('workorder:dispatch')}>
          {busy ? 'dispatching…' : 'Dispatch to this technician'}
        </button>
        {!can('workorder:dispatch') && <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>
          your role cannot dispatch</span>}
        {err && <span className="err">{err}</span>}
      </div>
      {past.length > 0 && <div className="hist">
        previously: {past.map(a => `#${a.id} ${a.status}${a.rejectReason ? ` (${a.rejectReason})` : ''}`).join(', ')}
      </div>}
    </>
  )
}

export default function App() {
  const [user, setUser] = useState(getUser())
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [sel, setSel] = useState(null)
  const [detail, setDetail] = useState(null)
  const [matches, setMatches] = useState(null)
  const [q, setQ] = useState('')
  const [stats, setStats] = useState(null)
  const [view, setView] = useState('work')
  const [assignments, setAssignments] = useState([])
  const [balance, setBalance] = useState(null)

  // Poll rather than push. A WebSocket would be nicer, but the state that
  // matters here changes on a human timescale and polling cannot desynchronise.
  const refreshAssignments = useCallback(() => {
    if (!sel) return
    authed(`/wo/work-orders/${sel}/assignments`).then(setAssignments).catch(() => setAssignments([]))
  }, [sel])

  useEffect(() => {
    if (!user) return
    refreshAssignments()
    const t = setInterval(refreshAssignments, 3000)
    return () => clearInterval(t)
  }, [user, refreshAssignments])

  useEffect(() => {
    if (!user) return
    const load = () => authed('/pay/balance/me').then(setBalance).catch(() => {})
    load(); const t = setInterval(load, 5000); return () => clearInterval(t)
  }, [user])

  useEffect(() => { api('/stats').then(setStats).catch(() => { }) }, [])
  useEffect(() => {
    const t = setTimeout(() => api(`/work-orders?limit=60&q=${encodeURIComponent(q)}`)
      .then(d => { setItems(d.items); setTotal(d.total) }).catch(() => setItems([])), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    if (!sel) return
    setDetail(null); setMatches(null)
    api(`/work-orders/${sel}`).then(setDetail).catch(() => { })
    api(`/work-orders/${sel}/matches?limit=8`).then(setMatches).catch(() => setMatches({ matches: [] }))
  }, [sel])

  if (!user) return <Login onDone={setUser} />

  const avail = balance?.accounts?.find(a => a.code === 'hirer_funds')?.balance

  return (
    <div className="app">
      <header className="top">
        <div className="brand">Work Order <span>Console</span></div>
        {stats && <>
          <div className="stat"><b>{stats.indexed_work_orders}</b> work orders indexed</div>
          <div className="stat"><b>{stats.work_order_feature_vectors}</b> feature vectors</div>
          <div className="stat"><b>{stats.indexed_technicians}</b> technicians</div>
          <div className="stat">dedup: {stats.dedupe.map(d => `${d.n} ${d.method}`).join(' · ') || 'none'}</div>
        </>}
        {avail !== undefined && <div className="bal">available <b>${Number(avail).toLocaleString()}</b></div>}
        <div className="who">
          <span><b>{user.company_name || user.full_name}</b></span>
          {user.roles.map(r => <span className="roles" key={r}>{r}</span>)}
          <button onClick={() => { clearAuth(); setUser(null) }}>sign out</button>
        </div>
      </header>

      <div className="left">
        <div className="filters">
          <input placeholder="Search title or buyer…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {items.length === 0 && <div className="empty">No work orders. Has the pipeline run?</div>}
        {items.map(w => (
          <div key={w.work_order_id} className={`wo ${sel === w.work_order_id ? 'sel' : ''}`}
            onClick={() => setSel(w.work_order_id)}>
            <div className="wo-title">{w.title}</div>
            <div className="wo-meta">
              <span>{w.company || '—'}</span>
              <span>{[w.city, w.state].filter(Boolean).join(', ') || 'remote'}</span>
              {w.pay_rate > 0 && <span>${Number(w.pay_rate).toFixed(0)}/{w.pay_type || 'hr'}</span>}
              <span className={`pill ${w.source_type === 'live_api' ? 'live' : 'syn'}`}>{w.source}</span>
              <span className="pill">{w.n_attrs} attrs</span>
            </div>
          </div>
        ))}
      </div>

      <div className="right">
        {can('ledger:view') && (
          <div className="navtabs">
            <div className={`navtab ${view === 'work' ? 'on' : ''}`} onClick={() => setView('work')}>Work orders</div>
            <div className={`navtab ${view === 'ledger' ? 'on' : ''}`} onClick={() => setView('ledger')}>Ledger</div>
          </div>
        )}

        {view === 'ledger' && <Ledger />}

        {view === 'work' && !sel && <>
          <h2>{total} open work orders</h2>
          <div className="sub">Select a work order to see its normalised features and ranked technicians.</div>
          <Resolver />
          {stats && <div className="card">
            <h3>Ingestion provenance</h3>
            {stats.work_orders_by_source.map(s => (
              <div className="rhit" key={s.source}>
                <span><span className={`pill ${s.source_type === 'live_api' ? 'live' : 'syn'}`}>
                  {s.source_type === 'live_api' ? 'live' : 'generated'}</span> &nbsp; {s.source}</span>
                <b>{s.n}{s.dupes > 0 && ` (${s.dupes} dup)`}</b>
              </div>
            ))}
            <h3 style={{ marginTop: 14 }}>Attribute resolution</h3>
            {stats.attribute_resolution.map(r => (
              <div className="rhit" key={r.resolved_by}>
                <span>{r.resolved_by === 'alias' ? 'exact alias match' : 'taxonomy kNN'}</span><b>{r.n}</b>
              </div>
            ))}
          </div>}
        </>}

        {view === 'work' && sel && detail && <>
          <h2>{detail.title}</h2>
          <div className="sub">
            {detail.company} · {[detail.city, detail.state].filter(Boolean).join(', ')}
            {detail.pay_rate > 0 && ` · $${Number(detail.pay_rate).toFixed(2)} ${detail.pay_type}`}
            {detail.duration_hours && ` · ~${detail.duration_hours}h`}
          </div>

          <div className="card">
            <h3>Normalised attributes — resolved to taxonomy ids</h3>
            <div className="attrs">
              {detail.attributes.length === 0 && <span className="miss">none resolved</span>}
              {detail.attributes.map(a => <Attr key={a.id} a={a} />)}
            </div>
          </div>

          <div className="card">
            <h3>Description — the only field left unstructured</h3>
            <div style={{ color: 'var(--muted)', fontSize: 13, maxHeight: 150, overflow: 'auto' }}>
              {detail.body_clean}
            </div>
          </div>

          <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)' }}>
            Ranked technicians
          </h3>
          {!matches && <div className="empty">matching…</div>}
          {matches && matches.matches.length === 0 && <div className="empty">No matches.</div>}
          {matches && matches.matches.map(m => (
            <div className="match" key={m.technician_id}>
              <div className="match-head">
                <div>
                  <div style={{ fontWeight: 600 }}>{m.full_name}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                    {m.headline} · {m.city}, {m.state} · ${Number(m.hourly_rate).toFixed(0)}/hr ·
                    ★{m.rating} · {m.jobs_completed} jobs
                  </div>
                </div>
                <div className="score">{(m.match_score * 100).toFixed(0)}
                  <small>vec {m.vector_score.toFixed(3)} · cov {(m.attribute_coverage * 100).toFixed(0)}%</small>
                </div>
              </div>
              <div className="bar"><i style={{ width: `${m.match_score * 100}%` }} /></div>
              <Breakdown b={m.breakdown} />
              <DispatchPanel workOrderId={sel} tech={m} assignments={assignments}
                             onDispatched={refreshAssignments} />
            </div>
          ))}
        </>}
      </div>
    </div>
  )
}
