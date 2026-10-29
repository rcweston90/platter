import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './global.css';

createRoot(document.getElementById('platter')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
