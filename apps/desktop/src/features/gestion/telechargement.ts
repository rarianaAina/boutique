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
 * Ce qu'on accepte de lire, et ce qu'on accepte de garder.
 *
 * DEUX SEUILS, parce que ce sont deux problèmes différents. Le commerçant
 * enverra le fichier qu'il a sous la main — une photo d'enseigne prise au
 * téléphone, un logo exporté en pleine résolution — et lui répondre « image
 * trop lourde » le laisse sans solution. On lit donc largement, puis on
 * RÉDUIT avant de ranger.
 *
 * Le logo est stocké DANS LA BASE, en URI de données : il suit ainsi la
 * boutique dans l'archive de portabilité, ce qu'un chemin de fichier ne ferait
 * pas. En contrepartie il est relu à chaque chargement des paramètres, et
 * l'encodage base64 l'alourdit d'un tiers. D'où la cible.
 */
export const LOGO_SOURCE_MAX_OCTETS = 8 * 1024 * 1024;
export const LOGO_STOCKE_MAX_OCTETS = 250 * 1024;

/**
 * Côté le plus long, en pixels, après réduction.
 *
 * La facture imprime le logo dans un cadre de 130 points sur 44, soit environ
 * 540 pixels de large à 300 points par pouce. Neuf cents pixels laissent de la
 * marge pour un logo très large ou très haut, sans garder une image dont la
 * moitié de la définition serait perdue à l'impression.
 */
export const LOGO_COTE_MAX = 900;

/**
 * Dimensions après réduction, proportions gardées.
 *
 * Une image déjà plus petite que la borne n'est PAS agrandie : l'agrandir ne
 * lui rendrait aucune définition et ne ferait que peser davantage.
 */
export function dimensionsReduites(
  largeur: number,
  hauteur: number,
  cote = LOGO_COTE_MAX,
): { largeur: number; hauteur: number } {
  const facteur = Math.min(cote / largeur, cote / hauteur, 1);
  return {
    largeur: Math.max(1, Math.round(largeur * facteur)),
    hauteur: Math.max(1, Math.round(hauteur * facteur)),
  };
}

/**
 * Ouvre une image choisie par l'utilisateur, la réduit, et la rend en URI de
 * données.
 *
 * PNG ou JPEG uniquement : ce sont les deux formats qu'un PDF sait embarquer.
 * Accepter un SVG ou un WebP ne ferait que reporter l'échec au moment
 * d'imprimer la première facture.
 */
export async function lireImage(): Promise<string | null> {
  const extensions = ['png', 'jpg', 'jpeg'];

  if (!isTauriRuntime()) {
    const brut = await new Promise<string | null>((resoudre, rejeter) => {
      const champ = document.createElement('input');
      champ.type = 'file';
      champ.accept = extensions.map((extension) => `.${extension}`).join(',');
      champ.onchange = () => {
        const fichier = champ.files?.[0];
        if (!fichier) return resoudre(null);
        if (fichier.size > LOGO_SOURCE_MAX_OCTETS) return rejeter(new Error(TROP_GROS));
        const lecteur = new FileReader();
        lecteur.onload = () => resoudre(String(lecteur.result));
        lecteur.onerror = () => rejeter(new Error("L'image n'a pas pu être lue."));
        lecteur.readAsDataURL(fichier);
      };
      champ.click();
    });
    return brut === null ? null : comprimerImage(brut);
  }

  const chemin = await open({ multiple: false, filters: [{ name: 'Image', extensions }] });
  if (typeof chemin !== 'string') return null;

  const octets = await invoke<number[]>('read_import', { path: chemin });
  if (octets.length > LOGO_SOURCE_MAX_OCTETS) throw new Error(TROP_GROS);

  const type = /\.jpe?g$/i.test(chemin) ? 'image/jpeg' : 'image/png';
  return comprimerImage(`data:${type};base64,${base64(Uint8Array.from(octets))}`);
}

const TROP_GROS = `Image trop lourde : ${Math.round(LOGO_SOURCE_MAX_OCTETS / (1024 * 1024))} Mo au maximum.`;

/**
 * Réduit une image jusqu'à tenir sous la cible.
 *
 * TROIS LEVIERS, dans cet ordre : les dimensions d'abord, puisqu'une image de
 * facture n'a pas besoin de trois mille pixels ; le passage en JPEG ensuite,
 * mais SEULEMENT si l'image n'a pas de transparence — un logo détouré posé sur
 * fond blanc par le JPEG afficherait un rectangle blanc sur la facture ; la
 * qualité JPEG en dernier.
 *
 * Si rien n'y suffit, on rend la plus petite version obtenue plutôt que
 * d'échouer : une facture avec un logo un peu terne vaut mieux qu'un
 * commerçant qui n'arrive pas à mettre le sien.
 */
async function comprimerImage(uri: string): Promise<string> {
  if (uri.length <= LOGO_STOCKE_MAX_OCTETS) return uri;

  const image = await chargerImage(uri);
  let meilleure = uri;

  for (const cote of [LOGO_COTE_MAX, 700, 500, 360]) {
    const { largeur, hauteur } = dimensionsReduites(image.naturalWidth, image.naturalHeight, cote);
    const toile = document.createElement('canvas');
    toile.width = largeur;
    toile.height = hauteur;

    const pinceau = toile.getContext('2d');
    if (!pinceau) return meilleure;
    pinceau.drawImage(image, 0, 0, largeur, hauteur);

    const candidats = aDeLaTransparence(pinceau, largeur, hauteur)
      ? [toile.toDataURL('image/png')]
      : [
          toile.toDataURL('image/png'),
          toile.toDataURL('image/jpeg', 0.9),
          toile.toDataURL('image/jpeg', 0.75),
          toile.toDataURL('image/jpeg', 0.6),
        ];

    for (const candidat of candidats) {
      if (candidat.length < meilleure.length) meilleure = candidat;
      if (candidat.length <= LOGO_STOCKE_MAX_OCTETS) return candidat;
    }
  }

  return meilleure;
}

function chargerImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resoudre, rejeter) => {
    const image = new Image();
    image.onload = () => resoudre(image);
    image.onerror = () => rejeter(new Error("Ce fichier n'est pas une image lisible."));
    image.src = uri;
  });
}

/**
 * L'image a-t-elle des pixels transparents ?
 *
 * Un logo de commerce est presque toujours détouré. Le convertir en JPEG
 * remplacerait la transparence par du noir ou du blanc, et la facture
 * porterait un rectangle au lieu d'un logo — un défaut qu'on ne voit qu'une
 * fois la première pièce imprimée.
 *
 * Les pixels sont examinés par pas plutôt qu'un par un : sur une image de
 * neuf cents pixels de côté, tout parcourir coûterait un temps visible pour
 * une réponse qui n'a pas besoin d'être exhaustive.
 */
function aDeLaTransparence(pinceau: CanvasRenderingContext2D, largeur: number, hauteur: number) {
  try {
    const pixels = pinceau.getImageData(0, 0, largeur, hauteur).data;
    for (let rang = 3; rang < pixels.length; rang += 4 * 7) {
      if ((pixels[rang] ?? 255) < 250) return true;
    }
    return false;
  } catch {
    // Contexte non lisible : on suppose la transparence, ce qui interdit le
    // JPEG. Une image plus lourde vaut mieux qu'un logo abîmé.
    return true;
  }
}

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
