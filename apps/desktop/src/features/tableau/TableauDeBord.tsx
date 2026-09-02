import { PERMISSIONS } from '@boutique/shared';
import { useMemo } from 'react';
import { ReportService } from '@/core/services/report.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { CarteChiffre, Carte, Chargement, EnTetePage, Erreur, Vide } from '@/components/ui/Page';
import { Badge, BadgeTransfert, BadgeVente } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Barres } from '@/components/ui/Barres';
import { BarreFiltres } from '@/components/ui/Tableau';
import { ChoixPeriode, usePeriode } from '@/components/ui/Periode';
import { useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { formaterDate, useChargement, useMonnaie } from '@/app/hooks';

/**
 * Tableau de bord (§25).
 *
 * Il répond à UNE question : « que se passe-t-il dans ma boutique ? ». Les
 * chiffres d'abord, l'opérationnel ensuite — derniers tickets, derniers
 * mouvements, transferts en cours, alertes.
 *
 * LA PÉRIODE SE CHOISIT. Elle était figée sur la journée en cours, ce qui rend
 * l'écran muet le lundi matin : le gérant veut voir le week-end, pas une
 * journée qui commence. Ce qui décrit l'ÉTAT PRÉSENT — stock, alertes,
 * transferts en cours, file de synchronisation — ne bouge pas avec elle, et
 * reste toujours au même endroit.
 *
 * UNE COURBE, ET UNE SEULE. Ce fichier portait la mention « pas de graphique ».
 * C'était juste tant que l'écran n'affichait qu'une journée ; sur trente jours,
 * une colonne de trente nombres ne se lit pas, alors que le rythme de la
 * semaine saute aux yeux en forme. Les montants exacts restent affichés à
 * côté : la forme s'ajoute aux chiffres, elle ne les remplace pas.
 *
 * LE CONTENU DÉPEND DU RÔLE : un vendeur ne voit ni marge ni valeur de stock,
 * parce qu'il n'a pas la permission de consulter les coûts. Ce n'est pas une
 * mise en forme conditionnelle, c'est la même règle que côté service.
 */
export function TableauDeBord() {
  const { db, shopId, settings, session, peut } = useSession();
  const { aller } = useNavigation();
  const monnaie = useMonnaie();
  const voitLesCouts = peut(PERMISSIONS.costView);

  const rapport = useMemo(() => (db ? new ReportService(db, shopId) : null), [db, shopId]);

  const periode = usePeriode('jour');
  const bornes = periode.bornes;

  const etat = useChargement(async () => {
    if (!db || !rapport) throw new Error('Base indisponible.');
    const [chiffres, tickets, mouvements, transferts] = await Promise.all([
      rapport.dashboard(settings.lowStockThreshold, {
        // « Depuis le début » n'a pas de sens pour un tableau de bord : sans
        // borne, la moyenne d'un an écrase ce qui se passe cette semaine.
        from: bornes.from ?? '1970-01-01T00:00:00.000Z',
        to: bornes.to ?? new Date(Date.now() + 86_400_000).toISOString(),
      }),
      new SaleRepository(db).list({ shopId, limit: 8 }),
      new StockRepository(db).list({ shopId, limit: 8 }),
      new TransferRepository(db).list({ shopId, direction: 'both', limit: 6 }),
    ]);
    return { chiffres, tickets, mouvements, transferts };
  }, [db, rapport, shopId, settings.lowStockThreshold, bornes.from, bornes.to]);

  if (etat.erreur) return <Erreur message={etat.erreur} />;
  if (etat.chargement || !etat.donnees) return <Chargement />;

  const { chiffres, tickets, mouvements, transferts } = etat.donnees;
  const heure = new Date().getHours();
  const salutation = heure < 12 ? 'Bonjour' : heure < 18 ? 'Bon après-midi' : 'Bonsoir';

  return (
    <div className="space-y-4">
      <EnTetePage
        titre={`${salutation}, ${session?.fullName.split(' ')[0] ?? ''}`}
        sousTitre={`Activité ${periode.libelle}`}
        actions={
          peut(PERMISSIONS.saleCreate) ? (
            <Bouton variante="principal" icone="caisse" onClick={() => aller('caisse')}>
              Nouvelle vente
            </Bouton>
          ) : null
        }
      />

      <Carte compact>
        <BarreFiltres>
          <ChoixPeriode etat={periode} />
        </BarreFiltres>
      </Carte>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:grid-cols-4">
        <CarteChiffre
          libelle="Chiffre d'affaires"
          valeur={monnaie(chiffres.revenueToday)}
          detail={`${chiffres.salesToday} vente${chiffres.salesToday > 1 ? 's' : ''} · panier moyen ${monnaie(chiffres.averageBasket)}`}
          icone="caisse"
        />
        {voitLesCouts ? (
          <CarteChiffre
            libelle="Marge"
            valeur={monnaie(chiffres.marginToday)}
            detail={`Mois en cours : ${monnaie(chiffres.marginMonth)}`}
            icone="rapport"
            ton="succes"
          />
        ) : (
          <CarteChiffre
            libelle="Chiffre d'affaires du mois"
            valeur={monnaie(chiffres.revenueMonth)}
            icone="rapport"
          />
        )}
        <CarteChiffre
          libelle="Entrées en stock"
          valeur={chiffres.arrivalsUnits.toLocaleString('fr-FR')}
          detail={
            voitLesCouts && chiffres.arrivalsCost > 0
              ? `${monnaie(chiffres.arrivalsCost)} de marchandise reçue`
              : 'pièces reçues sur la période'
          }
          icone="camion"
        />
        <CarteChiffre
          libelle="Remboursements"
          valeur={monnaie(chiffres.refundsToday)}
          detail="sur la période"
          icone="retour"
          ton={chiffres.refundsToday > 0 ? 'attente' : 'neutre'}
        />
      </div>

      <Carte titre="Chiffre d'affaires jour par jour" compact>
        <div className="px-3 pb-2 pt-3">
          <Barres
            donnees={chiffres.byDay.map((jour) => ({
              cle: jour.day,
              valeur: jour.revenue,
              infobulle: `${jour.day} — ${monnaie(jour.revenue)} · ${jour.sales} vente${
                jour.sales > 1 ? 's' : ''
              }`,
            }))}
            vide="Aucune vente sur cette période."
          />
        </div>
      </Carte>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:grid-cols-4">
        <CarteChiffre
          libelle="Stock détenu"
          valeur={chiffres.stockUnits.toLocaleString('fr-FR')}
          detail={voitLesCouts ? `Valeur : ${monnaie(chiffres.stockValue)}` : 'articles détenus'}
          icone="boite"
        />
        <CarteChiffre
          libelle="Stock faible"
          valeur={chiffres.lowStockCount}
          detail="produits sous leur seuil"
          icone="alerte"
          ton={chiffres.lowStockCount > 0 ? 'attente' : 'neutre'}
        />
        <CarteChiffre
          libelle="Transferts à réceptionner"
          valeur={chiffres.pendingTransfersIn}
          detail="colis en attente ici"
          icone="camion"
          ton={chiffres.pendingTransfersIn > 0 ? 'attente' : 'neutre'}
        />
        <CarteChiffre
          libelle="À synchroniser"
          valeur={chiffres.pendingSyncEvents}
          detail={
            chiffres.syncConflicts > 0
              ? `${chiffres.syncConflicts} conflit(s) à arbitrer`
              : 'opérations en attente'
          }
          icone="synchro"
          ton={
            chiffres.syncConflicts > 0
              ? 'danger'
              : chiffres.pendingSyncEvents > 0
                ? 'attente'
                : 'neutre'
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Carte
          titre="Derniers tickets"
          compact
          actions={
            <Bouton taille="petit" variante="discret" onClick={() => aller('tickets')}>
              Tout voir
            </Bouton>
          }
        >
          {tickets.items.length === 0 ? (
            <Vide icone="ticket" titre="Aucune vente aujourd'hui" />
          ) : (
            <table className="tableau">
              <tbody>
                {tickets.items.map((ticket) => (
                  <tr key={ticket.id} data-clickable="" onClick={() => aller('tickets', ticket.id)}>
                    <td className="mono">{ticket.number}</td>
                    <td className="text-encre-500">{formaterDate(ticket.soldAt, true)}</td>
                    <td className="truncate">{ticket.customerLabel ?? '—'}</td>
                    <td>
                      <BadgeVente statut={ticket.status} />
                    </td>
                    <td className="num font-medium">{monnaie(ticket.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Carte>

        <Carte
          titre="Derniers mouvements de stock"
          compact
          actions={
            <Bouton taille="petit" variante="discret" onClick={() => aller('mouvements')}>
              Tout voir
            </Bouton>
          }
        >
          {mouvements.items.length === 0 ? (
            <Vide icone="mouvement" titre="Aucun mouvement récent" />
          ) : (
            <table className="tableau">
              <tbody>
                {mouvements.items.map((mouvement) => (
                  <tr key={mouvement.id}>
                    <td className="text-encre-500">{formaterDate(mouvement.occurredAt, true)}</td>
                    <td className="truncate">{mouvement.productName}</td>
                    <td className="mono text-encre-500">{mouvement.identifier ?? ''}</td>
                    <td>
                      <Badge ton={mouvement.quantity > 0 ? 'succes' : 'neutre'}>
                        {mouvement.type}
                      </Badge>
                    </td>
                    <td className="num font-medium">
                      {mouvement.quantity > 0 ? `+${mouvement.quantity}` : mouvement.quantity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Carte>
      </div>

      {transferts.items.length > 0 ? (
        <Carte
          titre="Transferts"
          compact
          actions={
            <Bouton taille="petit" variante="discret" onClick={() => aller('transferts')}>
              Tout voir
            </Bouton>
          }
        >
          <table className="tableau">
            <tbody>
              {transferts.items.map((transfert) => (
                <tr
                  key={transfert.id}
                  data-clickable=""
                  onClick={() => aller('transferts', transfert.id)}
                >
                  <td className="mono">{transfert.number}</td>
                  <td>{transfert.fromShopId === shopId ? 'Envoi' : 'Réception'}</td>
                  <td className="text-encre-500">{formaterDate(transfert.requestedAt)}</td>
                  <td className="num">{transfert.itemCount}</td>
                  <td>
                    <BadgeTransfert statut={transfert.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Carte>
      ) : null}
    </div>
  );
}
