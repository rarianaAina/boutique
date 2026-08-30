/**
 * Empreintes de mots de passe.
 *
 * Format : `pbkdf2-sha256$<itérations>$<sel base64>$<empreinte base64>`.
 * Le nombre d'itérations est stocké DANS l'empreinte : le jour où l'on
 * l'augmentera, les comptes existants resteront vérifiables, et pourront être
 * réencodés à leur prochaine connexion réussie.
 *
 * PBKDF2 plutôt qu'Argon2 : il est fourni par WebCrypto, donc disponible sans
 * dépendance, dans la WebView comme dans les tests. Aucun mot de passe n'est
 * jamais stocké ni journalisé en clair (§20).
 */

const ALGORITHM = 'pbkdf2-sha256';
/** Coût choisi pour rester sous ~100 ms sur un poste de boutique modeste. */
const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await derive(password, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Vérifie un mot de passe.
 *
 * La comparaison est faite en TEMPS CONSTANT : une comparaison ordinaire
 * s'arrête au premier octet différent, et le temps de réponse renseignerait un
 * attaquant local sur le nombre d'octets déjà devinés.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    salt = fromBase64(parts[2] ?? '');
    expected = fromBase64(parts[3] ?? '');
  } catch {
    return false;
  }

  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Vrai si l'empreinte utilise un coût inférieur à celui d'aujourd'hui. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== ALGORITHM || Number(parts[1]) < ITERATIONS;
}

/**
 * Exigences minimales sur un mot de passe.
 *
 * Volontairement modestes : un vendeur qui doit taper son mot de passe cinquante
 * fois par jour contournera toute règle trop stricte en le collant sous le
 * clavier. Huit caractères et l'interdiction des mots de passe évidents valent
 * mieux qu'une politique que personne ne respecte.
 */
const OBVIOUS = new Set([
  'motdepasse',
  'password',
  '12345678',
  'azertyuiop',
  'qwertyuiop',
  'boutique',
]);

export function checkPasswordStrength(password: string): string | null {
  if (password.length < 8) return 'Le mot de passe doit comporter au moins 8 caractères.';
  if (OBVIOUS.has(password.toLowerCase())) return 'Ce mot de passe est trop courant.';
  return null;
}
