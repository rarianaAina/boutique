/**
 * Jeu d'icônes.
 *
 * Dessinées ici, en SVG, plutôt qu'importées d'une bibliothèque : l'application
 * fonctionne hors ligne, et une police d'icônes ou un paquet de plusieurs
 * centaines de glyphes coûterait bien plus que les vingt formes réellement
 * employées. Toutes partagent la même grille de 24 et la même épaisseur de
 * trait, ce qu'aucun assemblage d'icônes glanées ne garantit.
 */
export type NomIcone =
  | 'tableau'
  | 'caisse'
  | 'ticket'
  | 'facture'
  | 'retour'
  | 'echange'
  | 'boite'
  | 'telephone'
  | 'mouvement'
  | 'inventaire'
  | 'alerte'
  | 'achat'
  | 'fournisseur'
  | 'camion'
  | 'client'
  | 'rapport'
  | 'utilisateur'
  | 'reglage'
  | 'synchro'
  | 'recherche'
  | 'plus'
  | 'croix'
  | 'chevron'
  | 'check'
  | 'import'
  | 'export'
  | 'sauvegarde'
  | 'poubelle'
  | 'crayon'
  | 'info'
  | 'menu';

const TRACES: Record<NomIcone, string> = {
  tableau: 'M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  caisse: 'M3 8h18l-1.5 11H4.5zM8 8V6a4 4 0 0 1 8 0v2',
  ticket: 'M5 4h14v16l-2.5-1.5L14 20l-2-1.5L10 20l-2.5-1.5L5 20zM8.5 9h7M8.5 13h5',
  facture: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
  retour: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12h-1',
  echange: 'M4 8h13l-3-3M20 16H7l3 3',
  boite: 'M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  telephone: 'M7 3h10v18H7zM10.5 18h3',
  mouvement: 'M4 7h11l-3-3M20 17H9l3 3M4 12h16',
  inventaire: 'M4 5h16v14H4zM8 5v14M4 10h16M4 15h16',
  alerte: 'M12 4 2.5 20h19zM12 10v4M12 17.2v.1',
  achat: 'M3 5h3l2.5 11h10L21 8H7M9 20.5v.1M18 20.5v.1',
  fournisseur: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6',
  camion: 'M2 7h11v9H2zM13 10h4l3 3v3h-7zM6 19.5v.1M17 19.5v.1',
  client: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  rapport: 'M4 20h16M7 17V9M12 17V5M17 17v-6',
  utilisateur: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20a6 6 0 0 1 12 0M17 8h4M19 6v4',
  reglage:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.5 12a7.5 7.5 0 0 0-.15-1.5l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2h-4l-.35 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.5 7.5 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 0 0 2.6 1.5L10 22h4l.35-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5c.1-.5.15-1 .15-1.5Z',
  synchro: 'M20 11a8 8 0 0 0-14-4.5M4 13a8 8 0 0 0 14 4.5M18 3v4h-4M6 21v-4h4',
  recherche: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  croix: 'M6 6l12 12M18 6 6 18',
  chevron: 'm9 6 6 6-6 6',
  check: 'm5 13 4.5 4.5L19 7',
  import: 'M12 3v12m0 0 4-4m-4 4-4-4M4 19h16',
  export: 'M12 21V9m0 0 4 4M12 9 8 13M4 5h16',
  sauvegarde: 'M4 6h16v14H4zM8 6V3h8v3M8 14h8',
  poubelle: 'M4 7h16M10 7V4h4v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  crayon: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5v.1',
};

export interface IconeProps {
  nom: NomIcone;
  taille?: number;
  className?: string;
}

export function Icone({ nom, taille = 18, className }: IconeProps) {
  return (
    <svg
      width={taille}
      height={taille}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={TRACES[nom]} />
    </svg>
  );
}
