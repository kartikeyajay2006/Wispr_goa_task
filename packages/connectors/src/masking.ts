import {REDACTED} from './schema.js';

/** "Mira Kulkarni" → "Mira K."; redacted or missing names stay hidden. */
export const maskName = (name: unknown) => typeof name === 'string' && name && name !== REDACTED ? name.split(/\s+/).map((part, index) => index === 0 ? part : `${part[0]}.`).join(' ') : undefined;
/** "mira@example.invalid" → "m••••@example.invalid". */
export const maskEmail = (email: unknown) => typeof email === 'string' && email !== REDACTED && email.includes('@') ? `${email[0]}${'•'.repeat(4)}@${email.split('@')[1]}` : undefined;
