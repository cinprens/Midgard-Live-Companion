import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {restoreLanguage} from './i18n/language';
import './styles.css';
import './live.css';
import './live-redesign.css';
import './assistant.css';
import './expansion.css';
import './ragnarok-theme.css';
import './panel-theme.css';
import './ragnarok-dark.css';
import './panel-dark.css';
import './taskbar-panels.css';
import './taskbar-theme.css';
void restoreLanguage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
