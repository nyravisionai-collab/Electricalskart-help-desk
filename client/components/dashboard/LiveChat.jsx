import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { StatusBadge } from './Overview.jsx';

export default function LiveChat({ socket }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [filter, setFilter] = useState('');

  async function load() {
    const res = await api.get('/api/conversations');
    setConversations(res.conversations);
  }
  useEffect(() => {
    load();
    if (!socket) return;
    const onUpdate = () => load();
    socket.on('dashboard:update', onUpdate);
    socket.on('conversation:messages', (payload) => {
      if (payload.conversationId === selected?.id) setMessages(payload.messages);
      load();
    });
    return () => {
      socket.off('dashboard:update', onUpdate);
      socket.off('conversation:messages');
    };
  }, [socket, selected?.id]);

  async function openConv(c) {
    setSelected(c);
    setSuggestion('');
    socket?.emit('conversation:open', { conversationId: c.id });
    const res = await api.get(`/api/conversations/${c.id}/messages`);
    setMessages(res.messages);
  }

  function takeover() {
    if (!selected || !socket) return;
    socket.emit('conversation:takeover', { conversationId: selected.id });
  }
  function closeConv() {
    if (!selected || !socket) return;
    socket.emit('conversation:close', { conversationId: selected.id });
  }
  function send() {
    const v = text.trim();
    if (!v || !selected || !socket) return;
    socket.emit('agent:message', { conversationId: selected.id, message: v });
    setText('');
    setSuggestion('');
  }
  async function suggest() {
    if (!selected || !socket) return;
    socket.emit('agent:suggest', { conversationId: selected.id }, (res) => {
      setSuggestion(res?.suggestion || '');
    });
  }

  const filtered = conversations.filter(c =>
    !filter || c.customer_name?.toLowerCase().includes(filter.toLowerCase()) || c.requirement?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="h-[calc(100vh-80px)] flex flex-col">
      <h1 className="text-2xl font-bold text-slate-900">Live Chat</h1>
      <div className="flex-1 mt-3 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3 min-h-0">
        <aside className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search customers…" className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div className="overflow-y-auto flex-1 scrollbar-thin">
            {filtered.length === 0 && <div className="p-4 text-sm text-slate-400">No conversations.</div>}
            {filtered.map(c => (
              <button
                key={c.id}
                onClick={() => openConv(c)}
                className={`w-full text-left px-3 py-2 border-b border-slate-50 hover:bg-slate-50 flex items-start gap-2 ${selected?.id === c.id ? 'bg-brand-50' : ''}`}
              >
                <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold shrink-0">{(c.customer_name||'?').slice(0,1).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm truncate">{c.customer_name}</div>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="text-xs text-slate-500 truncate">{c.requirement}</div>
                  <div className="text-[10px] text-slate-400">{new Date(c.updated_at).toLocaleTimeString()}</div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden min-h-0">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Select a conversation on the left.</div>
          ) : (
            <>
              <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-semibold flex items-center gap-2">{selected.customer_name} <StatusBadge status={selected.status} /></div>
                  <div className="text-xs text-slate-500">{selected.requirement}</div>
                </div>
                <div className="flex gap-2">
                  {selected.status !== 'HUMAN_ACTIVE' && selected.status !== 'CLOSED' && (
                    <button onClick={takeover} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium">Take over</button>
                  )}
                  <button onClick={suggest} className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-medium">✨ Suggest reply</button>
                  {selected.status !== 'CLOSED' && (
                    <button onClick={closeConv} className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 font-medium">Close</button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-thin bg-slate-50">
                {messages.map(m => (
                  <AgentBubble key={m.id} m={m} customerName={selected.customer_name} />
                ))}
              </div>
              {suggestion && (
                <div className="px-3 py-2 border-t border-slate-100 bg-indigo-50">
                  <div className="text-[10px] font-semibold text-indigo-700 uppercase mb-1">AI Suggested Reply</div>
                  <div className="text-sm text-slate-800">{suggestion}</div>
                  <div className="flex gap-2 mt-1">
                    <button className="text-xs px-2 py-1 bg-indigo-600 text-white rounded" onClick={() => setText(suggestion)}>Use</button>
                    <button className="text-xs px-2 py-1 bg-white border rounded" onClick={() => setSuggestion('')}>Dismiss</button>
                  </div>
                </div>
              )}
              <div className="p-2 border-t border-slate-100 flex items-end gap-2">
                <textarea
                  rows={1}
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={selected.status === 'HUMAN_ACTIVE' ? 'Reply as agent…' : 'Reply (will take over from AI)…'}
                  className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm max-h-32"
                />
                <button onClick={send} className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold">Send</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function AgentBubble({ m, customerName }) {
  const isCustomer = m.senderType === 'CUSTOMER';
  const isSystem = m.senderType === 'SYSTEM';
  if (isSystem) return <div className="text-center text-xs text-slate-500 italic py-1">{m.message}</div>;
  const cls = isCustomer ? 'bg-white border border-slate-200 text-slate-800 mr-auto' : m.senderType === 'AI' ? 'bg-slate-100 text-slate-700 mr-auto' : 'bg-emerald-600 text-white ml-auto';
  const label = isCustomer ? (customerName || 'Customer') : m.senderType === 'AI' ? 'AI' : 'Agent';
  return (
    <div className={`max-w-[80%] ${cls} px-3 py-2 rounded-2xl ${isCustomer ? 'rounded-bl-sm' : 'rounded-br-sm'} shadow-sm animate-fade-in`}>
      <div className={`text-[10px] mb-0.5 ${isCustomer ? 'text-slate-400' : m.senderType === 'AI' ? 'text-slate-500' : 'text-white/75'}`}>{label}</div>
      <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>
    </div>
  );
}
