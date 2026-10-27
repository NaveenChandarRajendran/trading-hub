import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AuthGate } from './shared/auth/AuthGate';
import { ThemeProvider } from './shared/theme';
import App from './App';
import './shared/tokens.css';
import './shared/ui/ui.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <HashRouter>
        <AuthGate>
          <App />
        </AuthGate>
      </HashRouter>
    </ThemeProvider>
  </StrictMode>,
);
