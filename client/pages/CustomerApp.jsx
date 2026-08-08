import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { getCustomerSocket, resetCustomerSocket } from '../lib/socket.js';
import ChatWindow from '../components/ChatWindow.jsx';
import CallWidget from '../components/CallWidget.jsx';
import { DEFAULT_ICE_SERVERS } from '../lib/webrtc.js';

const SESSION_KEY = 'esk_customer_session';
const CUSTOMER_KEY = 'esk_customer';

function loadStored() {
  try {
    const token = localStorage.getItem(SESSION_KEY);
    const rawCustomer = localStorage.getItem(CUSTOMER_KEY);
    const customer = rawCustomer ? JSON.parse(rawCustomer) : null;
    if (!token || !customer?.conversationId) return { customerToken: '', customer: null };
    return { customerToken: token, customer };
  } catch {
    return { customerToken: '', customer: null };
  }
}

export default function CustomerApp() {
  const [name, setName] = useState('');
  const [requirement, setRequirement] = useState('');
  const [session, setSession] = useState(() => loadStored());
  const [started, setStarted] = useState(!!loadStored().customer);
  const [status, setStatus] = useState('AI_ACTIVE');
  const [agentName, setAgentName] = useState(null);
  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState('');
  const [callInfo, setCallInfo] = useState(null); // { callId, state, position }
  const [iceServers, setIceServers] = useState(DEFAULT_ICE_SERVERS);
  const socketRef = useRef(null);

  // Bind socket when chat starts
  useEffect(() => {
    if (!started || !session.customer) return;
    const sock = getCustomerSocket({ token: session.customerToken });
    socketRef.current = sock;
    sock.emit('customer:bind', {
      conversationId: session.customer.conversationId,
    });

    sock.on('conversation:messages', (msgs) => setMessages(msgs));
    sock.on('conversation:status', ({ status: s, agentName: a }) => { setStatus(s); if (a) setAgentName(a); });
    sock.on('ai:typing', (v) => setTyping(!!v));
    sock.on('webrtc:config', ({ iceServers: configured }) => {
      if (Array.isArray(configured) && configured.length) setIceServers(configured);
    });

    sock.on('call:ringing', ({ callId }) => {
      setCallInfo({ callId, state: 'ringing' });
      notifyBrowser('Connecting call…', 'Calling support, please hold.');
    });
    sock.on('call:queued', ({ callId, position }) => setCallInfo({ callId, state: 'queued', position }));
    sock.on('call:accepted', ({ callId, agentSocketId }) => {
      setCallInfo(ci => ({ ...(ci || { callId }), state: 'connecting', peerSocketId: agentSocketId }));
    });
    sock.on('call:rejected', ({ reason }) => {
      setCallInfo(null);
      setMessages(m => [...m, { id: 'sys'+Date.now(), senderType: 'SYSTEM', message: reason ? `Call was rejected: ${reason}` : 'Support is unavailable right now. Please try again shortly.' , timestamp: Date.now() }]);
    });
    sock.on('call:cancelled', () => setCallInfo(null));
    sock.on('call:ended', ({ duration, reason }) => {
      setCallInfo(null);
      setMessages(m => [...m, { id: 'sys'+Date.now(), senderType: 'SYSTEM', message: `Call ended (${formatDuration(duration)}).`, timestamp: Date.now() }]);
    });
    sock.on('call:error', ({ message }) => {
      setMessages(m => [...m, { id: 'sys'+Date.now(), senderType: 'SYSTEM', message: message || 'Call error.', timestamp: Date.now() }]);
    });

    return () => {
      sock.off('conversation:messages');
      sock.off('conversation:status');
      sock.off('ai:typing');
      sock.off('webrtc:config');
      sock.off('call:ringing');
      sock.off('call:queued');
      sock.off('call:accepted');
      sock.off('call:rejected');
      sock.off('call:cancelled');
      sock.off('call:ended');
      sock.off('call:error');
    };
  }, [started, session.customer?.conversationId]);

  async function startChat(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/api/customer/start', {
        name: name.trim(),
        requirement: requirement.trim(),
        customerToken: session.customerToken || undefined,
      });
      localStorage.setItem(SESSION_KEY, res.customerToken);
      localStorage.setItem(CUSTOMER_KEY, JSON.stringify({
        conversationId: res.conversationId,
        name: res.customerName || name.trim(),
      }));
      setSession({
        customerToken: res.customerToken,
        customer: { conversationId: res.conversationId, name: res.customerName || name.trim() },
      });
      setStarted(true);
      setStatus(res.status);
    } catch (e) {
      setError(e.message);
    }
  }

  function sendMessage(text) {
    const sock = socketRef.current;
    if (!sock || !session.customer) return;
    sock.emit('customer:message', {
      conversationId: session.customer.conversationId,
      message: text,
    });
  }

  function startCall() {
    const sock = socketRef.current;
    if (!sock || !session.customer) return;
    sock.emit('call:request', { conversationId: session.customer.conversationId });
    setCallInfo({ state: 'requesting' });
  }

  function cancelCall() {
    const sock = socketRef.current;
    if (!sock) return;
    sock.emit('call:cancel');
    setCallInfo(null);
  }

  function hangupCall() {
    const sock = socketRef.current;
    if (!sock || !callInfo?.callId) return;
    sock.emit('call:hangup', { callId: callInfo.callId });
    setCallInfo(null);
  }

  function failCall(reason) {
    const sock = socketRef.current;
    if (!sock || !callInfo?.callId) return;
    sock.emit('call:failed', { callId: callInfo.callId, reason });
  }

  function resetSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CUSTOMER_KEY);
    resetCustomerSocket();
    setStarted(false);
    setName('');
    setRequirement('');
    setMessages([]);
    setStatus('AI_ACTIVE');
    setAgentName(null);
    setSession({ customerToken: '', customer: null });
    setCallInfo(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header onReset={started ? resetSession : null} />
      {!started ? (
        <IntroForm name={name} setName={setName} requirement={requirement} setRequirement={setRequirement} onSubmit={startChat} error={error} />
      ) : (
        <main className="flex-1 w-full max-w-3xl mx-auto flex flex-col px-3 sm:px-4 pb-4 pt-2">
          <StatusBar status={status} agentName={agentName} />
          <ChatWindow messages={messages} typing={typing} onSend={sendMessage}>
            <CallWidget
              callInfo={callInfo}
              onStartCall={startCall}
              onCancel={cancelCall}
              onHangup={hangupCall}
              onFailure={failCall}
              socket={socketRef.current}
              peerSocketId={callInfo?.peerSocketId}
              iceServers={iceServers}
            />
          </ChatWindow>
        </main>
      )}
      <Footer />
    </div>
  );
}

