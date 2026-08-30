import { useState } from 'react'
import { login } from './api'

const QUICK = [
  { label: 'Hirer — Northwind Retail', email: 'hirer@northwind.retail.group.test' },
  { label: 'Hirer — Blue Harbor Bank',  email: 'hirer@blue.harbor.bank.test' },
  { label: 'Dispatcher',                email: 'dispatcher@fieldnation.test' },
  { label: 'Finance',                   email: 'finance@fieldnation.test' },
  { label: 'Admin',                     email: 'admin@fieldnation.test' },
]

export default function Login({ onDone }) {
  const [email, setEmail] = useState(QUICK[0].email)
  const [password, setPassword] = useState('Passw0rd!')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e?.preventDefault()
    setBusy(true); setErr(null)
    try { onDone(await login(email, password)) }
    catch (ex) { setErr(ex.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand" style={{ fontSize: 20, marginBottom: 4 }}>Work Order <span>Console</span></div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
          Sign in to dispatch work and review technician matches.
        </div>
        <input placeholder="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
        <input placeholder="password" type="password" value={password}
               onChange={e => setPassword(e.target.value)} style={{ marginTop: 8 }} />
        {err && <div className="err">{err}</div>}
        <button type="submit" disabled={busy} style={{ width: '100%', marginTop: 12, padding: '9px' }}>
          {busy ? 'signing in…' : 'Sign in'}
        </button>
        <div className="quick-h">Seeded accounts — password <code>Passw0rd!</code></div>
        {QUICK.map(q => (
          <div key={q.email} className="quick" onClick={() => setEmail(q.email)}>
            <span>{q.label}</span><code>{q.email}</code>
          </div>
        ))}
      </form>
    </div>
  )
}
