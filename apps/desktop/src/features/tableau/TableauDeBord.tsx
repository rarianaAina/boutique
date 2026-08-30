import { PERMISSIONS } from '@boutique/shared';
import { useMemo } from 'react';
import { ReportService } from '@/core/services/report.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { CarteChiffre, Carte, Chargement, EnTetePage, Erreur, Vide } from '@/components/ui/Page';
import { Badge, BadgeTransfert, BadgeVente } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { formaterDate, useChargement, useMonnaie } from '@/app/hooks';

/**
 * Tableau de bord (§25).
 *
 * Il répond à UNE question : « que se passe-t-il dans ma boutique ? ». Les
 * chiffres d'abord, l'opérationnel ensuite — derniers tickets, derniers
 * mouvements, transferts en cours, alertes. Pas de graphique : à l'ouverture,
 * on veut savoir ce qu'on a vendu et ce qui manque, pas contempler une courbe.
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

  const etat = useChargement(async () => {
    if (!db || !rapport) throw new Error('Base indisponible.');
    const [chiffres, tickets, mouvements, transferts] = await Promise.all([
      rapport.dashboard(settings.lowStockThreshold),
      new SaleRepository(db).list({ shopId, limit: 8 }),
      new StockRepository(db).list({ shopId, limit: 8 }),
      new TransferRepository(db).list({ shopId, direction: 'both', limit: 6 }),
    ]);
    return { chiffres, tickets, mouvements, transferts };
  }, [db, rapport, shopId, settings.lowStockThreshold]);

  if (etat.erreur) return <Erreur message={etat.erreur} />;
  if (etat.chargement || !etat.donnees) return <Chargement />;

  const { chiffres, tickets, mouvements, transferts } = etat.donnees;
  const heure = new Date().getHours();
  const salutation = heure < 12 ? 'Bonjour' : heure < 18 ? 'Bon après-midi' : 'Bonsoir';

  return (
    <div className="space-y-4">
      <EnTetePage
        titre={`${salutation}, ${session?.fullName.split(' ')[0] ?? ''}`}
        sousTitre={`Activité du ${formaterDate(new Date().toISOString())}`}
        actions={
          peut(PERMISSIONS.saleCreate) ? (
            <Bouton variante="principal" icone="caisse" onClick={() => aller('caisse')}>
              Nouvelle vente
            </Bouton>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CarteChiffre
          libelle="Chiffre d'affaires du jour"
          valeur={monnaie(chiffres.revenueToday)}
          detail={`${chiffres.salesToday} vente${chiffres.salesToday > 1 ? 's' : ''} · panier moyen ${monnaie(chiffres.averageBasket)}`}
          icone="caisse"
        />
        {voitLesCouts ? (
          <CarteChiffre
            libelle="Marge du jour"
            valeur={monnaie(chiffres.marginToday)}
            detail={`Mois : ${monnaie(chiffres.marginMonth)}`}
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
          libelle="Stock"
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
      </div>

      {(chiffres.pendingTransfersIn > 0 ||
        chiffres.pendingSyncEvents > 0 ||
        chiffres.syncConflicts > 0 ||
        chiffres.refundsToday > 0) && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {chiffres.pendingTransfersIn > 0 ? (
            <CarteChiffre
              libelle="Transferts à réceptionner"
              valeur={chiffres.pendingTransfersIn}
              icone="camion"
              ton="attente"
            />
          ) : null}
          {chiffres.pendingTransfersOut > 0 ? (
            <CarteChiffre
              libelle="Transferts en cours d'envoi"
              valeur={chiffres.pendingTransfersOut}
              icone="camion"
            />
          ) : null}
          {chiffres.pendingSyncEvents > 0 ? (
            <CarteChiffre
              libelle="À synchroniser"
              valeur={chiffres.pendingSyncEvents}
              detail="opérations en attente"
              icone="synchro"
              ton="attente"
            />
          ) : null}
          {chiffres.syncConflicts > 0 ? (
            <CarteChiffre
              libelle="Conflits de synchronisation"
              valeur={chiffres.syncConflicts}
              detail="à arbitrer"
              icone="alerte"
              ton="danger"
            />
          ) : null}
          {chiffres.refundsToday > 0 ? (
            <CarteChiffre
              libelle="Remboursements du jour"
              valeur={monnaie(chiffres.refundsToday)}
              icone="retour"
            />
          ) : null}
        </div>
      )}

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
