import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIceCandidateBuffer, safeIceServers } from '../client/lib/webrtc.js';
import { buildIceServers } from '../server/webrtc-config.js';

test('ICE candidates are buffered until remoteDescription is set and flushed in order', async () => {
  const added = [];
  const peerConnection = {
    remoteDescription: null,
    async addIceCandidate(candidate) { added.push(candidate); },
  };
  const buffer = createIceCandidateBuffer(peerConnection);
  const first = { candidate: 'candidate:first' };
  const second = { candidate: 'candidate:second' };
  await buffer.add(first);
  await buffer.add(second);
  assert.equal(buffer.size, 2);
  assert.deepEqual(added, []);

  peerConnection.remoteDescription = { type: 'offer' };
  await buffer.flush();
  assert.equal(buffer.size, 0);
  assert.deepEqual(added, [first, second]);

  const third = { candidate: 'candidate:third' };
  await buffer.add(third);
  assert.deepEqual(added, [first, second, third]);
});

test('TURN configuration is environment-driven and never hard-coded', () => {
  const configured = buildIceServers({
    STUN_URLS: 'stun:one.example.test:3478,stun:two.example.test:3478',
    TURN_URL: 'turns:turn.example.test:5349',
    TURN_USERNAME: 'temporary-user',
    TURN_CREDENTIAL: 'temporary-credential',
  });
  assert.deepEqual(configured, [
    { urls: ['stun:one.example.test:3478', 'stun:two.example.test:3478'] },
    {
      urls: 'turns:turn.example.test:5349',
      username: 'temporary-user',
      credential: 'temporary-credential',
    },
  ]);
  assert.throws(
    () => buildIceServers({ TURN_URL: 'turn:turn.example.test:3478' }),
    /TURN_USERNAME and TURN_CREDENTIAL are required/,
  );
  assert.ok(safeIceServers([]).length > 0);
});
