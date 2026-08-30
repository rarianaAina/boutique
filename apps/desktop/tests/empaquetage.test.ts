import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous sur la configuration d'empaquetage.
 *
 * Ces vérifications ne coûtent rien et évitent une panne qui, elle, coûte
 * cher : les empaqueteurs Windows échouent en FIN de compilation, après avoir
 * téléchargé WiX et compilé le binaire en mode publication. Une dizaine de
 * minutes d'intégration continue pour découvrir qu'il manque un fichier
 * présent depuis le début, simplement non déclaré.
 */
const RACINE = fileURLToPath(new URL('../src-tauri/', import.meta.url));

interface ConfigTauri {
  productName: string;
  identifier: string;
  bundle: { icon: string[]; targets: string[] };
}

const config = (): ConfigTauri =>
  JSON.parse(readFileSync(`${RACINE}tauri.conf.json`, 'utf8')) as ConfigTauri;

describe('empaquetage', () => {
  it('déclare une icône .ico, exigée par les paquets Windows', () => {
    const icones = config().bundle.icon;
    // NSIS et MSI ne cherchent une icône QUE dans cette liste. Sans `.ico`, la
    // compilation s'arrête sur « Couldn't find a .ico icon ».
    expect(icones.some((chemin) => chemin.endsWith('.ico'))).toBe(true);
  });

  it('déclare des icônes PNG pour les paquets Linux', () => {
    const icones = config().bundle.icon;
    expect(icones.some((chemin) => chemin.endsWith('.png'))).toBe(true);
  });

  it('pointe vers des fichiers qui existent réellement', () => {
    for (const chemin of config().bundle.icon) {
      expect(existsSync(`${RACINE}${chemin}`), chemin).toBe(true);
    }
  });

  it("n'ajoute aucun champ inconnu au schéma Tauri", () => {
    // Le schéma REFUSE les champs qu'il ne connaît pas : une clé de
    // documentation glissée dans ce fichier fait échouer `tauri-build`, et le
    // message ne dit pas laquelle. Les explications vont dans le code Rust.
    const brut = JSON.parse(readFileSync(`${RACINE}tauri.conf.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    const autorisees = new Set([
      '$schema',
      'productName',
      'mainBinaryName',
      'version',
      'identifier',
      'app',
      'build',
      'bundle',
      'plugins',
    ]);
    for (const cle of Object.keys(brut)) {
      expect(autorisees.has(cle), `champ inconnu : ${cle}`).toBe(true);
    }
  });

  it("conserve l'identifiant dont dépend le dossier de données", () => {
    // Le changer orphelinerait la base de chaque poste installé, et avec elle
    // les ventes non encore synchronisées — qui n'existent nulle part ailleurs.
    expect(config().identifier).toBe('com.boutique.gestion');
  });

  it('produit des installeurs pour Windows et Linux', () => {
    const cibles = config().bundle.targets;
    for (const cible of ['nsis', 'msi', 'deb', 'appimage']) {
      expect(cibles, cible).toContain(cible);
    }
  });
});
