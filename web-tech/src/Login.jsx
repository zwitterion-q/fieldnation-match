import { useEffect, useState } from 'react'
import { login } from './api'

export default function Login({ onDone }) {
  const [techs, setTechs] = useState([])
  const [email, setEmail] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  // Populate the picker from live technician profiles so the demo never needs
  // anyone to remember an address.
  useEffect(() => {
    fetch('/api/technicians?limit=60').then(r => r.json()).then(d => {
      const list = d.items.map(t => ({
        id: t.technician_id, name: t.full_name,
        headline: t.headline, city: `${t.city}, ${t.state}`,
        email: `${t.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${t.technician_id}@tech.test`,
      }))
      setTechs(list)
      if (list.length) setEmail(list[0].email)
    }).catch(() => {})
  }, [])

  const submit = async (e) => {
    e?.preventDefault()
    setBusy(true); setErr(null)
    try { onDone(await login(email, 'Passw0rd!')) }
    catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  }

  return (
    <div className="shell">
      <div className="appbar"><div className="logo">Field<span>Nation</span> · Technician</div></div>
      <div className="login-body">
        <h2>Sign in</h2>
        <p className="sub">Pick your account. Every technician uses <code>Passw0rd!</code></p>
        <form onSubmit={submit}>
          <select value={email} onChange={e => setEmail(e.target.value)} style={{ width: '100%', maxWidth: 'none' }}>
            {techs.map(t => (
              <option key={t.id} value={t.email}>{t.name} — {t.city}</option>
            ))}
          </select>
          <button type="submit" disabled={busy || !email} className="primary">
            {busy ? 'signing in…' : 'Sign in'}
          </button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  )
}
