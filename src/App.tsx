import { useEffect, useRef, useState } from 'react';
import Builder from './components/Builder';
import Dashboard from './components/Dashboard';
import MyPlaylists from './components/MyPlaylists';
import SettingsPage from './components/SettingsPage';
import Suggestions from './components/Suggestions';
import TaskBar from './components/TaskBar';
import Welcome from './components/Welcome';
import { handleCallback, isLoggedIn } from './lib/auth';
import type { Rule } from './lib/types';
import { StoreProvider, useStore } from './store';

type Tab = 'dashboard' | 'suggestions' | 'builder' | 'mine' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Analyse' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'builder', label: 'Créateur' },
  { id: 'mine', label: 'Mes playlists' },
  { id: 'settings', label: 'Réglages' },
];

export default function App() {
  const [loggedIn, setLoggedIn] = useState(isLoggedIn);
  const [authError, setAuthError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    // StrictMode monte deux fois en dev : un code OAuth ne s'échange qu'une fois.
    if (handled.current) return;
    handled.current = true;
    handleCallback()
      .then((ok) => ok && setLoggedIn(true))
      .catch((e: Error) => setAuthError(e.message));
  }, []);

  if (!loggedIn) return <Welcome error={authError} />;
  return (
    <StoreProvider onLogout={() => setLoggedIn(false)}>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [draft, setDraft] = useState<Rule | null>(null);
  const autoSynced = useRef(false);

  // Premier lancement : on synchronise directement.
  useEffect(() => {
    if (store.ready && !store.library && !autoSynced.current) {
      autoSynced.current = true;
      void store.sync();
    }
  }, [store.ready, store.library]);

  const openInBuilder = (rule: Rule) => {
    setDraft(rule);
    setTab('builder');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden />
          Sillon
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'mine' && store.saved.length > 0 && <span className="count">{store.saved.length}</span>}
            </button>
          ))}
        </nav>
        {store.library && (
          <div className="user">
            {store.library.user.image && <img src={store.library.user.image} alt="" />}
            <span>{store.library.user.name}</span>
          </div>
        )}
      </header>

      <TaskBar />

      {(store.error || store.notice) && (
        <div className={store.error ? 'banner error' : 'banner'} role="status">
          <span>{store.error ?? store.notice}</span>
          <button className="ghost small" onClick={store.dismiss} aria-label="Fermer">
            ✕
          </button>
        </div>
      )}

      <main className="content">
        {!store.ready ? (
          <p className="muted">Chargement…</p>
        ) : !store.library || !store.index ? (
          <div className="empty">
            <h2>Aucune bibliothèque chargée</h2>
            <p className="muted">La synchronisation récupère tes titres likés, tes playlists, tes tops et tes écoutes récentes.</p>
            {!store.task && (
              <button className="primary" onClick={store.sync}>
                Synchroniser ma bibliothèque
              </button>
            )}
          </div>
        ) : (
          <>
            {tab === 'dashboard' && <Dashboard onOpenRule={openInBuilder} />}
            {tab === 'suggestions' && <Suggestions onCustomize={openInBuilder} />}
            {tab === 'builder' && <Builder initialRule={draft} key={draft?.seed ?? 'new'} />}
            {tab === 'mine' && <MyPlaylists onEdit={openInBuilder} />}
            {tab === 'settings' && <SettingsPage />}
          </>
        )}
      </main>
    </div>
  );
}
