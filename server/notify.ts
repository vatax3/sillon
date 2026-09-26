// Notifications sortantes : ntfy (appli mobile gratuite), Discord, ou webhook générique.
import { withDefaults, type Automations } from '../src/lib/automations';
import { config } from './config';
import { getDoc } from './db';

export type NotifyEvent = 'releases' | 'playlist' | 'failure' | 'test';

export async function notify(userId: string, event: NotifyEvent, title: string, message: string, url?: string): Promise<string[]> {
  const n = withDefaults(getDoc<Partial<Automations>>(userId, 'automations')).notifications;
  if (event === 'releases' && !n.onReleases) return [];
  if (event === 'playlist' && !n.onPlaylists) return [];
  if (event === 'failure' && !n.onFailures) return [];
  const link = url ?? config.baseUrl;
  const sent: string[] = [];
  const errors: string[] = [];
  const attempt = async (name: string, fn: () => Promise<Response>) => {
    try {
      const res = await fn();
      if (!res.ok) throw new Error(`${res.status}`);
      sent.push(name);
    } catch (e) {
      errors.push(`${name} : ${e instanceof Error ? e.message : e}`);
    }
  };
  if (n.ntfyUrl) {
    // Titre et lien en paramètres d'URL : les en-têtes HTTP n'acceptent pas l'UTF-8.
    const u = new URL(n.ntfyUrl);
    u.searchParams.set('title', title);
    u.searchParams.set('click', link);
    u.searchParams.set('tags', event === 'failure' ? 'warning' : 'musical_note');
    await attempt('ntfy', () => fetch(u, { method: 'POST', body: message }));
  }
  if (n.discordUrl) {
    await attempt('Discord', () =>
      fetch(n.discordUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${message}\n<${link}>`.slice(0, 1900) }) }),
    );
  }
  if (n.webhookUrl) {
    await attempt('webhook', () =>
      fetch(n.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, title, message, url: link, user: userId }) }),
    );
  }
  if (errors.length) console.warn(`[notify] ${userId} : ${errors.join(' ; ')}`);
  if (event === 'test' && errors.length) throw new Error(errors.join(' ; '));
  return sent;
}
