import React, { useEffect, useRef, useState } from 'react';

/**
 * Customer-side call widget. WebRTC peer-to-peer audio with the dashboard agent.
 * Signaling goes through the Socket.IO connection (server relays messages).
 */
export default function CallWidget({ callInfo, onStartCall, onCancel, onHangup, socket, peerSocketId }) {
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [inCall, setInCall] = useState(false);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const makingOfferRef = useRef(false);

  const state = callInfo?.state || 'idle';

  // Attach signaling handler
  useEffect(() => {
    if (!socket) return;
    const onSignal = async ({ from, signal }) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('webrtc:signal', { to: from, signal: pc.localDescription });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal));
        } else if (signal.renegotiate) {
          // polite answerer; ignore
        }
      } catch (e) {
        console.warn('[webrtc customer] signal error', e);
      }
    };
    socket.on('webrtc:signal', onSignal);
    return () => socket.off('webrtc:signal', onSignal);
  }, [socket]);

  // Start/stop WebRTC when entering connecting state
  useEffect(() => {
    if (state === 'connecting' && peerSocketId) {
      startWebRTC(peerSocketId).catch(err => {
        setError(err.message || 'Could not start call');
        onHangup();
      });
    }
    if (state === 'idle') {
      cleanup();
    }
    return () => {
      if (state === 'idle') cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, peerSocketId]);

  async function startWebRTC(peerId) {
    if (!socket) return;
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
      if (audioRef.current && ev.streams && ev.streams[0]) {
        audioRef.current.srcObject = ev.streams[0];
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socket.emit('webrtc:signal', { to: peerId, signal: { candidate: ev.candidate.toJSON(), type: 'candidate' } });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        setInCall(true);
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
      }
      if (['failed', 'disconnected', 'closed'].includes(s)) {
        // Don't auto hangup on 'disconnected' — allow recovery
        if (s === 'failed') onHangup();
      }
    };
    pc.onnegotiationneeded = async () => {
      // The agent (offerer) initiates negotiation; customer stays polite.
    };
  }

  function cleanup() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setDuration(0); setInCall(false);
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    setMuted(false);
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const newMuted = !muted;
    localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = !newMuted));
    setMuted(newMuted);
  }

  if (state === 'idle' || !callInfo) {
    return (
      <div className="px-3 pb-3 pt-1 flex items-center gap-2 border-t border-slate-100">
        <button
          onClick={onStartCall}
          className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm"
        >
          <span className="text-lg">📞</span> Talk to Support (Call Now)
        </button>
      </div>
    );
  }

  let title = '';
  switch (state) {
    case 'requesting': title = 'Requesting call…'; break;
    case 'ringing': title = 'Calling support…'; break;
    case 'queued': title = `Waiting in queue (position ${callInfo.position})`; break;
    case 'connecting': title = 'Connecting…'; break;
    default: title = inCall ? `Connected — ${fmtDur(duration)}` : 'Call in progress';
  }

  return (
    <div className="px-3 pb-3 pt-3 border-t border-slate-100">
      <audio ref={audioRef} autoPlay playsInline />
      <div className={`rounded-xl p-3 ${inCall ? 'bg-emerald-50 border border-emerald-200' : 'bg-amber-50 border border-amber-200'}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`text-2xl ${state === 'ringing' || state === 'requesting' ? 'ring-pulse' : ''}`}>📞</span>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-slate-800 truncate">{title}</div>
              <div className="text-xs text-slate-500">Free browser call. No phone number needed.</div>
              {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {inCall && (
              <button onClick={toggleMute} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm font-medium">
                {muted ? 'Unmute' : 'Mute'}
              </button>
            )}
            {(state === 'requesting' || state === 'queued' || state === 'ringing') ? (
              <button onClick={onCancel} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm font-medium">Cancel</button>
            ) : (
              <button onClick={() => { cleanup(); onHangup(); }} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium">End</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtDur(s) {
  const m = Math.floor(s / 60); const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
