import { io } from 'socket.io-client';
import { getToken } from './auth.js';

let customerSocket = null;
let agentSocket = null;

export function getCustomerSocket(auth = {}) {
  if (customerSocket) return customerSocket;
  customerSocket = io({
    path: '/socket.io',
    auth: { role: 'customer', ...auth },
    transports: ['websocket', 'polling'],
  });
  return customerSocket;
}

export function resetCustomerSocket() {
  if (customerSocket) { customerSocket.disconnect(); customerSocket = null; }
}

export function getAgentSocket() {
  if (agentSocket) return agentSocket;
  agentSocket = io({
    path: '/socket.io',
    auth: { role: 'agent', token: getToken() || '' },
    transports: ['websocket', 'polling'],
  });
  return agentSocket;
}

export function resetAgentSocket() {
  if (agentSocket) { agentSocket.disconnect(); agentSocket = null; }
}
