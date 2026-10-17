// Development-only layout fixture. API permissions remain enforced by the server.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import Settings from '../../src/pages/Settings.js';
import '../../src/styles.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter>
  <p className="hint" style={{ padding: '8px 16px' }}>Settings layout verification · live read-only APIs · anonymous access</p>
  <Settings user={null} account={null} onChange={() => {}} />
</BrowserRouter>);
