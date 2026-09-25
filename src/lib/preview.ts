// Lecteur d'extraits 30 s (Deezer) : fonctionne sans Premium ni appareil Spotify actif.
import { useSyncExternalStore } from 'react';

let audio: HTMLAudioElement | null = null;
let current: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function el(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.volume = 0.8;
    audio.addEventListener('ended', () => {
      current = null;
      emit();
    });
  }
  return audio;
}

export function togglePreview(url: string) {
  const a = el();
  if (current === url) {
    a.pause();
    current = null;
  } else {
    a.src = url;
    void a.play().catch(() => {
      current = null;
      emit();
    });
    current = url;
  }
  emit();
}

export function stopPreview() {
  audio?.pause();
  current = null;
  emit();
}

export function usePreview(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
