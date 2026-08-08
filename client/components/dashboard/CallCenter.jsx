import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function CallCenter({ socket, summary, activeCall }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    api.get('/api/calls/history').then(res => setHistory(res.calls)).catch(() => {});
    if (!socket) return;
    const refresh = () => api.get('/api/calls/history').then(res => setHistory(res.calls)).catch(() => {});
    socket.on('dashboard:update', refresh);
    socket.on('call:ended', refresh);
    return () => {
      socket.off('dashboard:update', refresh);
      socket.off('call:ended', refresh);
    };
  }, [socket]);

  const queue = summary?.calls?.filter(call => call.status === 'WAITING') || [];
  const current = summary?.calls?.find(call => call.status === 'ACTIVE') || null;

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Call Center</h1>
      <p className="text-slate-500 text-sm">Browser-to-browser calls only. No phone numbers used.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Current Call</div>
          {activeCall || current ? (
            <div className="mt-2">
              <div className="text-lg font-semibold text-emerald-700">🔴 In call</div>
              <div className="text-sm text-slate-600">Call ID: {activeCall?.callId || current?.id}</div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-slate-400">No active call.</div>
          )}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Waiting Queue</div>
          {queue.length === 0 ? (
            <div className="mt-2 text-sm text-slate-400">No callers waiting.</div>
          ) : (
            <ul className="mt-2 text-sm space-y-1">
              {queue.map(q => (
                <li key={q.id} className="flex items-center justify-between">
                  <span>#{q.queue_position}</span>
                  <span className="text-slate-700 truncate px-2">{q.customer_name || 'Customer'}</span>
                  <span className="text-xs text-slate-400">{new Date(q.started_at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Stats</div>
          <div className="mt-2 text-sm">
            <div>Total handled: <b>{history.filter(call => call.status === 'ENDED').length}</b></div>
            <div>Missed/rejected: <b>{history.filter(call => ['MISSED','REJECTED','FAILED','CANCELLED'].includes(call.status)).length}</b></div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 mt-5">
        <div className="p-3 border-b border-slate-100 font-semibold">Recent calls</div>
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
              {history.length === 0 && <tr><td colSpan="6" className="px-3 py-4 text-center text-slate-400">No call history yet.</td></tr>}
              {history.map(c => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(c.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{c.customer_name}</td>
                  <td className="px-3 py-2"><CallStatusBadge status={c.status} /></td>
                  <td className="px-3 py-2">{c.handled_by_name || '—'}</td>
                  <td className="px-3 py-2">{fmtDur(c.duration)}</td>
                  <td className="px-3 py-2 text-slate-500">{c.end_reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CallStatusBadge({ status }) {
  const map = {
    WAITING: { label: 'Waiting', cls: 'bg-indigo-100 text-indigo-700' },
    RINGING: { label: 'Ringing', cls: 'bg-amber-100 text-amber-700' },
    ACTIVE: { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' },
    ENDED: { label: 'Ended', cls: 'bg-slate-200 text-slate-700' },
    REJECTED: { label: 'Rejected', cls: 'bg-red-100 text-red-700' },
    MISSED: { label: 'Missed', cls: 'bg-red-100 text-red-700' },
    FAILED: { label: 'Failed', cls: 'bg-red-100 text-red-700' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-600' },
  };
  const info = map[status] || { label: status, cls: 'bg-slate-100' };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${info.cls}`}>{info.label}</span>;
}

function fmtDur(s) {
  if (!s) return '—';
  const m = Math.floor(s / 60); const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
