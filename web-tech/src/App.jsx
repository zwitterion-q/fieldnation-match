import { useEffect, useState, useCallback } from 'react'
import { api, getUser, clearAuth } from './api'
import Login from './Login.jsx'

const money = (n) => `$${Number(n || 0).toFixed(0)}`

function Ring({ v }) {
  const pct = Math.round(v * 100)
  return (
    <div className="ring" style={{ background: `conic-gradient(var(--accent) ${Math.round(v * 360)}deg, var(--card2) 0deg)` }}>
      <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--card)', display: 'grid', placeItems: 'center' }}>{pct}</div>
    </div>
  )
}

function Why({ b }) {
  const shown = (b || []).filter(r => r.required > 0).slice(0, 4)
  if (!shown.length) return null
  return (
    <div className="why">
      <div className="why-h">Why this matched you</div>
      {shown.map(r => (
        <div key={r.feature_type}>
          <div className="wrow">
            <span className="wlab">{r.label}</span>
            <span className="wbar"><i style={{ width: `${r.coverage * 100}%` }} /></span>
            <span className="wcnt">{r.matched}/{r.required}</span>
          </div>
          {r.matched_names.length > 0 && <div className="matched">✓ {r.matched_names.join(', ')}</div>}
        </div>
      ))}
    </div>
  )
}

