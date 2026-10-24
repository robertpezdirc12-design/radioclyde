import crypto from 'node:crypto';

// Constant-time string comparison for credential checks (auth.js's listener
// realm, studioAuth.js's studio realm, and the polls owner gate). Digest-first
// so the buffer lengths always match (timingSafeEqual throws on unequal
// lengths) regardless of the inputs' lengths -- and so the comparison time
// doesn't reveal how many leading bytes matched. Hashing first is fine here:
// the property we need is "no early-exit timing signal", not preimage
// resistance; the digests never leave this call.
export function credentialEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}
