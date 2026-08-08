import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setAuth } from '../lib/auth.js';

export default function LoginPage({ onLoggedIn }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const res = await api.post('/api/auth/login', { email, password });
      setAuth(res.token, res.user);
      onLoggedIn?.();
      navigate('/dashboard');
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-950 via-brand-800 to-brand-600 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-brand-600 flex items-center justify-center text-white text-xl font-bold">E</div>
          <div>
            <div className="text-lg font-bold text-slate-900">Electricalskart</div>
            <div className="text-xs text-slate-500">Support Call Center — Secure Login</div>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="staff-email" className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              id="staff-email"
              type="email"
              autoComplete="username"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="owner@electricalskart.local"
              required
            />
          </div>
          <div>
            <label htmlFor="staff-password" className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              id="staff-password"
              type="password"
              autoComplete="current-password"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="mt-6 text-xs text-slate-500 text-center">
          <Link to="/" className="text-brand-600 hover:underline">← Back to customer chat</Link>
        </div>
      </div>
    </div>
  );
}
