import React, { useEffect, useRef, useState } from 'react';
import { createIceCandidateBuffer, safeIceServers } from '../lib/webrtc.js';

/** Customer-side WebRTC audio. The authenticated Socket.IO channel carries SDP/ICE only. */
export default function CallWidget({
  callInfo,
  onStartCall,
  onCancel,
  onHangup,
  onFailure,
  socket,
  peerSocketId,
  iceServers,
}) {
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [inCall, setInCall] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const disconnectTimerRef = useRef(null);
  const processSignalRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const failedRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const generationRef = useRef(0);

  const state = callInfo?.state || 'idle';

  useEffect(() => {
    if (!socket) return undefined;
    const onSignal = async event => {
      try {
        if (processSignalRef.current) await processSignalRef.current(event);
        else pendingSignalsRef.current.push(event);
      } catch (signalError) {
        reportFailure('signaling_failed', signalError);
      }
    };
    socket.on('webrtc:signal', onSignal);
    return () => socket.off('webrtc:signal', onSignal);
    // reportFailure intentionally reads the current call props through this render's listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    if (state === 'connecting' && peerSocketId && !pcRef.current) {
      failedRef.current = false;
      intentionalCloseRef.current = false;
      startWebRTC(peerSocketId).catch(startError => {
        const reason = startError?.name === 'NotAllowedError' ? 'microphone_permission' : 'setup_failed';
        reportFailure(reason, startError);
      });
    } else if (state === 'idle') {
      cleanup(true);
    }
    // WebRTC setup is keyed only by the server-owned call state and peer id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, peerSocketId]);

  useEffect(() => () => cleanup(true), []);

  async function startWebRTC(peerId) {
    if (!socket || pcRef.current) return;
    setError('');
    setConnectionState('connecting');
    const generation = ++generationRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (generation !== generationRef.current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: safeIceServers(iceServers) });
    pcRef.current = pc;
    const candidateBuffer = createIceCandidateBuffer(pc);
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.ontrack = event => {
      if (audioRef.current && event.streams?.[0]) audioRef.current.srcObject = event.streams[0];
    };
    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('webrtc:signal', {
          to: peerId,
          signal: { candidate: event.candidate.toJSON(), type: 'candidate' },
        });
      }
    };
    pc.onconnectionstatechange = () => handleConnectionState(pc.connectionState);

    processSignalRef.current = async ({ from, signal }) => {
      if (from !== peerId || pc.signalingState === 'closed') return;
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(signal);
        await candidateBuffer.flush();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:signal', { to: from, signal: pc.localDescription });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(signal);
        await candidateBuffer.flush();
      } else if (signal.type === 'candidate' && signal.candidate) {
        await candidateBuffer.add(signal.candidate);
      }
    };
    pcRef.current.__candidateBuffer = candidateBuffer;

    const earlySignals = pendingSignalsRef.current.splice(0);
    for (const signal of earlySignals) await processSignalRef.current(signal);
  }

  function handleConnectionState(nextState) {
    setConnectionState(nextState);
    if (nextState === 'connected') {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
      setInCall(true);
      if (!timerRef.current) timerRef.current = setInterval(() => setDuration(value => value + 1), 1000);
      return;
    }
    if (nextState === 'disconnected') {
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => reportFailure('connection_disconnected'), 8_000);
      }
      return;
    }
    if (nextState === 'failed') reportFailure('connection_failed');
    if (nextState === 'closed' && !intentionalCloseRef.current) reportFailure('connection_closed');
  }

  function reportFailure(reason, failure) {
    if (failedRef.current || intentionalCloseRef.current) return;
    failedRef.current = true;
    setError(failure?.message || 'The browser call could not be established.');
    cleanup(false);
    onFailure?.(reason);
  }

  function cleanup(intentional = true) {
    generationRef.current += 1;
    if (intentional) intentionalCloseRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    timerRef.current = null;
    disconnectTimerRef.current = null;
    processSignalRef.current = null;
    pendingSignalsRef.current.length = 0;
    setDuration(0);
    setInCall(false);
    setConnectionState('idle');
    if (pcRef.current) {
      pcRef.current.__candidateBuffer?.clear();
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    setMuted(false);
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const nextMuted = !muted;
    localStreamRef.current.getAudioTracks().forEach(track => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
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

  let title;
  if (inCall) title = `Connected — ${formatDuration(duration)}`;
  else if (state === 'requesting') title = 'Requesting call…';
  else if (state === 'ringing') title = 'Calling support…';
  else if (state === 'queued') title = `Waiting in queue (position ${callInfo.position})`;
  else title = connectionState === 'disconnected' ? 'Reconnecting…' : 'Connecting…';

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
            {['requesting', 'queued', 'ringing'].includes(state) ? (
              <button onClick={onCancel} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm font-medium">Cancel</button>
            ) : (
              <button onClick={() => { cleanup(true); onHangup(); }} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium">End</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
