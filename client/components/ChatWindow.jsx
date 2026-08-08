import React, { useEffect, useRef, useState } from 'react';

export default function ChatWindow({ messages, typing, onSend, children }) {
  const [text, setText] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  function submit(e) {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText('');
  }

  return (
    <div className="flex-1 flex flex-col bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden min-h-[60vh]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        {messages.length === 0 && !typing && (
          <div className="text-center text-slate-400 text-sm py-6">Say hi to get started.</div>
        )}
        {messages.map(m => <Bubble key={m.id} m={m} />)}
        {typing && (
          <div className="bubble-ai inline-block px-4 py-2 text-sm text-slate-500">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '120ms' }} />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '240ms' }} />
            </span>
          </div>
        )}
      </div>
      {children}
      <form onSubmit={submit} className="border-t border-slate-200 p-2 sm:p-3 flex items-end gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          rows={1}
          placeholder="Type your message…"
          className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 max-h-32 text-sm"
        />
        <button type="submit" className="py-2 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-medium text-sm">Send</button>
      </form>
    </div>
  );
}

function Bubble({ m }) {
  const t = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.senderType === 'SYSTEM') {
    return <div className="bubble-system">{m.message}</div>;
  }
  const isCustomer = m.senderType === 'CUSTOMER';
  const isAgent = m.senderType === 'AGENT';
  const cls = isCustomer ? 'bubble-customer ml-auto' : isAgent ? 'bubble-agent mr-auto' : 'bubble-ai mr-auto';
  const senderLabel = isCustomer ? 'You' : isAgent ? 'Support' : 'AI';
  return (
    <div className={`max-w-[85%] sm:max-w-[75%] ${cls} px-3.5 py-2 animate-fade-in`}>
      <div className={`text-[10px] mb-0.5 ${isCustomer ? 'text-white/70' : 'text-slate-400'}`}>{senderLabel} • {t}</div>
      <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>
    </div>
  );
}
