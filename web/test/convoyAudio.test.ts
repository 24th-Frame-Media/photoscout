import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelNavigation, readConvoy, speakNavigation, stopConvoyAudio } from '../src/drive/audio.js';

test('convoy audio waits for directions, cannot cancel them, and yields to a new manoeuvre', () => {
  const originalSpeech = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  class Utterance {
    lang = ''; voice = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  let speaking = false;
  let current: Utterance | null = null;
  let cancels = 0;
  const spoken: string[] = [];
  const finish = () => { const previous = current; current = null; speaking = false; previous?.onend?.(); };
  const fake = {
    get speaking() { return speaking; }, pending: false,
    getVoices: () => [],
    speak: (u: Utterance) => { current = u; speaking = true; spoken.push(u.text); },
    cancel: () => { cancels++; finish(); },
  };
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: fake });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
  try {
    speakNavigation(new Utterance('Turn left') as unknown as SpeechSynthesisUtterance);
    readConvoy('Bob: Wait for me');
    assert.deepEqual(spoken, ['Turn left']);
    const beforeStop = cancels;
    stopConvoyAudio();
    assert.equal(cancels, beforeStop, 'muting convoy must not cancel navigation');
    readConvoy('Bob: Ready to go');
    finish();
    assert.deepEqual(spoken, ['Turn left', 'Bob: Ready to go']);
    speakNavigation(new Utterance('Take the next exit') as unknown as SpeechSynthesisUtterance);
    assert.equal(spoken.at(-1), 'Take the next exit', 'directions replace a playing chat message');
    assert.equal(cancels, beforeStop + 1);
  } finally {
    stopConvoyAudio(); cancelNavigation();
    if (originalSpeech) Object.defineProperty(globalThis, 'speechSynthesis', originalSpeech); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (originalUtterance) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', originalUtterance); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});
