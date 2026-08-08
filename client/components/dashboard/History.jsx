import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function History() {
  const [tab, setTab] = useState('chats');
  const [conversations, setConversations] = useState([]);
  const [calls, setCalls] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.get('/api/conversations').then(res => setConversations(res.conversations)).catch(() => {});
    api.get('/api/calls/history').then(res => setCalls(res.calls)).catch(() => {});
  }, []);

  const filteredConvs = conversations.filter(c =>
    !filter || c.customer_name?.toLowerCase().includes(filter.toLowerCase()) || c.requirement?.toLowerCase().includes(filter.toLowerCase())
  );
  const filteredCalls = calls.filter(c =>
    !filter || c.customer_name?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">History</h1>
      <div className="flex gap-2 mt-3 flex-wrap items-center">
        <button onClick={() => setTab('chats')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab==='chats' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'}`}>Chats</button>
        <button onClick={() => setTab('calls')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab==='calls' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'}`}>Calls</button>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search…" className="ml-auto px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>
      <div className="mt-4 bg-white rounded-xl border border-slate-200 overflow-hidden">
        {tab === 'chats' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Started</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-left px-3 py-2">Requirement</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {filteredConvs.length === 0 && <tr><td colSpan="5" className="px-3 py-6 text-center text-slate-400">No conversations yet.</td></tr>}
                {filteredConvs.map(c => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{new Date(c.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{c.customer_name}</td>
                    <td className="px-3 py-2 max-w-md truncate">{c.requirement}</td>
                    <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded-full bg-slate-100">{c.status}</span></td>
                    <td className="px-3 py-2 text-slate-500">{new Date(c.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Handled by</th>
                  <th className="text-left px-3 py-2">Duration</th>
                  <th className="text-left px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredCalls.length === 0 && <tr><td colSpan="6" className="px-3 py-6 text-center text-slate-400">No calls yet.</td></tr>}
                {filteredCalls.map(c => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{new Date(c.started_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{c.customer_name}</td>
                    <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded-full bg-slate-100">{c.status}</span></td>
                    <td className="px-3 py-2">{c.handled_by_name || '—'}</td>
                    <td className="px-3 py-2">{c.duration ? Math.floor(c.duration/60)+':'+String(c.duration%60).padStart(2,'0') : '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{c.end_reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
