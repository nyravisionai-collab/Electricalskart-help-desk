import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import CustomerApp from './pages/CustomerApp.jsx';
import LoginPage from './pages/LoginPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { getToken, getUser, clearAuth, clearPrivateCaches } from './lib/auth.js';

function ProtectedRoute({ children }) {
  const token = getToken();
  const user = getUser();
  if (!token || !user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [, setTick] = useState(0);
  useEffect(() => {
    // Remove private API caches created by pre-M9 service workers.
    void clearPrivateCaches();
    // Ensure PWA service worker is registered
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  }, []);
  return (
    <Routes>
      <Route path="/" element={<CustomerApp />} />
      <Route path="/login" element={<LoginPage onLoggedIn={() => setTick(t => t + 1)} />} />
      <Route
        path="/dashboard/*"
        element={
          <ProtectedRoute>
            <Dashboard onLogout={() => { clearAuth(); window.location.href = '/login'; }} />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