/** A live offer the technician must answer. */
function Offer({ a, onAnswered }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const left = Math.max(0, Math.round((new Date(a.expiresAt) - Date.now()) / 60000))

  const submit = async () => {
    setBusy('submit'); setErr(null)
    try {
      await api(`/wo/assignments/${a.id}/submit`, { method: 'POST',
        body: JSON.stringify({ hours_worked: Number(a.durationHours) || undefined,
                               note: 'work completed on site' }) })
      onAnswered()
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  const respond = async (accept) => {
    setBusy(accept ? 'accept' : 'reject'); setErr(null)
    try {
      await api(`/wo/assignments/${a.id}/${accept ? 'accept' : 'reject'}`, {
        method: 'POST',
        body: JSON.stringify(accept ? {} : { reason: 'not available' }),
      })
      onAnswered()
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  return (
    <div className={`job ${a.status === 'dispatched' ? 'top' : ''}`}>
      <div className="jhead">
        <div style={{ flex: 1 }}>
          <div className="jtitle">{a.title || `Work order #${a.workOrderId}`}</div>
          <div className="jmeta">
            {a.buyerCompany || '—'}
            {a.matchScore ? ` · match ${Math.round(a.matchScore * 100)}` : ''}
          </div>
        </div>
        <span className={`badge ${a.status}`}>{a.status}</span>
      </div>

      <div className="pay">
        {a.payRate > 0 && <span><b>{money(a.payRate)}</b>/{a.payType || 'hr'}</span>}
        {a.durationHours && <span>~{a.durationHours}h</span>}
        {a.status === 'dispatched' && <span className="countdown">expires in {left}m</span>}
      </div>

      {a.holdState && a.holdState !== 'none' &&
        <div className="escrow">funds <b>{a.holdState}</b> in escrow</div>}

      <Why b={a.breakdown} />

      {a.status === 'dispatched' && (
        <>
          <div className="actions">
            <button className="accept" disabled={!!busy} onClick={() => respond(true)}>
              {busy === 'accept' ? '…' : 'Accept'}
            </button>
            <button className="decline" disabled={!!busy} onClick={() => respond(false)}>
              {busy === 'reject' ? '…' : 'Decline'}
            </button>
          </div>
          {err && <div className="err">{err}</div>}
        </>
      )}

      {a.status === 'accepted' && (
        <>
          <div className="actions">
            <button className="accept" disabled={!!busy} onClick={submit}>
              {busy === 'submit' ? '…' : 'Mark work complete'}
            </button>
          </div>
          {err && <div className="err">{err}</div>}
        </>
      )}

      {a.status === 'submitted' &&
        <div className="escrow">submitted{a.hoursWorked ? ` — ${a.hoursWorked}h` : ''} · awaiting hirer approval</div>}
      {a.status === 'completed' &&
        <div className="escrow">approved — payment released to your account</div>}
      {a.rejectReason && <div className="escrow">declined — {a.rejectReason}</div>}
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(getUser())
  const [tab, setTab] = useState('offers')
  const [assignments, setAssignments] = useState([])
  const [recs, setRecs] = useState([])
  const [profile, setProfile] = useState(null)
  const [earnings, setEarnings] = useState(null)

  const refresh = useCallback(() => {
    if (!user?.subject_id) return
    api('/wo/assignments/mine').then(async (rows) => {
      // Assignments carry ids, not titles -- work-orders owns the lifecycle,
      // the matching service owns the description. Joined here in the client
      // rather than making one service reach into the other's database.
      const enriched = await Promise.all(rows.map(async (a) => {
        try {
          const wo = await fetch(`/api/work-orders/${a.workOrderId}`).then(r => r.json())
          return { ...a, title: wo.title }
        } catch { return a }
      }))
      setAssignments(enriched)
    }).catch(() => setAssignments([]))
  }, [user])

  useEffect(() => {
    if (!user) return
    refresh()
    const t = setInterval(refresh, 3000)          // poll for new dispatches
    return () => clearInterval(t)
  }, [user, refresh])

  useEffect(() => {
    if (!user) return
    const load = () => api('/pay/balance/me')
      .then(d => setEarnings(d.accounts?.find(a => a.code === 'technician_payable')?.balance))
      .catch(() => {})
    load(); const t = setInterval(load, 4000); return () => clearInterval(t)
  }, [user])

  useEffect(() => {
    if (!user?.subject_id) return
    fetch(`/api/technicians/${user.subject_id}`).then(r => r.json()).then(setProfile).catch(() => {})
    fetch(`/api/technicians/${user.subject_id}/matches?limit=15`)
      .then(r => r.json()).then(d => setRecs(d.matches || [])).catch(() => {})
  }, [user])

  if (!user) return <Login onDone={setUser} />

  const live = assignments.filter(a => ['dispatched', 'accepted', 'submitted'].includes(a.status))
  const done = assignments.filter(a => !['dispatched', 'accepted', 'submitted'].includes(a.status))
  const skills = (profile?.attributes || []).filter(a => a.type === 'skill')

  return (
    <div className="shell">
      <div className="appbar">
        <div className="row">
          <div className="logo">Field<span>Nation</span> · Technician</div>
          <button className="signout" onClick={() => { clearAuth(); setUser(null) }}>sign out</button>
        </div>
        <div className="me">
          <b>{user.full_name}</b>{profile && <> · {profile.city}, {profile.state} · ★{profile.rating}</>}
          {earnings !== undefined && earnings !== null &&
            <> · earned <b style={{ color: 'var(--good)' }}>${Number(earnings).toFixed(2)}</b></>}
        </div>
        {skills.length > 0 &&
          <div className="chips">{skills.slice(0, 5).map(s => <span className="chip" key={s.id}>{s.name}</span>)}</div>}
      </div>

      <div className="tabs">
        <div className={`tab ${tab === 'offers' ? 'on' : ''}`} onClick={() => setTab('offers')}>
          My work<span className="n">{live.length}</span>
        </div>
        <div className={`tab ${tab === 'recs' ? 'on' : ''}`} onClick={() => setTab('recs')}>
          Recommended<span className="n">{recs.length}</span>
        </div>
        <div className={`tab ${tab === 'hist' ? 'on' : ''}`} onClick={() => setTab('hist')}>
          History<span className="n">{done.length}</span>
        </div>
      </div>

      <div className="list">
        {tab === 'offers' && (live.length === 0
          ? <div className="empty">Nothing active.<br />A hirer needs to dispatch work to you.</div>
          : live.map(a => <Offer key={a.id} a={a} onAnswered={refresh} />))}

        {tab === 'hist' && (done.length === 0
          ? <div className="empty">Nothing yet.</div>
          : done.map(a => <Offer key={a.id} a={a} onAnswered={refresh} />))}

        {tab === 'recs' && (recs.length === 0
          ? <div className="empty">No recommendations.</div>
          : recs.map(j => (
            <div className="job" key={j.work_order_id}>
              <div className="jhead">
                <div style={{ flex: 1 }}>
                  <div className="jtitle">{j.title}</div>
                  <div className="jmeta">{j.company || '—'} · {[j.city, j.state].filter(Boolean).join(', ')}</div>
                </div>
                <Ring v={j.match_score} />
              </div>
              <div className="pay">
                {j.pay_rate > 0 && <span><b>{money(j.pay_rate)}</b>/{j.pay_type || 'hr'}</span>}
                {j.duration_hours && <span>~{j.duration_hours}h</span>}
              </div>
              <Why b={j.breakdown} />
            </div>
          )))}
      </div>
    </div>
  )
}
