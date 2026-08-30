import { useEffect, useState } from 'react'
import { api, can } from './api'

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`

export default function Ledger() {
  const [tb, setTb] = useState(null)
  const [txs, setTxs] = useState([])
  const [payables, setPayables] = useState([])
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)

  const load = () => {
    api('/pay/ledger/trial-balance').then(setTb).catch(() => {})
    api('/pay/ledger/transactions?limit=25').then(setTxs).catch(() => setTxs([]))
    api('/pay/payables').then(setPayables).catch(() => setPayables([]))
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])

  const payout = async (technicianId) => {
    setBusy(technicianId); setMsg(null)
    try {
      const r = await api('/pay/payouts', { method: 'POST',
        body: JSON.stringify({ technician_id: technicianId }) })
      setMsg(`paid ${money(r.paid)} — ${r.reference}`)
      load()
    } catch (e) { setMsg(e.message) } finally { setBusy(null) }
  }

  return (
    <>
      <h2>Ledger</h2>
      <div className="sub">
        Double-entry. Every balance below is derived from append-only entries — nothing is stored as a total.
      </div>

      {tb && (
        <div className="card">
          <h3>Trial balance</h3>
          <div className="tb">
            <div><span>debits</span><b>{money(tb.debits)}</b></div>
            <div><span>credits</span><b>{money(tb.credits)}</b></div>
            <div className={tb.balanced ? 'ok' : 'bad'}>
              <span>{tb.balanced ? 'balanced' : 'OUT OF BALANCE'}</span>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 8 }}>{tb.note}</div>
        </div>
      )}

      <div className="card">
        <h3>Owed to technicians</h3>
        {payables.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 13 }}>Nothing outstanding.</div>}
        {payables.map(p => (
          <div className="rhit" key={p.technician_id}>
            <span>technician #{p.technician_id}</span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <b style={{ color: 'var(--good)' }}>{money(p.owed)}</b>
              {can('payment:release')
                ? <button onClick={() => payout(p.technician_id)} disabled={busy === p.technician_id}
                          style={{ padding: '4px 10px', fontSize: 11.5 }}>
                    {busy === p.technician_id ? '…' : 'Pay out'}
                  </button>
                : <span style={{ fontSize: 11, color: 'var(--faint)' }}>finance only</span>}
            </span>
          </div>
        ))}
        {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--accent)' }}>{msg}</div>}
      </div>

      <div className="card">
        <h3>Transactions</h3>
        {txs.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 13 }}>No postings yet.</div>}
        {txs.map(t => (
          <div className="tx" key={t.id}>
            <div className="tx-h">
              <span>{t.description}</span>
              <span className="tx-t">{new Date(t.created_at).toLocaleTimeString()}</span>
            </div>
            {t.entries.map((e, i) => (
              <div className="tx-e" key={i}>
                <span className={e.direction}>{e.direction === 'debit' ? 'DR' : 'CR'}</span>
                <span className="acct">{e.account}{e.owner ? `:${e.owner}` : ''}</span>
                <span className="amt">{money(e.amount)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
