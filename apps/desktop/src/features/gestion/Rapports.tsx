import { useState } from 'react';
import {
  MOVEMENT_LABELS,
  PERMISSIONS,
  TRANSFER_LABELS,
  addDays,
  localDay,
  periodRange,
  startOfMonth,
} from '@boutique/shared';
import type { MovementType, TransferStatus } from '@boutique/shared';
import { ReportService, type TransferSummaryRow } from '@/core/services/report.service';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import { Carte, CarteChiffre, Chargement, EnTetePage, Erreur } from '@/components/ui/Page';
import { Bouton } from '@/components/ui/Bouton';
import { BarreFiltres, ListeFiltre, Tableau } from '@/components/ui/Tableau';
import { Champ } from '@/components/ui/Champ';
import { useSession } from '@/app/session';
import { useChargement, useMonnaie } from '@/app/hooks';
import { telecharger } from './telechargement';

/**
 * Rapports (§22).
 *
 * Des CHIFFRES et des TABLEAUX, pas de graphiques : un gérant qui ouvre cet
 * écran veut des montants qu'il peut recopier, comparer et exporter. Une courbe
 * décorative occupe la place de trois colonnes utiles.
 *
 * La marge est calculée à partir du coût figé sur chaque ligne de vente, pas du
 * prix d'achat courant : c'est la seule marge qui ne change pas quand un
 * fournisseur augmente ses tarifs.
 */
const PERIODES = [
  { valeur: 'jour', libelle: "Aujourd'hui" },
  { valeur: '7', libelle: '7 derniers jours' },
  { valeur: '30', libelle: '30 derniers jours' },
  { valeur: 'mois', libelle: 'Mois en cours' },
  { valeur: '90', libelle: '90 derniers jours' },
  { valeur: 'perso', libelle: 'Période personnalisée' },
];

