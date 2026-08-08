import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState({ convs: [], calls: [] });

  useEffect(() => {
    api.get('/api/customers').then(res => setCustomers(res.customers)).catch(() => {});
  }, []);

  async function openCustomer(c) {
    setSelected(c);
    const [convsRes, callsRes] = await Promise.all([
      api.get('/api/conversations'),
      api.get('/api/calls/history'),
    ]);
    const convs = convsRes.conversations.filter(x => x.customer_id === c.id);
    const calls = callsRes.calls.filter(x => x.customer_id === c.id);
    setHistory({ convs, calls });
  }

  const filtered = customers.filter(c =>
    !filter || c.name?.toLowerCase().includes(filter.toLowerCase()) || c.requirement?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-3">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search customers…" className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div className="max-h-[70vh] overflow-y-auto scrollbar-thin">
            {filtered.length === 0 && <div className="p-4 text-sm text-slate-400">No customers.</div>}
            {filtered.map(c => (
              <button key={c.id} onClick={() => openCustomer(c)} className={`w-full text-left px-3 py-2 border-b border-slate-50 hover:bg-slate-50 flex items-start gap-2 ${selected?.id === c.id ? 'bg-brand-50' : ''}`}>
                <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold shrink-0">{(c.name||'?').slice(0,1).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 truncate">{c.requirement}</div>
                  <div className="text-[10px] text-slate-400">
                    Chats: {c.conversation_count} • Calls: {c.call_count} • Last: {c.last_active_at ? new Date(c.last_active_at).toLocaleString() : '—'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 min-h-[60vh]">
          {!selected ? (
            <div className="text-slate-400 text-sm h-full flex items-center justify-center">Select a customer to view their history.</div>
          ) : (
            <div>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-lg">{(selected.name||'?').slice(0,1).toUpperCase()}</div>
                <div>
                  <div className="font-semibold text-lg">{selected.name}</div>
                  <div className="text-sm text-slate-500">{selected.requirement}</div>
                  <div className="text-xs text-slate-400">First seen {new Date(selected.created_at).toLocaleString()}</div>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div>
                  <h3 className="font-semibold text-sm mb-2">Chat sessions</h3>
                  {history.convs.length === 0 ? <div className="text-xs text-slate-400">None.</div> : (
                    <ul className="space-y-1 text-sm">
                      {history.convs.map(c => (
                        <li key={c.id} className="border border-slate-100 rounded-lg p-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleString()}</span>
                            <span className="text-xs px-2 py-0.5 bg-slate-100 rounded-full">{c.status}</span>
                          </div>
                          <div className="text-slate-700 mt-1">{c.requirement}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold text-sm mb-2">Call history</h3>
                  {history.calls.length === 0 ? <div className="text-xs text-slate-400">None.</div> : (
                    <ul className="space-y-1 text-sm">
                      {history.calls.map(c => (
                        <li key={c.id} className="border border-slate-100 rounded-lg p-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-500">{new Date(c.started_at).toLocaleString()}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'ENDED' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>{c.status}</span>
                          </div>
                          <div className="text-slate-700 mt-1">Duration {c.duration ? Math.floor(c.duration/60)+':'+String(c.duration%60).padStart(2,'0') : '—'} • {c.end_reason || 'completed'}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
