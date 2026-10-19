import { pickVoice } from './speech.js';

const queue: { text: string; at: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let convoyVoice: SpeechSynthesisUtterance | null = null;
let navigationVoice: SpeechSynthesisUtterance | null = null;
export const speechSupported = () => typeof speechSynthesis !== 'undefined';

function drain(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  while (queue.length && Date.now() - queue[0].at > 30_000) queue.shift();
  if (!speechSupported() || !queue.length) return;
  // Directions own the speaker; chat never interrupts or cancels a manoeuvre.
  if (navigationVoice || speechSynthesis.speaking || speechSynthesis.pending) { timer = setTimeout(drain, 500); return; }
  const utterance = new SpeechSynthesisUtterance(queue.shift()!.text);
  const voice = pickVoice(speechSynthesis.getVoices());
  utterance.lang = voice?.lang ?? 'en-AU';
  if (voice) utterance.voice = voice;
  convoyVoice = utterance;
  utterance.onend = utterance.onerror = () => { if (convoyVoice === utterance) convoyVoice = null; drain(); };
  speechSynthesis.speak(utterance);
}

export function readConvoy(text: string): void {
  queue.push({ text, at: Date.now() });
  if (queue.length > 5) queue.shift();
  drain();
}

export function stopConvoyAudio(): void {
  queue.length = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  if (convoyVoice && speechSupported()) { convoyVoice = null; speechSynthesis.cancel(); }
}

export function speakNavigation(utterance: SpeechSynthesisUtterance): void {
  convoyVoice = null;
  navigationVoice = utterance;
  speechSynthesis.cancel();
  utterance.onend = utterance.onerror = () => { if (navigationVoice === utterance) navigationVoice = null; drain(); };
  speechSynthesis.speak(utterance);
}

export function cancelNavigation(): void {
  if (!navigationVoice || !speechSupported()) return;
  navigationVoice = null;
  speechSynthesis.cancel();
  drain();
}

/** Must run inside the rider's tap on the audio setting. */
export function unlockConvoyAudio(): void {
  if (!speechSupported() || speechSynthesis.speaking) return;
  const utterance = new SpeechSynthesisUtterance('Convoy audio ready');
  speakNavigation(utterance);
}
