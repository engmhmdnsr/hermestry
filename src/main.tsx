import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { HermesProvider } from './context/HermesContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HermesProvider>
      <App />
    </HermesProvider>
  </React.StrictMode>
);
