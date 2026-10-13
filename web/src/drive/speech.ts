/** Choosing a voice for the spoken prompts. Pure; the speaking itself is in hooks.ts. */

/** Android reports en_AU where everything else says en-AU. */
const tag = (lang: string): string => lang.replace('_', '-').toLowerCase();

/**
 * The best voice for Australian English: en-AU if the device has one, then
 * other English (British before American, which says "metres" more like us),
 * then nothing, which leaves the browser to use its default.
 */
export function pickVoice<T extends { lang: string }>(voices: readonly T[], prefer = 'en-AU'): T | undefined {
  const want = prefer.toLowerCase();
  return voices.find((v) => tag(v.lang) === want)
    ?? voices.find((v) => tag(v.lang) === 'en-gb')
    ?? voices.find((v) => tag(v.lang).startsWith('en-') || tag(v.lang) === 'en');
}
