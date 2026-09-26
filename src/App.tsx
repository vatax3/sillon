import { useEffect, useRef, useState } from 'react';
import AutomationsPage from './components/Automations';
import Builder from './components/Builder';
import Dashboard from './components/Dashboard';
import Discover from './components/Discover';
import Friends from './components/Friends';
import History from './components/History';
import MyPlaylists from './components/MyPlaylists';
import PlayerBar from './components/PlayerBar';
import SettingsPage from './components/SettingsPage';
import Suggestions from './components/Suggestions';
import TaskBar from './components/TaskBar';
import Tidy from './components/Tidy';
import { SubTabs } from './components/ui';
import Welcome from './components/Welcome';
import { handleCallback, isLoggedIn, login } from './lib/auth';
import { serverLogin, type ServerConfig } from './lib/remote';
import type { Rule } from './lib/types';
import { StoreProvider, useStore } from './store';

type Tab = 'dashboard' | 'history' | 'playlists' | 'discover' | 'tidy' | 'friends' | 'auto' | 'settings';
type PlaylistView = 'suggestions' | 'builder' | 'mine';

const TABS: { id: Tab; label: string; serverOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Analyse' },
  { id: 'history', label: 'Écoutes' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'discover', label: 'Découvrir' },
  { id: 'tidy', label: 'Ranger' },
  { id: 'friends', label: 'Amis' },
  { id: 'auto', label: 'Automatisations', serverOnly: true },
  { id: 'settings', label: 'Réglages' },
];

export default function App({ server }: { server: ServerConfig | null }) {
  const [loggedIn, setLoggedIn] = useState(() => (server ? !!server.user : isLoggedIn()));
  const [authError, setAuthError] = useState<string | null>(() => new URLSearchParams(location.search).get('authError'));
  const handled = useRef(false);

  useEffect(() => {
    if (authError) history.replaceState(null, '', location.pathname);
    // Mode serveur : c'est le serveur qui reçoit le retour OAuth.
    // StrictMode monte deux fois en dev : un code OAuth ne s'échange qu'une fois.
    if (server || handled.current) return;
    handled.current = true;
    handleCallback()
      .then((ok) => ok && setLoggedIn(true))
      .catch((e: Error) => setAuthError(e.message));
  }, []);

  if (!loggedIn) return <Welcome error={authError} server={server} />;
  return (
    <StoreProvider server={server} onLogout={() => setLoggedIn(false)}>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [playlistView, setPlaylistView] = useState<PlaylistView>('suggestions');
  const [draft, setDraft] = useState<Rule | null>(null);
  const autoSynced = useRef(false);

  // Premier lancement : on synchronise directement.
  useEffect(() => {
    if (store.ready && !store.library && !autoSynced.current) {
      autoSynced.current = true;
      void store.sync();
    }
  }, [store.ready, store.library]);

  useEffect(() => {
    if (store.editRequest) {
      setTab('playlists');
      setPlaylistView('mine');
    }
  }, [store.editRequest?.nonce]);

  const openInBuilder = (rule: Rule) => {
    setDraft(rule);
    setTab('playlists');
    setPlaylistView('builder');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden />
          Sillon
        </div>
        <nav className="tabs" role="tablist">
          {TABS.filter((t) => !t.serverOnly || store.server).map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
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

      {store.needsReauth && (
        <div className="banner" role="status">
          <span>Sillon a de nouvelles fonctions (liker, suivre, lecteur) qui demandent une autorisation supplémentaire.</span>
          <button className="primary small" onClick={() => (store.server ? serverLogin() : login())}>
            Reconnecter Spotify
          </button>
        </div>
      )}

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
        ) : tab === 'settings' ? (
          <SettingsPage />
        ) : tab === 'auto' ? (
          <AutomationsPage />
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
            {tab === 'history' && <History />}
            {tab === 'playlists' && (
              <>
                <SubTabs
                  tabs={[
                    { id: 'suggestions', label: 'Suggestions' },
                    { id: 'builder', label: 'Créateur' },
                    { id: 'mine', label: 'Mes playlists', badge: store.saved.length },
                  ]}
                  value={playlistView}
                  onChange={setPlaylistView}
                />
                {playlistView === 'suggestions' && <Suggestions onCustomize={openInBuilder} />}
                {playlistView === 'builder' && <Builder initialRule={draft} key={draft?.seed ?? 'new'} />}
                {playlistView === 'mine' && <MyPlaylists onEdit={openInBuilder} />}
              </>
            )}
            {tab === 'discover' && <Discover />}
            {tab === 'tidy' && <Tidy />}
            {tab === 'friends' && <Friends />}
          </>
        )}
      </main>
      <PlayerBar />
    </div>
  );
}
