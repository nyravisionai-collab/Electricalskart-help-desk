import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getAgentSocket, resetAgentSocket } from '../lib/socket.js';
import { clearAuth, getUser } from '../lib/auth.js';
import Overview from '../components/dashboard/Overview.jsx';
import LiveChat from '../components/dashboard/LiveChat.jsx';
import CallCenter from '../components/dashboard/CallCenter.jsx';
import Customers from '../components/dashboard/Customers.jsx';
import History from '../components/dashboard/History.jsx';

export default function Dashboard({ onLogout }) {
  const navigate = useNavigate();
  const [socket, setSocket] = useState(null);
  const [summary, setSummary] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [queue, setQueue] = useState([]);
  const [activeCall, setActiveCall] = useState(null);
  const [agentsOnline, setAgentsOnline] = useState([]);
  const [user] = useState(getUser());
  const incomingRef = useRef(null);
  const callSoundRef = useRef(null);

  useEffect(() => {
    const sock = getAgentSocket();
    setSocket(sock);

    sock.on('connect', () => {});
    sock.on('auth:ok', () => {
      api.get('/api/dashboard/summary').then(setSummary).catch(() => {});
    });
    sock.on('dashboard:update', (s) => setSummary(s));
    sock.on('agents:presence', (list) => setAgentsOnline(list));
    sock.on('call:incoming', (info) => {
      setIncomingCall(info);
      incomingRef.current = info;
      try {
        if (callSoundRef.current) { callSoundRef.current.currentTime = 0; callSoundRef.current.play().catch(() => {}); }
      } catch {}
      notify('Incoming call', `${info.customer?.name || 'Customer'} is calling`);
    });
    sock.on('call:queued', () => {
      // rely on dashboard update for queue
    });
    sock.on('call:queue_update', (q) => setQueue(q));
    sock.on('call:accepted', ({ callId, customerSocketId }) => {
      if (incomingRef.current?.callId === callId) {
        setActiveCall({ callId, peerSocketId: customerSocketId });
        setIncomingCall(null);
        incomingRef.current = null;
      }
    });
    sock.on('call:rejected', () => { setIncomingCall(null); incomingRef.current = null; });
    sock.on('call:ended', () => {
      setActiveCall(null);
      setIncomingCall(null);
      incomingRef.current = null;
    });
    sock.on('alert:human_required', (info) => {
      notify('Human support needed', `${info.customer?.name || 'A customer'} needs an agent`);
    });

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    return () => {
      sock.off('dashboard:update');
      sock.off('call:incoming');
      sock.off('call:queue_update');
      sock.off('call:accepted');
      sock.off('call:rejected');
      sock.off('call:ended');
      sock.off('agents:presence');
      sock.off('alert:human_required');
    };
  }, []);

  function acceptCall() {
    if (!incomingCall || !socket) return;
    socket.emit('call:accept', { callId: incomingCall.callId });
  }
  function rejectCall() {
    if (!incomingCall || !socket) return;
    socket.emit('call:reject', { callId: incomingCall.callId });
    setIncomingCall(null);
  }
  function hangupCall() {
    if (!activeCall || !socket) return;
    socket.emit('call:hangup', { callId: activeCall.callId });
  }

  function logout() {
    resetAgentSocket();
    clearAuth();
    onLogout?.();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-slate-100 flex">
      {/* Sidebar */}
      <aside className="w-60 bg-brand-950 text-white flex flex-col hidden md:flex">
        <div className="p-4 flex items-center gap-2 border-b border-white/10">
          <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center font-bold">E</div>
          <div>
            <div className="font-bold leading-tight">Electricalskart</div>
            <div className="text-[11px] text-white/60">Support Call Center</div>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1 text-sm">
          <NavItem to="/dashboard" end label="📊 Dashboard" />
          <NavItem to="/dashboard/chat" label="💬 Live Chat" badge={summary?.human_required ? summary.human_required : null} />
          <NavItem to="/dashboard/calls" label="📞 Call Center" badge={(incomingCall ? 1 : 0) + (queue?.length || 0) || null} />
          <NavItem to="/dashboard/customers" label="👥 Customers" />
          <NavItem to="/dashboard/history" label="🕓 History" />
        </nav>
        <div className="p-3 border-t border-white/10">
          <div className="text-xs text-white/60">Signed in as</div>
          <div className="text-sm font-semibold truncate">{user?.name || 'Agent'}</div>
          <div className="text-[11px] text-white/50 capitalize">{user?.role}</div>
          <button onClick={logout} className="mt-2 w-full text-xs py-1.5 rounded bg-white/10 hover:bg-white/20">Sign out</button>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 bg-brand-950 text-white z-30 flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center font-bold">E</div>
          <div className="font-semibold">Support</div>
        </div>
        <button onClick={logout} className="text-xs">Sign out</button>
      </div>
      <div className="md:hidden h-12" />

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="md:hidden bg-white border-b border-slate-200 px-2 py-1 flex gap-1 overflow-x-auto text-sm">
          <NavItem to="/dashboard" end label="📊" />
          <NavItem to="/dashboard/chat" label="💬" />
          <NavItem to="/dashboard/calls" label="📞" />
          <NavItem to="/dashboard/customers" label="👥" />
          <NavItem to="/dashboard/history" label="🕓" />
        </div>
        <div className="flex-1 overflow-y-auto p-3 sm:p-6 scrollbar-thin">
          <Routes>
            <Route index element={<Overview summary={summary} agentsOnline={agentsOnline} />} />
            <Route path="chat" element={<LiveChat socket={socket} />} />
            <Route path="calls" element={<CallCenter socket={socket} summary={summary} queue={queue} activeCall={activeCall} incomingCall={incomingCall} />} />
            <Route path="customers" element={<Customers />} />
            <Route path="history" element={<History />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
      </main>

      {/* Incoming call modal */}
      {incomingCall && (
        <IncomingCallModal call={incomingCall} onAccept={acceptCall} onReject={rejectCall} />
      )}

      {/* Active call overlay */}
      {activeCall && (
        <ActiveCallPanel socket={socket} call={activeCall} incomingCall={incomingCall} onHangup={hangupCall} setActiveCall={setActiveCall} />
      )}

      <audio ref={callSoundRef} src="data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YTAAAAAA" preload="auto" />
    </div>
  );
}

function NavItem({ to, end, label, badge }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center justify-between px-3 py-2 rounded-lg transition ${isActive ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/5 hover:text-white'}`
      }
    >
      <span>{label}</span>
      {badge ? <span className="bg-rose-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">{badge}</span> : null}
    </NavLink>
  );
}

