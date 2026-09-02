import { useState } from 'react';
import { MOVEMENT_LABELS } from '@boutique/shared';
import {
  StockRepository,
  type ArrivalGroup,
  type MovementListItem,
} from '@/core/db/repositories/stock.repository';
import { exportFileName, toCsv } from '@/core/services/export.service';
import { Carte, Chargement, Erreur, Vide } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { BarreFiltres, ListeFiltre, Tableau } from '@/components/ui/Tableau';
import { ChoixPeriode, type EtatPeriode } from '@/components/ui/Periode';
import { useSession } from '@/app/session';
import { formaterDate, useChargement, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Ce qui est entré en stock, et quand.
 *
 * LA QUESTION À LAQUELLE CET ÉCRAN RÉPOND : « qu'est-ce qui est arrivé le
 * 12 mars ? ». Le journal des mouvements ne la traite pas — un import de deux
 * cents téléphones y occupe deux cents lignes, et la livraison disparaît
 * derrière ses grains.
 *
 * Un arrivage se lit d'un coup : sa date, son origine, combien de références,
 * combien de pièces, combien d'appareils identifiés, et ce qu'il a coûté. On
 * l'ouvre pour voir le détail, IMEI compris — c'est ce qu'on fait quand un
 * client rapporte un téléphone et qu'il faut retrouver d'où il vient.
 */

const ORIGINES: Record<string, { libelle: string; ton: 'info' | 'succes' | 'neutre' }> = {
  IMPORT: { libelle: 'Import de fichier', ton: 'info' },
  PURCHASE: { libelle: 'Réception de commande', ton: 'succes' },
  TRANSFER: { libelle: 'Transfert reçu', ton: 'info' },
  INVENTORY: { libelle: 'Correction d’inventaire', ton: 'neutre' },
  MANUAL: { libelle: 'Saisie manuelle', ton: 'neutre' },
  REFUND: { libelle: 'Retour client', ton: 'neutre' },
  EXCHANGE: { libelle: 'Échange', ton: 'neutre' },
  SALE: { libelle: 'Annulation de vente', ton: 'neutre' },
};

export function Arrivages({ periode }: { periode: EtatPeriode }) {
  const { db, shopId } = useSession();
  const monnaie = useMonnaie();
  const [origine, setOrigine] = useState('');
  const [ouvert, setOuvert] = useState<ArrivalGroup | null>(null);

  const bornes = periode.bornes;
  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new StockRepository(db).arrivals({
      shopId,
      source: origine || null,
      from: bornes.from,
      to: bornes.to,
    });
  }, [db, shopId, origine, bornes.from, bornes.to]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('arrivages'),
      toCsv(etat.donnees, [
        { header: 'Jour', value: (l) => l.day },
        { header: 'Origine', value: (l) => ORIGINES[l.source]?.libelle ?? l.source },
        { header: 'Document', value: (l) => l.label ?? '' },
        { header: 'Références', value: (l) => l.products },
        { header: 'Pièces', value: (l) => l.units },
        { header: 'Appareils identifiés', value: (l) => l.identified },
        { header: 'Coût total', value: (l) => l.cost },
        { header: 'Par', value: (l) => l.userLabel ?? '' },
      ]),
    );
  };

  return (
    <>
      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ChoixPeriode etat={periode} />
          <ListeFiltre
            valeur={origine}
            onChanger={setOrigine}
            vide="Toutes les origines"
            options={Object.entries(ORIGINES).map(([valeur, description]) => ({
              valeur,
              libelle: description.libelle,
            }))}
          />
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees?.length}>
            Exporter
          </Bouton>
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees ?? []}
            cleDe={(ligne) => `${ligne.day}-${ligne.source}-${ligne.sourceId ?? ''}`}
            onLigneCliquee={(ligne) => setOuvert(ligne)}
            vide={{
              icone: 'camion',
              titre: 'Aucune entrée sur cette période',
              detail: 'Élargissez la période, ou choisissez des dates exactes.',
            }}
            colonnes={[
              {
                cle: 'jour',
                titre: 'Jour',
                rendu: (l) => (
                  <div>
                    <div className="font-medium text-encre-900">{l.day}</div>
                    <div className="text-xs text-encre-500">{formaterDate(l.lastAt, true)}</div>
                  </div>
                ),
              },
              {
                cle: 'origine',
                titre: 'Origine',
                rendu: (l) => (
                  <Badge ton={ORIGINES[l.source]?.ton ?? 'neutre'}>
                    {ORIGINES[l.source]?.libelle ?? l.source}
                  </Badge>
                ),
              },
              {
                cle: 'document',
                titre: 'Document',
                rendu: (l) => (
                  <span className="text-encre-700">{l.label ?? <em>sans référence</em>}</span>
                ),
              },
              { cle: 'refs', titre: 'Références', num: true, rendu: (l) => l.products },
              { cle: 'pieces', titre: 'Pièces', num: true, rendu: (l) => l.units },
              {
                cle: 'identifies',
                titre: 'Dont identifiés',
                num: true,
                rendu: (l) =>
                  l.identified > 0 ? (
                    <Badge ton="info">{l.identified}</Badge>
                  ) : (
                    <span className="text-encre-400">—</span>
                  ),
              },
              {
                cle: 'cout',
                titre: 'Coût total',
                num: true,
                // Un coût nul n'est pas « zéro » mais « inconnu » : beaucoup
                // d'entrées se font sans prix d'achat renseigné, et afficher
                // 0 Ar ferait croire à de la marchandise gratuite.
                rendu: (l) =>
                  l.cost > 0 ? monnaie(l.cost) : <span className="text-encre-400">—</span>,
              },
              { cle: 'par', titre: 'Par', rendu: (l) => l.userLabel ?? '—' },
            ]}
          />
        )}
      </Carte>

      {ouvert ? <DetailArrivage arrivage={ouvert} onFermer={() => setOuvert(null)} /> : null}
    </>
  );
}

