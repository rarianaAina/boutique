import { normalizeText } from '@boutique/shared';

/**
 * L'emplacement d'un fichier d'import désigne une BOUTIQUE.
 *
 * C'est ce que le client entend par « DPKNG/Stock » : le lieu où la
 * marchandise se trouve réellement, c'est-à-dire l'une de ses boutiques. La
 * valeur n'est donc pas une caractéristique du produit — un même modèle présent
 * dans deux boutiques ne peut pas avoir un seul emplacement — mais une
 * indication de DESTINATION.
 *
 * Elle sert à PROPOSER la boutique de destination, jamais à la décider :
 * l'écran d'import la présente pré-remplie, et l'utilisateur la corrige d'un
 * clic. Deviner en silence ferait entrer un stock entier dans la mauvaise
 * boutique, et l'erreur ne se verrait qu'à l'inventaire suivant.
 */

export interface BoutiqueConnue {
  id: string;
  code: string;
  name: string;
}

/**
 * Boutique désignée par une valeur d'emplacement, ou `null`.
 *
 * Le suffixe après la barre oblique est ignoré : « DPKNG/Stock » et
 * « DPKNG/Vitrine » désignent la même boutique. Ce qui suit décrit un rayon,
 * et le logiciel ne suit pas les rayons.
 */
export function boutiqueDepuisEmplacement(
  emplacement: string | null | undefined,
  boutiques: readonly BoutiqueConnue[],
): BoutiqueConnue | null {
  const brut = (emplacement ?? '').split('/')[0] ?? '';
  const cherche = normalizeText(brut);
  if (cherche === '') return null;

  // Le code d'abord — c'est lui que le client écrit — puis le nom, pour le cas
  // où il aurait tapé « Tamatave » plutôt que « TMV ».
  return (
    boutiques.find((boutique) => normalizeText(boutique.code) === cherche) ??
    boutiques.find((boutique) => normalizeText(boutique.name) === cherche) ??
    null
  );
}

/**
 * Première valeur non vide de la colonne « Emplacement » d'une feuille.
 *
 * On lit la première ligne remplie plutôt que de toutes les comparer : les
 * fichiers du client sont mono-destination, et une feuille qui mélangerait
 * deux boutiques poserait un problème que ce choix unique ne résoudrait pas de
 * toute façon.
 */
export function emplacementDeLaFeuille(
  entetes: readonly string[],
  lignes: readonly string[][],
): string {
  const colonne = entetes.findIndex((entete) => normalizeText(entete).includes('emplacement'));
  if (colonne < 0) return '';
  for (const ligne of lignes) {
    const valeur = ligne[colonne]?.trim();
    if (valeur) return valeur;
  }
  return '';
}