function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { try { new Notification(title, { body }); } catch {} }
}

function IncomingCallModal({ call, onAccept, onReject }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 ring-pulse">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-2xl">📞</div>
          <div>
            <div className="font-bold text-lg">Incoming Customer Call</div>
            <div className="text-slate-500 text-sm">{call.customer?.name || 'Customer'} — {call.customer?.requirement || 'Support request'}</div>
          </div>
        </div>
        <div className="mt-4 max-h-48 overflow-y-auto text-sm space-y-1 bg-slate-50 rounded-lg p-3 border border-slate-200 scrollbar-thin">
          {(call.messages || []).slice(-10).map(m => (
            <div key={m.id} className={m.senderType === 'CUSTOMER' ? 'text-slate-800' : m.senderType === 'AI' ? 'text-slate-600 italic' : 'text-emerald-700'}>
              <span className="font-semibold">{m.senderType === 'CUSTOMER' ? call.customer?.name || 'Customer' : m.senderType === 'AI' ? 'AI' : 'Agent'}:</span> {m.message}
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={onReject} className="flex-1 py-2.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold">Reject</button>
          <button onClick={onAccept} className="flex-1 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">Accept</button>
        </div>
      </div>
    </div>
  );
}

function ActiveCallPanel({ socket, call, onHangup, setActiveCall }) {
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState('');
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    startCall().catch(e => setError(e.message));
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCall() {
    setError('');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    pcRef.current = pc;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = (ev) => {
      if (audioRef.current && ev.streams[0]) audioRef.current.srcObject = ev.streams[0];
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socket.emit('webrtc:signal', { to: call.peerSocketId, signal: { candidate: ev.candidate.toJSON(), type: 'candidate' } });
      }
    };
    pc.onconnectionstatechange = () => {
      setStatus(pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
      }
      if (['failed', 'closed'].includes(pc.connectionState)) {
        onHangup();
      }
    };

    // Signaling
    const onSignal = async ({ from, signal }) => {
      try {
        if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal));
        }
      } catch (e) {
        console.warn('[webrtc agent] signal err', e);
      }
    };
    socket.on('webrtc:signal', onSignal);

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:signal', { to: call.peerSocketId, signal: pc.localDescription });

    // Expose cleanup for socket off
    pcRef.current.__cleanupSignals = () => socket.off('webrtc:signal', onSignal);
  }

  function cleanup() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (pcRef.current) {
      try { pcRef.current.__cleanupSignals?.(); } catch {}
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    setActiveCall(null);
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const m = !muted;
    localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = !m));
    setMuted(m);
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 bg-white rounded-2xl shadow-2xl border border-emerald-200 p-4">
      <audio ref={audioRef} autoPlay playsInline />
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-emerald-500 text-white flex items-center justify-center text-xl">📞</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Active Call</div>
          <div className="text-xs text-slate-500">
            {status === 'connected' ? `Connected — ${fmtDur(duration)}` : status === 'connecting' || status === 'checking' ? 'Connecting…' : status}
          </div>
          {error && <div className="text-xs text-red-600 mt-0.5">{error}</div>}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={toggleMute} className="flex-1 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm font-medium">{muted ? 'Unmute' : 'Mute'}</button>
        <button onClick={() => { cleanup(); onHangup(); }} className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold">End call</button>
      </div>
    </div>
  );
}

function fmtDur(s) {
  const m = Math.floor(s / 60); const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
