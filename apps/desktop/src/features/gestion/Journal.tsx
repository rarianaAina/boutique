import { useState } from 'react';
import { AuditRepository, AUDIT_ACTIONS } from '@/core/db/repositories/audit.repository';
import { Carte, EnTetePage, Erreur } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import {
  BarreFiltres,
  ChampRecherche,
  ListeFiltre,
  Pagination,
  Tableau,
} from '@/components/ui/Tableau';
import { useSession } from '@/app/session';
import { formaterDate, useChargement, useDifferee } from '@/app/hooks';

/**
 * Journal d'audit (§21).
 *
 * Lecture seule, sans exception : un journal qu'on peut modifier ne prouve
 * rien. Les valeurs avant/après ne montrent que les champs qui ont changé —
 * deux copies complètes de l'objet seraient illisibles.
 */
const LIBELLES: Record<string, string> = {
  LOGIN: 'Connexion',
  LOGOUT: 'Déconnexion',
  LOGIN_FAILED: 'Échec de connexion',
  CREATE: 'Création',
  UPDATE: 'Modification',
  SOFT_DELETE: 'Suppression',
  SALE: 'Vente',
  SALE_CANCEL: 'Annulation de vente',
  REFUND: 'Remboursement',
  EXCHANGE: 'Échange',
  PURCHASE: 'Achat',
  RECEIPT: 'Réception',
  TRANSFER: 'Transfert',
  PRICE_CHANGE: 'Changement de prix',
  STOCK_CHANGE: 'Mouvement de stock',
  IMPORT: 'Import',
  SYNC: 'Synchronisation',
  BACKUP: 'Sauvegarde',
};

export function Journal() {
  const { db } = useSession();
  const [action, setAction] = useState('');
  const [entite, setEntite] = useState('');
  const differee = useDifferee(entite);
  const [offset, setOffset] = useState(0);
  const limite = 100;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new AuditRepository(db).list({
      action: action || null,
      entity: differee || null,
      limit: limite,
      offset,
    });
  }, [db, action, differee, offset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Journal d'audit"
        sousTitre="Qui a fait quoi, quand. Journal en lecture seule."
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ListeFiltre
            valeur={action}
            onChanger={(valeur) => {
              setAction(valeur);
              setOffset(0);
            }}
            vide="Toutes les actions"
            options={Object.values(AUDIT_ACTIONS).map((valeur) => ({
              valeur,
              libelle: LIBELLES[valeur] ?? valeur,
            }))}
          />
          <ChampRecherche
            valeur={entite}
            onChanger={(valeur) => {
              setEntite(valeur);
              setOffset(0);
            }}
            placeholder="Filtrer par entité (sale, product…)"
            largeur="w-64"
          />
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees?.items ?? []}
            cleDe={(ligne) => ligne.id}
            vide={{ icone: 'info', titre: 'Aucune entrée' }}
            colonnes={[
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.at, true) },
              { cle: 'utilisateur', titre: 'Utilisateur', rendu: (l) => l.userLabel ?? '—' },
              {
                cle: 'action',
                titre: 'Action',
                rendu: (l) => <Badge ton="neutre">{LIBELLES[l.action] ?? l.action}</Badge>,
              },
              { cle: 'entite', titre: 'Entité', rendu: (l) => l.entity },
              {
                cle: 'valeurs',
                titre: 'Détail',
                rendu: (l) => (
                  <span className="text-xs text-encre-600" data-selectable>
                    {resume(l.before, l.after)}
                  </span>
                ),
              },
            ]}
          />
        )}

        <Pagination
          offset={offset}
          limite={limite}
          total={etat.donnees?.total ?? 0}
          onChanger={setOffset}
        />
      </Carte>
    </div>
  );
}

/**
 * Résumé lisible d'un changement.
 *
 * On préfère « prixVente : 2 950 000 → 2 750 000 » à deux blocs de JSON : le
 * journal sert à comprendre d'un coup d'œil, pas à archiver des objets.
 */
function resume(avant: unknown, apres: unknown): string {
  const gauche = (avant ?? {}) as Record<string, unknown>;
  const droite = (apres ?? {}) as Record<string, unknown>;
  const cles = [...new Set([...Object.keys(gauche), ...Object.keys(droite)])];
  if (cles.length === 0) return '—';

  return cles
    .slice(0, 4)
    .map((cle) => {
      const a = gauche[cle];
      const b = droite[cle];
      if (a === undefined) return `${cle} : ${format(b)}`;
      if (b === undefined) return `${cle} : ${format(a)}`;
      return `${cle} : ${format(a)} → ${format(b)}`;
    })
    .join(' · ');
}

function format(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return '∅';
  if (Array.isArray(valeur)) return `${valeur.length} élément(s)`;
  if (typeof valeur === 'object') return JSON.stringify(valeur).slice(0, 60);
  return String(valeur);
}
