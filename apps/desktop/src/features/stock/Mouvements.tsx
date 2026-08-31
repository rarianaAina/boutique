import { useState } from 'react';
import { MOVEMENT_LABELS, MOVEMENT_TYPE, valuesOf } from '@boutique/shared';
import type { MovementType } from '@boutique/shared';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { toCsv, exportFileName } from '@/core/services/export.service';
import { Carte, EnTetePage, Erreur } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { BarreFiltres, ListeFiltre, Pagination, Tableau } from '@/components/ui/Tableau';
import { ChoixPeriode, usePeriode } from '@/components/ui/Periode';
import { Onglets } from '@/components/ui/Onglets';
import { Arrivages } from './Arrivages';
import { useSession } from '@/app/session';
import { formaterDate, useChargement } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Journal des mouvements de stock (§6).
 *
 * C'est la mémoire du logiciel, et elle est en LECTURE SEULE : aucun bouton ne
 * permet de modifier ou de supprimer une ligne. Une correction s'écrit en
 * ajoutant un mouvement inverse, jamais en effaçant celui qui gêne.
 *
 * DEUX LECTURES DU MÊME JOURNAL, et il en fallait deux. Le détail répond à
 * « qu'est-il arrivé à cet article ? ». Les ARRIVAGES répondent à « qu'est-ce
 * qui est entré le 12 mars ? » — question à laquelle le détail ne répond pas,
 * puisqu'un import de deux cents téléphones y occupe deux cents lignes et
 * qu'on ne voit plus la livraison, seulement ses grains.
 */
export function Mouvements() {
  const { db, shopId } = useSession();
  const [vue, setVue] = useState<'arrivages' | 'detail'>('arrivages');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const limite = 100;

  const periode = usePeriode('30');
  const bornes = periode.bornes;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new StockRepository(db).list({
      shopId,
      type: type ? (type as MovementType) : null,
      from: bornes.from,
      to: bornes.to,
      limit: limite,
      offset,
    });
  }, [db, shopId, type, bornes.from, bornes.to, offset]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('mouvements'),
      toCsv(etat.donnees.items, [
        { header: 'Date', value: (l) => formaterDate(l.occurredAt, true) },
        { header: 'Type', value: (l) => MOVEMENT_LABELS[l.type] ?? l.type },
        { header: 'Produit', value: (l) => l.productName },
        { header: 'SKU', value: (l) => l.productSku },
        { header: 'Identifiant', value: (l) => l.identifier ?? '' },
        { header: 'Quantité', value: (l) => l.quantity },
        { header: 'Document', value: (l) => l.sourceLabel ?? '' },
        { header: 'Utilisateur', value: (l) => l.userLabel ?? '' },
        { header: 'Note', value: (l) => l.note ?? '' },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Mouvements de stock"
        sousTitre="Chaque entrée et chaque sortie, sans exception. Journal en lecture seule."
        actions={
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees}>
            Exporter
          </Bouton>
        }
      />

      <Onglets
        valeur={vue}
        onChanger={(valeur) => {
          setVue(valeur as 'arrivages' | 'detail');
          setOffset(0);
        }}
        onglets={[
          { valeur: 'arrivages', libelle: 'Arrivages' },
          { valeur: 'detail', libelle: 'Détail des mouvements' },
        ]}
      />

      {vue === 'arrivages' ? <Arrivages periode={periode} /> : null}

      <Carte compact className={vue === 'detail' ? 'min-h-0 flex-1' : 'hidden'}>
        <BarreFiltres>
          <ChoixPeriode etat={periode} />
          <ListeFiltre
            valeur={type}
            onChanger={(valeur) => {
              setType(valeur);
              setOffset(0);
            }}
            vide="Tous les types"
            options={valuesOf(MOVEMENT_TYPE).map((valeur) => ({
              valeur,
              libelle: MOVEMENT_LABELS[valeur],
            }))}
          />
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees?.items ?? []}
            cleDe={(ligne) => ligne.id}
            vide={{ icone: 'mouvement', titre: 'Aucun mouvement sur cette période' }}
            colonnes={[
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.occurredAt, true) },
              {
                cle: 'type',
                titre: 'Type',
                rendu: (l) => (
                  <Badge ton={l.quantity > 0 ? 'succes' : 'neutre'}>
                    {MOVEMENT_LABELS[l.type] ?? l.type}
                  </Badge>
                ),
              },
              {
                cle: 'produit',
                titre: 'Produit',
                rendu: (l) => (
                  <div>
                    <div>{l.productName}</div>
                    <div className="mono text-xs text-encre-500">{l.productSku}</div>
                  </div>
                ),
              },
              {
                cle: 'identifiant',
                titre: 'Identifiant',
                rendu: (l) => <span className="mono">{l.identifier ?? '—'}</span>,
              },
              {
                cle: 'quantite',
                titre: 'Qté',
                num: true,
                rendu: (l) => (
                  <span className={l.quantity > 0 ? 'text-succes-700' : 'text-danger-700'}>
                    {l.quantity > 0 ? `+${l.quantity}` : l.quantity}
                  </span>
                ),
              },
              {
                cle: 'document',
                titre: 'Document',
                rendu: (l) => <span className="mono">{l.sourceLabel ?? '—'}</span>,
              },
              { cle: 'utilisateur', titre: 'Par', rendu: (l) => l.userLabel ?? '—' },
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
