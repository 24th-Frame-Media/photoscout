/** The browser APIs the Drive screen leans on, each as a small hook. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Fix } from './camera.js';
import { pickVoice } from './speech.js';
import { cancelNavigation, speakNavigation } from './audio.js';

export type GpsError = 'unsupported' | 'insecure' | 'denied' | 'unavailable' | 'timeout';

/**
 * The device's position, as often as it reports one, at the highest accuracy
 * it will give. `error` clears itself when a fix arrives, so a tunnel is a
 * passing warning and a refusal is not.
 */
export function useGeolocation(): { fix: Fix | null; error: GpsError | null } {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<GpsError | null>(null);
  useEffect(() => {
    if (!('geolocation' in navigator)) { setError('unsupported'); return; }
    // Browsers only share a position with pages served over https (or from localhost).
    if (!window.isSecureContext) { setError('insecure'); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null);
        setFix({
          lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy,
          speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp || Date.now(),
        });
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.POSITION_UNAVAILABLE ? 'unavailable' : 'timeout'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { fix, error };
}

/**
 * Keep the screen on while `active`. The browser drops the lock whenever the
 * page is hidden, so it is asked for again when the page comes back.
 */
export function useWakeLock(active: boolean): 'on' | 'off' | 'unsupported' {
  const [state, setState] = useState<'on' | 'off' | 'unsupported'>('off');
  useEffect(() => {
    if (!active) {
      window.PhotoScoutNative?.setKeepAwake?.(false);
      return;
    }
    if (window.PhotoScoutNative?.setKeepAwake) {
      window.PhotoScoutNative.setKeepAwake(true);
      setState('on');
      return () => {
        window.PhotoScoutNative?.setKeepAwake?.(false);
      };
    }
    if (!('wakeLock' in navigator)) { setState('unsupported'); return; }
    let sentinel: WakeLockSentinel | null = null;
    let gone = false;
    const take = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (gone) { void s.release(); return; }
        sentinel = s;
        setState('on');
        s.addEventListener('release', () => setState('off'));
      } catch { setState('off'); } // refused: low battery, or a power-saving mode
    };
    void take();
    document.addEventListener('visibilitychange', take);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', take);
      void sentinel?.release();
    };
  }, [active]);
  return state;
}

const MUTE_KEY = 'ps.driveMuted';

/** Spoken prompts, in an Australian voice if the device has one. Muting is remembered. */
export function useSpeech(): { speak: (text: string) => void; cancel: () => void; unlock: () => void; muted: boolean; setMuted: (m: boolean) => void; supported: boolean } {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [muted, setMutedState] = useState(() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } });
  const voice = useRef<SpeechSynthesisVoice | undefined>(undefined);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Voices arrive late on some browsers, so look again when they say they have.
  useEffect(() => {
    if (!supported) return;
    const load = () => { voice.current = pickVoice(speechSynthesis.getVoices()); };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => { speechSynthesis.removeEventListener('voiceschanged', load); cancelNavigation(); };
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!supported || mutedRef.current) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice.current?.lang ?? 'en-AU';
    if (voice.current) u.voice = voice.current;
    speakNavigation(u);
  }, [supported]);

  /** Phones only let a page speak after it has been touched; a silent word inside a tap does it. */
  const unlock = useCallback(() => {
    if (!supported) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }, [supported]);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (m && supported) cancelNavigation();
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* private mode */ }
  }, [supported]);

  const cancel = useCallback(() => { if (supported) cancelNavigation(); }, [supported]);

  return { speak, cancel, unlock, muted, setMuted, supported };
}

/** Re-render every `ms`, for things that go stale with time alone (a GPS that has gone quiet). */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}