export function Rapports() {
  const { db, shopId, peut } = useSession();
  const monnaie = useMonnaie();
  const [choix, setChoix] = useState('30');
  const [debut, setDebut] = useState(addDays(localDay(), -30));
  const [fin, setFin] = useState(localDay());
  const voitLesCouts = peut(PERMISSIONS.costView);

  const bornes = (() => {
    const aujourdhui = localDay();
    if (choix === 'jour') return periodRange(aujourdhui, aujourdhui);
    if (choix === 'mois') return periodRange(startOfMonth(), aujourdhui);
    if (choix === 'perso') return periodRange(debut, fin);
    return periodRange(addDays(aujourdhui, -Number(choix)), aujourdhui);
  })();

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    const rapport = new ReportService(db, shopId);
    const [
      totaux,
      parJour,
      produits,
      vendeurs,
      paiements,
      remboursements,
      achats,
      mouvements,
      echanges,
      transferts,
    ] = await Promise.all([
      rapport.salesTotals(bornes),
      rapport.salesByDay(bornes),
      rapport.topProducts(bornes, 20),
      rapport.salesBySeller(bornes),
      rapport.paymentBreakdown(bornes),
      rapport.refundTotal(bornes),
      rapport.purchaseTotals(bornes),
      rapport.movementsByType(bornes),
      rapport.exchangeCount(bornes),
      rapport.transferSummary(bornes),
    ]);
    return {
      totaux,
      parJour,
      produits,
      vendeurs,
      paiements,
      remboursements,
      achats,
      mouvements,
      echanges,
      transferts,
    };
  }, [db, shopId, bornes.from, bornes.to]);

  const { settings } = useSession();

  const exporterVentes = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('rapport-ventes'),
      toCsv(etat.donnees.parJour, [
        { header: 'Jour', value: (l) => l.day },
        { header: 'Ventes', value: (l) => l.sales },
        { header: "Chiffre d'affaires", value: (l) => csvMoney(l.revenue, settings.currency) },
        { header: 'Remises', value: (l) => csvMoney(l.discount, settings.currency) },
        ...(voitLesCouts
          ? [
              {
                header: 'Marge',
                value: (l: (typeof etat.donnees.parJour)[number]) =>
                  csvMoney(l.margin, settings.currency),
              },
            ]
          : []),
      ]),
    );
  };

  return (
    <div className="space-y-4">
      <EnTetePage
        titre="Rapports"
        actions={
          <Bouton icone="export" onClick={exporterVentes} disabled={!etat.donnees}>
            Exporter les ventes
          </Bouton>
        }
      />

      <Carte compact>
        <BarreFiltres>
          <ListeFiltre valeur={choix} onChanger={setChoix} options={PERIODES} />
          {choix === 'perso' ? (
            <>
              <Champ
                label="Du"
                type="date"
                value={debut}
                onChange={(evenement) => setDebut(evenement.target.value)}
              />
              <Champ
                label="Au"
                type="date"
                value={fin}
                onChange={(evenement) => setFin(evenement.target.value)}
              />
            </>
          ) : null}
        </BarreFiltres>
      </Carte>

      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : etat.donnees ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CarteChiffre
              libelle="Chiffre d'affaires"
              valeur={monnaie(etat.donnees.totaux.revenue)}
              detail={`${etat.donnees.totaux.count} vente(s)`}
              icone="caisse"
            />
            {voitLesCouts ? (
              <CarteChiffre
                libelle="Marge"
                valeur={monnaie(etat.donnees.totaux.margin)}
                detail={
                  etat.donnees.totaux.revenue > 0
                    ? `${Math.round((etat.donnees.totaux.margin / etat.donnees.totaux.revenue) * 100)} % du CA`
                    : undefined
                }
                icone="rapport"
                ton="succes"
              />
            ) : null}
            <CarteChiffre
              libelle="Remises accordées"
              valeur={monnaie(etat.donnees.totaux.discount)}
              icone="ticket"
            />
            <CarteChiffre
              libelle="Remboursements"
              valeur={monnaie(etat.donnees.remboursements)}
              detail={`${etat.donnees.echanges} échange(s)`}
              icone="retour"
              ton={etat.donnees.remboursements > 0 ? 'attente' : 'neutre'}
            />
            <CarteChiffre
              libelle="Achats"
              valeur={monnaie(etat.donnees.achats.total)}
              detail={`dont ${monnaie(etat.donnees.achats.landed)} de frais`}
              icone="achat"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Carte titre="Ventes par jour" compact>
              <Tableau
                lignes={etat.donnees.parJour}
                cleDe={(ligne) => ligne.day}
                vide={{ titre: 'Aucune vente sur la période' }}
                colonnes={[
                  { cle: 'jour', titre: 'Jour', rendu: (l) => l.day },
                  { cle: 'ventes', titre: 'Ventes', num: true, rendu: (l) => l.sales },
                  {
                    cle: 'ca',
                    titre: "Chiffre d'affaires",
                    num: true,
                    rendu: (l) => monnaie(l.revenue),
                  },
                  ...(voitLesCouts
                    ? [
                        {
                          cle: 'marge',
                          titre: 'Marge',
                          num: true,
                          rendu: (l: (typeof etat.donnees.parJour)[number]) => monnaie(l.margin),
                        },
                      ]
                    : []),
                ]}
              />
            </Carte>

            <Carte titre="Meilleures ventes" compact>
              <Tableau
                lignes={etat.donnees.produits}
                cleDe={(ligne) => ligne.productId}
                vide={{ titre: 'Aucun produit vendu' }}
                colonnes={[
                  { cle: 'produit', titre: 'Produit', rendu: (l) => l.name },
                  { cle: 'qte', titre: 'Qté', num: true, rendu: (l) => l.quantity },
                  { cle: 'ca', titre: 'CA', num: true, rendu: (l) => monnaie(l.revenue) },
                  ...(voitLesCouts
                    ? [
                        {
                          cle: 'marge',
                          titre: 'Marge',
                          num: true,
                          rendu: (l: (typeof etat.donnees.produits)[number]) => monnaie(l.margin),
                        },
                      ]
                    : []),
                ]}
              />
            </Carte>

            <Carte titre="Ventes par vendeur" compact>
              <Tableau
                lignes={etat.donnees.vendeurs}
                cleDe={(ligne) => ligne.userId}
                vide={{ titre: 'Aucune vente' }}
                colonnes={[
                  { cle: 'nom', titre: 'Vendeur', rendu: (l) => l.name },
                  { cle: 'ventes', titre: 'Ventes', num: true, rendu: (l) => l.sales },
                  {
                    cle: 'ca',
                    titre: "Chiffre d'affaires",
                    num: true,
                    rendu: (l) => monnaie(l.revenue),
                  },
                ]}
              />
            </Carte>

            <Carte titre="Encaissements par mode" compact>
              <Tableau
                lignes={etat.donnees.paiements}
                cleDe={(ligne) => ligne.method}
                vide={{ titre: 'Aucun encaissement' }}
                colonnes={[
                  { cle: 'mode', titre: 'Mode', rendu: (l) => l.label },
                  { cle: 'montant', titre: 'Montant', num: true, rendu: (l) => monnaie(l.amount) },
                ]}
              />
            </Carte>

            <Carte titre="Transferts" compact>
              <Tableau<TransferSummaryRow>
                lignes={etat.donnees.transferts}
                cleDe={(ligne) => `${ligne.direction}-${ligne.status}`}
                vide={{ titre: 'Aucun transfert sur la période' }}
                colonnes={[
                  {
                    cle: 'sens',
                    titre: 'Sens',
                    rendu: (l) => (l.direction === 'ENVOI' ? 'Envois' : 'Réceptions'),
                  },
                  {
                    cle: 'statut',
                    titre: 'Statut',
                    rendu: (l) => TRANSFER_LABELS[l.status as TransferStatus] ?? l.status,
                  },
                  { cle: 'nombre', titre: 'Transferts', num: true, rendu: (l) => l.transfers },
                  { cle: 'articles', titre: 'Articles', num: true, rendu: (l) => l.items },
                ]}
              />
            </Carte>

            <Carte titre="Mouvements de stock" compact className="lg:col-span-2">
              <Tableau
                lignes={etat.donnees.mouvements}
                cleDe={(ligne) => ligne.type}
                vide={{ titre: 'Aucun mouvement' }}
                colonnes={[
                  {
                    cle: 'type',
                    titre: 'Type',
                    rendu: (l) => MOVEMENT_LABELS[l.type as MovementType] ?? l.type,
                  },
                  { cle: 'nombre', titre: 'Écritures', num: true, rendu: (l) => l.entries },
                  {
                    cle: 'quantite',
                    titre: 'Quantité nette',
                    num: true,
                    rendu: (l) => (l.quantity > 0 ? `+${l.quantity}` : l.quantity),
                  },
                ]}
              />
            </Carte>
          </div>
        </>
      ) : null}
    </div>
  );
}
