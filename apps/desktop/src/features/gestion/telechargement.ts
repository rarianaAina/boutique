import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { isTauriRuntime } from '@/core/db/client';

/**
 * Enregistrement d'un export sur le disque.
 *
 * Le chemin est CHOISI par l'utilisateur dans la boîte de dialogue du système ;
 * c'est ce choix explicite qui tient lieu d'autorisation, la portée fixe du
 * plugin `fs` ne pouvant pas connaître à l'avance le dossier voulu.
 *
 * Hors Tauri (développement dans un navigateur), on retombe sur un lien de
 * téléchargement : l'écran reste utilisable sans lancer l'application complète.
 */
export async function telecharger(
  nomFichier: string,
  contenu: string,
  type: 'csv' | 'json' = 'csv',
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const lien = document.createElement('a');
    const blob = new Blob([contenu], {
      type: type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
    });
    lien.href = URL.createObjectURL(blob);
    lien.download = nomFichier;
    lien.click();
    URL.revokeObjectURL(lien.href);
    return nomFichier;
  }

  const chemin = await save({
    defaultPath: nomFichier,
    filters:
      type === 'json'
        ? [{ name: 'Archive de boutique', extensions: ['json'] }]
        : [{ name: 'Fichier CSV', extensions: ['csv'] }],
  });
  if (!chemin) return null;

  const octets = Array.from(new TextEncoder().encode(contenu));
  await invoke('write_export', { path: chemin, contents: octets });
  return chemin;
}

/**
 * Ouvre un fichier choisi par l'utilisateur et rend son contenu.
 *
 * Le choix explicite dans la boîte de dialogue du système tient lieu
 * d'autorisation, comme pour l'enregistrement. Hors Tauri, on retombe sur un
 * champ de fichier invisible : l'écran reste utilisable en développement.
 */
export async function lireFichier(extensions: string[], libelle: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return new Promise((resoudre) => {
      const champ = document.createElement('input');
      champ.type = 'file';
      champ.accept = extensions.map((extension) => `.${extension}`).join(',');
      champ.onchange = () => {
        const fichier = champ.files?.[0];
        if (!fichier) return resoudre(null);
        void fichier.text().then(resoudre);
      };
      champ.click();
    });
  }

  const chemin = await open({ multiple: false, filters: [{ name: libelle, extensions }] });
  if (typeof chemin !== 'string') return null;
  const octets = await invoke<number[]>('read_import', { path: chemin });
  return new TextDecoder().decode(new Uint8Array(octets));
}

/**
 * Enregistre un fichier BINAIRE choisi par l'utilisateur, et l'ouvre.
 *
 * `telecharger` ne convient pas : elle encode une chaîne en UTF-8, ce qui
 * détruirait un PDF. Les octets partent tels quels.
 *
 * Le fichier est OUVERT après l'enregistrement parce que c'est ce qu'on veut
 * en faire : vérifier la facture, l'imprimer, la joindre à un message. S'il ne
 * s'ouvre pas — aucun lecteur installé, ce qui arrive sur un poste neuf — on
 * n'en fait pas une erreur : le fichier, lui, est bien écrit.
 */
export async function enregistrerBinaire(
  nomFichier: string,
  octets: Uint8Array,
  libelle: string,
  extension: string,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const lien = document.createElement('a');
    // La copie évite un ArrayBuffer partagé, que Blob refuse dans certains
    // navigateurs.
    const blob = new Blob([new Uint8Array(octets)], { type: 'application/octet-stream' });
    lien.href = URL.createObjectURL(blob);
    lien.download = nomFichier;
    lien.click();
    URL.revokeObjectURL(lien.href);
    return nomFichier;
  }

  const chemin = await save({
    defaultPath: nomFichier,
    filters: [{ name: libelle, extensions: [extension] }],
  });
  if (!chemin) return null;

  await invoke('write_export', { path: chemin, contents: Array.from(octets) });
  try {
    await openPath(chemin);
  } catch {
    // Aucun lecteur associé : le fichier est écrit, c'est l'essentiel.
  }
  return chemin;
}

/**
 * Taille maximale d'un logo, en octets de fichier source.
 *
 * Le logo est rangé DANS LA BASE, en URI de données : il part ainsi avec
 * l'archive de portabilité et suit la boutique d'une machine à l'autre. En
 * contrepartie il est relu à chaque chargement des paramètres, et encodé en
 * base64 il occupe un tiers de plus que le fichier. Deux cents kilo-octets
 * suffisent très largement à un logo de facture ; au-delà, c'est une photo.
 */
export const LOGO_MAX_OCTETS = 200 * 1024;

/**
 * Ouvre une image choisie par l'utilisateur et la rend en URI de données.
 *
 * PNG ou JPEG uniquement : ce sont les deux formats qu'un PDF sait embarquer.
 * Accepter un SVG ou un WebP ne ferait que reporter l'échec au moment
 * d'imprimer la première facture.
 */
export async function lireImage(): Promise<string | null> {
  const extensions = ['png', 'jpg', 'jpeg'];

  if (!isTauriRuntime()) {
    return new Promise((resoudre, rejeter) => {
      const champ = document.createElement('input');
      champ.type = 'file';
      champ.accept = extensions.map((extension) => `.${extension}`).join(',');
      champ.onchange = () => {
        const fichier = champ.files?.[0];
        if (!fichier) return resoudre(null);
        if (fichier.size > LOGO_MAX_OCTETS) return rejeter(new Error(TROP_GROS));
        const lecteur = new FileReader();
        lecteur.onload = () => resoudre(String(lecteur.result));
        lecteur.onerror = () => rejeter(new Error("L'image n'a pas pu être lue."));
        lecteur.readAsDataURL(fichier);
      };
      champ.click();
    });
  }

  const chemin = await open({ multiple: false, filters: [{ name: 'Image', extensions }] });
  if (typeof chemin !== 'string') return null;

  const octets = await invoke<number[]>('read_import', { path: chemin });
  if (octets.length > LOGO_MAX_OCTETS) throw new Error(TROP_GROS);

  const type = /\.jpe?g$/i.test(chemin) ? 'image/jpeg' : 'image/png';
  return `data:${type};base64,${base64(Uint8Array.from(octets))}`;
}

const TROP_GROS = `Image trop lourde : ${Math.round(LOGO_MAX_OCTETS / 1024)} Ko au maximum.`;

/**
 * Octets -> base64.
 *
 * Par tranches : `String.fromCharCode(...tableau)` sur une image entière
 * dépasse le nombre d'arguments qu'un appel de fonction accepte, et échoue par
 * un débordement de pile plutôt que par un message clair.
 */
function base64(octets: Uint8Array): string {
  let binaire = '';
  const tranche = 0x8000;
  for (let debut = 0; debut < octets.length; debut += tranche) {
    binaire += String.fromCharCode(...octets.subarray(debut, debut + tranche));
  }
  return btoa(binaire);
}
