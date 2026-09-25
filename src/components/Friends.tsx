import { useMemo, useRef, useState } from 'react';
import { blend, buildTasteCard, compatibility, familyLabel, parseTasteCard, type TasteCard } from '../lib/social';
import { useStore } from '../store';
import { AsyncButton, BarChart } from './ui';

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Carte de goûts au format image (1080×1350, bon ratio pour les stories et les messageries). */
async function renderCardImage(card: TasteCard): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1d1a3a');
  bg.addColorStop(1, '#0e0e10');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const font = (size: number, weight = 400) => `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

  g.fillStyle = '#8f82f5';
  g.font = font(30, 600);
  g.fillText('SILLON · CARTE DE GOÛTS', 80, 110);
  g.fillStyle = '#ffffff';
  g.font = font(76, 700);
  g.fillText(card.name, 80, 200);
  g.fillStyle = '#c3c2b7';
  g.font = font(30);
  const bits = [`${card.stats.tracks.toLocaleString('fr-FR')} titres`, `${card.stats.artists.toLocaleString('fr-FR')} artistes`];
  if (card.stats.listeningHours) bits.push(`${card.stats.listeningHours.toLocaleString('fr-FR')} h d’écoute sur 12 mois`);
  g.fillText(bits.join(' · '), 80, 255);

  // Genres : barres horizontales.
  g.fillStyle = '#ffffff';
  g.font = font(34, 600);
  g.fillText('Genres', 80, 350);
  const fams = Object.entries(card.families).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxF = fams[0]?.[1] ?? 1;
  fams.forEach(([f, v], i) => {
    const y = 390 + i * 58;
    g.fillStyle = '#e8e6e1';
    g.font = font(28);
    g.fillText(familyLabel(f), 80, y + 26);
    g.fillStyle = '#3987e5';
    const w = (v / maxF) * 460;
    g.beginPath();
    g.roundRect(420, y + 4, w, 26, [0, 6, 6, 0]);
    g.fill();
    g.fillStyle = '#c3c2b7';
    g.fillText(`${Math.round(v * 100)}%`, 420 + w + 14, y + 26);
  });

  g.fillStyle = '#ffffff';
  g.font = font(34, 600);
  g.fillText('Artistes', 80, 790);
  g.font = font(32);
  card.artists.slice(0, 8).forEach((a, i) => {
    g.fillStyle = i < 3 ? '#ffffff' : '#c3c2b7';
    g.fillText(`${i + 1}. ${a.name}`, 80 + (i % 2) * 480, 845 + Math.floor(i / 2) * 56);
  });

  if (card.profile) {
    g.fillStyle = '#ffffff';
    g.font = font(34, 600);
    g.fillText('Profil sonore', 80, 1110);
    const p = card.profile;
    const items: [string, number][] = [['Énergie', p.energy], ['Positivité', p.valence], ['Danse', p.danceability], ['Acoustique', p.acousticness]];
    items.forEach(([label, v], i) => {
      const x = 80 + i * 235;
      g.fillStyle = '#c3c2b7';
      g.font = font(26);
      g.fillText(label, x, 1160);
      g.fillStyle = '#ffffff';
      g.font = font(52, 700);
      g.fillText(`${Math.round(v * 100)}`, x, 1225);
    });
  }
  g.fillStyle = '#76746f';
  g.font = font(24);
  g.fillText(`Générée le ${new Date(card.createdAt).toLocaleDateString('fr-FR')} · importe le fichier .json dans Sillon pour comparer`, 80, 1300);
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
}

export default function Friends() {
  const store = useStore();
  const { library, index, history, friends } = store;
  const me = useMemo(() => buildTasteCard(library!, index!, history), [library, index, history]);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const importCards = async (files: FileList | null) => {
    setError(null);
    for (const f of Array.from(files ?? [])) {
      try {
        const card = parseTasteCard(JSON.parse(await f.text()));
        if (card.name === me.name && card.artists[0]?.name === me.artists[0]?.name) throw new Error('C’est ta propre carte 🙂');
        store.addFriend(card);
      } catch (e) {
        setError(`${f.name} : ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  return (
    <div className="friends">
      <section className="panel">
        <header>
          <h3>Ta carte de goûts</h3>
          <span className="row">
            <button className="ghost small" onClick={() => download(`sillon-${slug(me.name)}.json`, new Blob([JSON.stringify(me)], { type: 'application/json' }))}>
              Télécharger la carte (.json)
            </button>
            <AsyncButton onClick={async () => download(`sillon-${slug(me.name)}.png`, await renderCardImage(me))}>Télécharger l’image</AsyncButton>
          </span>
        </header>
        <p className="muted small">
          Envoie le fichier <strong>.json</strong> à tes amis (ils l’importent dans leur Sillon) et importe le leur ici. Rien ne passe
          par un serveur. La carte contient tes genres, époques, profil sonore, top artistes et ~200 titres favoris, sans tes
          playlists ni ton historique détaillé. L’image, elle, est faite pour être partagée.
        </p>
        <div className="grid">
          <div>
            <h4>Genres</h4>
            <BarChart bars={Object.entries(me.families).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ key: k, label: familyLabel(k), value: v }))} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
          <div>
            <h4>Artistes</h4>
            <ol className="mini">
              {me.artists.slice(0, 10).map((a) => (
                <li key={a.name}>{a.name}</li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="panel">
        <header>
          <h3>Amis</h3>
          <button className="primary small" onClick={() => input.current?.click()}>
            Importer la carte d’un ami
          </button>
          <input ref={input} type="file" accept=".json,application/json" multiple hidden onChange={(e) => importCards(e.target.files)} />
        </header>
        {error && <p className="error-text small">{error}</p>}
        {friends.length === 0 && <p className="muted small">Aucune carte importée pour l’instant.</p>}
      </section>

      {friends.map((f) => (
        <FriendPanel key={f.name + f.createdAt} me={me} them={f} />
      ))}
    </div>
  );
}

function FriendPanel({ me, them }: { me: TasteCard; them: TasteCard }) {
  const store = useStore();
  const c = useMemo(() => compatibility(me, them), [me, them]);
  const verdict = c.score >= 75 ? 'Âmes sœurs musicales' : c.score >= 55 ? 'Très compatibles' : c.score >= 35 ? 'Des points communs' : 'Univers différents : plein de choses à se faire découvrir';

  return (
    <section className="panel friend">
      <header>
        <h3>
          Toi × {them.name}
        </h3>
        <span className="row">
          <AsyncButton
            className="primary small"
            onClick={async () => {
              const tracks = blend(me, them, 50);
              const name = `Blend ${me.name} × ${them.name}`;
              await store.createSimplePlaylist(name, `Un tiers de titres en commun, puis vos favoris en alternance — Sillon`, tracks.map((t) => t.uri));
              store.say(`« ${name} » créée (${tracks.length} titres).`);
            }}
          >
            Créer notre Blend
          </AsyncButton>
          <button className="ghost small" onClick={() => store.removeFriend(them.name, them.createdAt)}>
            Retirer
          </button>
        </span>
      </header>
      <div className="compat">
        <div className="compat-score">
          <span className="kpi-value">{c.score}%</span>
          <span className="kpi-label">{verdict}</span>
        </div>
        <BarChart bars={c.parts.map((p) => ({ key: p.label, label: p.label, value: p.value }))} format={(v) => `${Math.round(v * 100)}%`} max={1} />
      </div>
      <div className="grid">
        <div>
          <h4>En commun</h4>
          <p className="small">{c.sharedArtists.length ? c.sharedArtists.join(', ') : 'Aucun artiste en commun… pour l’instant.'}</p>
          <p className="muted small">{c.sharedTracks} titre(s) favori(s) en commun</p>
        </div>
        <div>
          <h4>À découvrir chez {them.name}</h4>
          <p className="small">{c.toDiscover.join(', ') || '—'}</p>
        </div>
        <div>
          <h4>À partager avec {them.name}</h4>
          <p className="small">{c.toShare.join(', ') || '—'}</p>
        </div>
      </div>
      <p className="muted small">Carte du {new Date(them.createdAt).toLocaleDateString('fr-FR')}</p>
    </section>
  );
}
