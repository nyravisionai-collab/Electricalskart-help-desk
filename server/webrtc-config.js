const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

export function buildIceServers(environment = process.env) {
  const stunUrls = (environment.STUN_URLS || DEFAULT_STUN_URLS.join(','))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const iceServers = stunUrls.length ? [{ urls: stunUrls }] : [];

  const turnUrl = (environment.TURN_URL || '').trim();
  const turnUsername = environment.TURN_USERNAME || '';
  const turnCredential = environment.TURN_CREDENTIAL || '';
  if (turnUrl) {
    if (!turnUsername || !turnCredential) {
      throw new Error('TURN_USERNAME and TURN_CREDENTIAL are required when TURN_URL is configured.');
    }
    if (!/^turns?:/i.test(turnUrl)) {
      throw new Error('TURN_URL must start with turn: or turns:.');
    }
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  } else if (turnUsername || turnCredential) {
    throw new Error('TURN_URL is required when TURN credentials are configured.');
  }

  if (iceServers.length === 0) {
    throw new Error('At least one STUN or TURN server must be configured.');
  }
  return iceServers;
}