function notifyBrowser(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body }); } catch {}
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().catch(() => {});
  }
}

function Header({ onReset }) {
  return (
    <header className="sticky top-0 z-20 bg-gradient-to-r from-brand-950 to-brand-700 text-white shadow-md">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>
          </div>
          <div>
            <div className="font-bold leading-tight">Electricalskart</div>
            <div className="text-[11px] text-white/75 leading-tight">Customer Support</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="/login" className="text-xs text-white/80 hover:text-white underline">Agent login</a>
          {onReset && <button onClick={onReset} className="text-xs text-white/80 hover:text-white">New chat</button>}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="text-center text-xs text-slate-400 py-3">
      © {new Date().getFullYear()} Electricalskart • Browser-powered support — no phone required.
    </footer>
  );
}

function IntroForm({ name, setName, requirement, setRequirement, onSubmit, error }) {
  return (
    <main className="flex-1 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-slate-900">Welcome to Electricalskart Support</h1>
        <p className="text-slate-500 mt-1 text-sm">Chat with our AI assistant, or connect with a human for personalised help.</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Your name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none"
              placeholder="Hardik"
              required
              maxLength={80}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">How can we help you?</label>
            <textarea
              value={requirement}
              onChange={e => setRequirement(e.target.value)}
              rows={3}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none resize-none"
              placeholder="I need an RO water purifier."
              required
              maxLength={500}
            />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" className="w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold shadow-sm">
            Start chatting
          </button>
          <p className="text-[11px] text-slate-400 text-center">No account required. We may use AI to assist you, and a human can join at any time.</p>
        </form>
      </div>
    </main>
  );
}

function StatusBar({ status, agentName }) {
  const info = useMemo(() => {
    switch (status) {
      case 'AI_ACTIVE': return { color: 'bg-sky-500', label: 'AI Assistant online' };
      case 'HUMAN_REQUIRED': return { color: 'bg-amber-500', label: 'Connecting to a support agent…' };
      case 'HUMAN_ACTIVE': return { color: 'bg-emerald-500', label: agentName ? `${agentName} is here to help` : 'Support agent online' };
      case 'WAITING_CALL': return { color: 'bg-indigo-500', label: 'Waiting for call to connect…' };
      case 'IN_CALL': return { color: 'bg-rose-500', label: 'On call with support' };
      case 'CLOSED': return { color: 'bg-slate-400', label: 'Conversation ended' };
      default: return { color: 'bg-slate-400', label: status };
    }
  }, [status, agentName]);
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-slate-600">
      <span className={`dot ${info.color}`} />
      <span>{info.label}</span>
    </div>
  );
}

function formatDuration(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
