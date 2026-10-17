import { resolveSecret } from '../events/secrets.js';
import { PluginError } from './manifest.js';
import type { SettingField } from './types.js';

/**
 * A plugin's settings: the values an admin saves against the fields the plugin
 * declares. Secrets follow the same rule as the core credentials: the admin's
 * page never gets a value back, a blank keeps the stored one, and null clears it.
 */

/** Keys for companion-service addresses, `service:<name>:url`. Not in the form; set by the admin API. */
export const SERVICE_URL_KEY = /^service:[a-z][a-z0-9-]*:url$/;

export function settingDefaults(fields: SettingField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** What the plugin sees: the stored values over the manifest defaults. */
export function effectiveSettings(fields: SettingField[], stored: Record<string, unknown>): Record<string, unknown> {
  return { ...settingDefaults(fields), ...stored };
}

/** A property the object has itself, or undefined: never one inherited from Object.prototype. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** A service address with any user:password@ taken out, so the admin page never shows the credentials. */
export function maskCredentials(address: string): string {
  return address.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@');
}

/**
 * What the admin page sees: only the keys the current manifest declares. Secrets
 * are blanked, with only whether each one is set. Service addresses are shown
 * for the services the manifest declares, with their credentials masked. Keys
 * left over from removed fields are not shown at all.
 */
export function redactedSettings(
  fields: SettingField[],
  stored: Record<string, unknown>,
  serviceNames: readonly string[] = [],
): { values: Record<string, unknown>; secretsSet: Record<string, boolean> } {
  const effective = effectiveSettings(fields, stored);
  const values: Record<string, unknown> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const field of fields) {
    if (field.type === 'secret') {
      secretsSet[field.key] = String(own(effective, field.key) ?? '').trim() !== '';
      values[field.key] = '';
    } else if (Object.hasOwn(effective, field.key)) {
      values[field.key] = effective[field.key];
    }
  }
  for (const name of serviceNames) {
    const key = `service:${name}:url`;
    const address = own(stored, key);
    if (typeof address === 'string') values[key] = maskCredentials(address);
  }
  return { values, secretsSet };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function checkValue(field: SettingField, raw: unknown): unknown {
  const fail = (why: string): never => {
    throw new PluginError(`${field.label}: ${why}`);
  };
  switch (field.type) {
    case 'string':
    case 'url': {
      if (typeof raw !== 'string') return fail('must be text');
      const trimmed = raw.trim();
      if (field.type === 'url' && trimmed !== '' && !isHttpUrl(trimmed)) return fail('must be an http or https address');
      return trimmed;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return fail('must be a number');
      if (field.min !== undefined && n < field.min) return fail(`must be at least ${field.min}`);
      if (field.max !== undefined && n > field.max) return fail(`must be at most ${field.max}`);
      return n;
    }
    case 'boolean':
      if (typeof raw !== 'boolean') return fail('must be on or off');
      return raw;
    case 'select':
      if (typeof raw !== 'string' || !field.options.some((o) => o.value === raw)) return fail('is not one of the choices');
      return raw;
    default:
      return fail('has an unknown type');
  }
}

/**
 * The stored values after an admin's save. Fields not in `body` keep what they
 * had; secrets go through `resolveSecret`; unknown keys are dropped (except the
 * service addresses). Throws PluginError on the first value that does not fit.
 */
export function mergeSettings(
  fields: SettingField[],
  stored: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const field of fields) {
    if (field.type === 'secret') {
      next[field.key] = resolveSecret(String(own(stored, field.key) ?? ''), own(body, field.key));
      continue;
    }
    if (own(body, field.key) === undefined) continue;
    next[field.key] = checkValue(field, own(body, field.key));
  }
  const effective = effectiveSettings(fields, next);
  for (const field of fields) {
    if (field.required && String(own(effective, field.key) ?? '').trim() === '') throw new PluginError(`${field.label} is required`);
  }
  for (const [key, value] of Object.entries(body)) {
    if (!SERVICE_URL_KEY.test(key)) continue;
    if (value === null || value === '') {
      delete next[key];
      continue;
    }
    if (typeof value !== 'string' || !isHttpUrl(value.trim())) throw new PluginError(`${key} must be an http or https address`);
    next[key] = value.trim();
  }
  return next;
}