/**
 * Le détail d'une livraison, ligne par ligne.
 *
 * Les appareils identifiés y figurent avec leur IMEI : c'est ce qu'on vient
 * chercher quand un client rapporte un téléphone et qu'il faut savoir de quel
 * arrivage il vient, à quel coût, et par qui il a été saisi.
 */
function DetailArrivage({ arrivage, onFermer }: { arrivage: ArrivalGroup; onFermer: () => void }) {
  const { db } = useSession();
  const monnaie = useMonnaie();

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new StockRepository(db).arrivalDetail(arrivage.source, arrivage.sourceId, arrivage.day);
  }, [db, arrivage.source, arrivage.sourceId, arrivage.day]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName(`arrivage-${arrivage.day}`),
      toCsv(etat.donnees, [
        { header: 'Produit', value: (l) => l.productName },
        { header: 'SKU', value: (l) => l.productSku },
        { header: 'Identifiant', value: (l) => l.identifier ?? '' },
        { header: 'Quantité', value: (l) => l.quantity },
        { header: 'Coût unitaire', value: (l) => l.unitCost ?? '' },
        { header: 'Type', value: (l) => MOVEMENT_LABELS[l.type] ?? l.type },
        { header: 'Reçu le', value: (l) => l.occurredAt },
      ]),
    );
  };

  return (
    <Dialogue
      ouvert
      onFermer={onFermer}
      largeur="xl"
      titre={`Arrivage du ${arrivage.day} — ${ORIGINES[arrivage.source]?.libelle ?? arrivage.source}`}
      pied={
        <>
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees?.length}>
            Exporter le détail
          </Bouton>
          <Bouton variante="principal" onClick={onFermer}>
            Fermer
          </Bouton>
        </>
      }
    >
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Chiffre libelle="Document" valeur={arrivage.label ?? '—'} />
        <Chiffre libelle="Références" valeur={String(arrivage.products)} />
        <Chiffre libelle="Pièces" valeur={String(arrivage.units)} />
        <Chiffre
          libelle="Coût total"
          valeur={arrivage.cost > 0 ? monnaie(arrivage.cost) : 'inconnu'}
        />
      </div>

      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : (etat.donnees?.length ?? 0) === 0 ? (
        <Vide icone="camion" titre="Aucune ligne" />
      ) : (
        <Tableau
          lignes={etat.donnees ?? []}
          cleDe={(ligne) => ligne.id}
          colonnes={colonnesDetail(monnaie)}
        />
      )}
    </Dialogue>
  );
}

function colonnesDetail(monnaie: (valeur: number) => string) {
  return [
    {
      cle: 'produit',
      titre: 'Produit',
      rendu: (l: MovementListItem) => (
        <div>
          <div className="font-medium text-encre-900">{l.productName}</div>
          <div className="mono text-xs text-encre-500">{l.productSku}</div>
        </div>
      ),
    },
    {
      cle: 'identifiant',
      titre: 'IMEI / Série',
      rendu: (l: MovementListItem) =>
        l.identifier ? (
          <span className="mono text-encre-700">{l.identifier}</span>
        ) : (
          <span className="text-encre-400">—</span>
        ),
    },
    { cle: 'quantite', titre: 'Quantité', num: true, rendu: (l: MovementListItem) => l.quantity },
    {
      cle: 'cout',
      titre: 'Coût unitaire',
      num: true,
      rendu: (l: MovementListItem) =>
        l.unitCost && l.unitCost > 0 ? (
          monnaie(l.unitCost)
        ) : (
          <span className="text-encre-400">—</span>
        ),
    },
    {
      cle: 'heure',
      titre: 'Reçu le',
      rendu: (l: MovementListItem) => formaterDate(l.occurredAt, true),
    },
  ];
}

function Chiffre({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="rounded-md border border-encre-200 bg-encre-50 px-3 py-2">
      <div className="text-xs text-encre-500">{libelle}</div>
      <div className="truncate font-medium text-encre-900">{valeur}</div>
    </div>
  );
}
