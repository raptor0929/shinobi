import {
  deriveTokenSecrets,
  fromHex,
  toHex,
  type TokenSecrets,
} from "@cpp/client/crypto";

const CACHE_KEY = "shinobi.seed.v1";

export type CachedSeedBlob = {
  /** AES-GCM ciphertext of 32-byte seed, base64 */
  ciphertext: string;
  iv: string;
  salt: string;
};

export function generateTokenSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function seedToHex(seed: Uint8Array): string {
  return toHex(seed);
}

export function seedFromHex(hex: string): Uint8Array {
  const bytes = fromHex(hex.trim());
  if (bytes.length !== 32) throw new Error("Token Seed must be 32 bytes (64 hex chars)");
  return bytes;
}

export function secretsAt(seed: Uint8Array, index: number): TokenSecrets {
  return deriveTokenSecrets(seed, index);
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: 120_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function b64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Local Seed Cache — passphrase-encrypted; never plaintext. */
export async function saveSeedCache(
  seed: Uint8Array,
  passphrase: string,
): Promise<void> {
  if (!passphrase) throw new Error("Passphrase required for Local Seed Cache");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      key,
      seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength) as ArrayBuffer,
    ),
  );
  const blob: CachedSeedBlob = {
    ciphertext: b64(ciphertext),
    iv: b64(iv),
    salt: b64(salt),
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(blob));
}

export async function loadSeedCache(passphrase: string): Promise<Uint8Array | null> {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const blob = JSON.parse(raw) as CachedSeedBlob;
  const key = await deriveKey(passphrase, fromB64(blob.salt));
  const ivBytes = fromB64(blob.iv);
  const ctBytes = fromB64(blob.ciphertext);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ivBytes.buffer.slice(
        ivBytes.byteOffset,
        ivBytes.byteOffset + ivBytes.byteLength,
      ) as ArrayBuffer,
    },
    key,
    ctBytes.buffer.slice(
      ctBytes.byteOffset,
      ctBytes.byteOffset + ctBytes.byteLength,
    ) as ArrayBuffer,
  );
  return new Uint8Array(plain);
}

export function clearSeedCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

export function hasSeedCache(): boolean {
  return !!localStorage.getItem(CACHE_KEY);
}
