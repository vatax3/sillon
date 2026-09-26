import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getAccessToken } from './lib/auth';
import { detectServer, serverToken } from './lib/remote';
import { setTokenSource } from './lib/spotify';
import './styles.css';

// Mode serveur (auto-hébergé) si /api/config répond ; sinon tout se passe dans le navigateur.
detectServer().then((server) => {
  setTokenSource(server ? serverToken : getAccessToken);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App server={server} />
    </StrictMode>,
  );
});
