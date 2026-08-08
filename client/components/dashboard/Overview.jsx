import React from 'react';

export default function Overview({ summary, agentsOnline }) {
  const s = summary?.stats || {};
  const cards = [
    { label: 'Active customers', value: s.active_customers ?? '—', color: 'bg-brand-50 text-brand-700' },
    { label: 'AI conversations', value: s.ai_conversations ?? '—', color: 'bg-sky-50 text-sky-700' },
    { label: 'Human required', value: s.human_required ?? '—', color: 'bg-amber-50 text-amber-700' },
    { label: 'Human chats', value: s.human_active ?? '—', color: 'bg-emerald-50 text-emerald-700' },
    { label: 'Active calls', value: s.active_calls ?? '—', color: 'bg-rose-50 text-rose-700' },
    { label: 'Waiting calls', value: s.waiting_calls ?? '—', color: 'bg-indigo-50 text-indigo-700' },
    { label: 'Total conversations', value: s.total_conversations ?? '—', color: 'bg-slate-100 text-slate-700' },
    { label: 'Total calls', value: s.total_calls ?? '—', color: 'bg-slate-100 text-slate-700' },
  ];
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
      <p className="text-slate-500 text-sm">Live status of customer support operations.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
        {cards.map(c => (
          <div key={c.label} className={`rounded-xl p-4 ${c.color}`}>
            <div className="text-xs uppercase tracking-wide opacity-75">{c.label}</div>
            <div className="text-2xl font-bold mt-1">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold mb-2">Active conversations</h2>
          {!summary?.conversations?.length ? (
            <div className="text-sm text-slate-400">No active conversations.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {summary.conversations.slice(0, 10).map(c => (
                <li key={c.conversation_id} className="py-2 flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.customer_name}</div>
                    <div className="text-xs text-slate-500 truncate">{c.requirement}</div>
                  </div>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold mb-2">Agents online ({agentsOnline?.length || 0})</h2>
          {!agentsOnline?.length ? (
            <div className="text-sm text-slate-400">No agents online.</div>
          ) : (
            <ul className="space-y-1 text-sm">
              {agentsOnline.map((a, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="dot bg-emerald-500" /> {a.name} <span className="text-xs text-slate-400 capitalize">({a.role})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function StatusBadge({ status }) {
  const map = {
    AI_ACTIVE: { label: 'AI Chat', cls: 'bg-sky-100 text-sky-700' },
    HUMAN_REQUIRED: { label: 'Human Required', cls: 'bg-amber-100 text-amber-800' },
    HUMAN_ACTIVE: { label: 'Human Chat', cls: 'bg-emerald-100 text-emerald-700' },
    WAITING_CALL: { label: 'Waiting Call', cls: 'bg-indigo-100 text-indigo-700' },
    IN_CALL: { label: 'In Call', cls: 'bg-rose-100 text-rose-700' },
    CLOSED: { label: 'Closed', cls: 'bg-slate-200 text-slate-600' },
  };
  const info = map[status] || { label: status, cls: 'bg-slate-200 text-slate-600' };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${info.cls}`}>{info.label}</span>;
}
