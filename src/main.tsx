import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { useSettings, applyAccent } from './store/settings';
import './index.css';

applyAccent(useSettings.getState().accentColor);
useSettings.subscribe((s) => applyAccent(s.accentColor));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
