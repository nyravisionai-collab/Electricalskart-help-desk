export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * ICE can arrive before an SDP offer/answer has set remoteDescription.
 * Buffer those candidates and flush them in order once the description exists.
 */
export function createIceCandidateBuffer(peerConnection) {
  const pending = [];

  async function add(candidate) {
    if (!candidate) return;
    if (!peerConnection.remoteDescription?.type) {
      pending.push(candidate);
      return;
    }
    await peerConnection.addIceCandidate(candidate);
  }

  async function flush() {
    if (!peerConnection.remoteDescription?.type) return;
    while (pending.length) {
      const candidate = pending.shift();
      await peerConnection.addIceCandidate(candidate);
    }
  }

  function clear() {
    pending.length = 0;
  }

  return {
    add,
    flush,
    clear,
    get size() { return pending.length; },
  };
}

export function safeIceServers(iceServers) {
  return Array.isArray(iceServers) && iceServers.length ? iceServers : DEFAULT_ICE_SERVERS;
}
