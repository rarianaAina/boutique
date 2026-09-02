import { useState } from 'react';
import { PERMISSIONS, SALE_LABELS, valuesOf, SALE_STATUS } from '@boutique/shared';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { RefundRepository, ExchangeRepository } from '@/core/db/repositories/refund.repository';
import { InvoiceRepository } from '@/core/db/repositories/invoice.repository';
import { SaleService } from '@/core/services/sale.service';
import { InvoiceService } from '@/core/services/invoice.service';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { BadgeVente, Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue, Confirmation } from '@/components/ui/Dialogue';
import {
  BarreFiltres,
  ChampRecherche,
  ListeFiltre,
  Pagination,
  Tableau,
} from '@/components/ui/Tableau';
import { ZoneTexte } from '@/components/ui/Champ';
import { useNotifications } from '@/components/ui/Notifications';
import { TicketImprimable } from '@/features/caisse/TicketImprimable';
import { useContexte, useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { formaterDate, messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Historique des tickets (§12).
 *
 * La liste sert d'abord à RETROUVER une vente : par numéro, par IMEI vendu, par
 * date. Les actions lourdes — annuler, rembourser, facturer — sont dans la
 * fiche, jamais dans la liste : une annulation déclenchée par un clic distrait
 * dans un tableau serait un incident.
 */
export function Tickets({ parametre }: { parametre?: string | null }) {
  const { db, shopId, settings, peut } = useSession();
  const monnaie = useMonnaie();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [statut, setStatut] = useState('');
  const [offset, setOffset] = useState(0);
  const [ouvert, setOuvert] = useState<string | null>(parametre ?? null);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new SaleRepository(db).list({
      shopId,
      query: differee,
      status: statut ? (statut as never) : null,
      limit: limite,
      offset,
    });
  }, [db, shopId, differee, statut, offset]);

  const exporter = () => {
    if (!etat.donnees) return;
    const contenu = toCsv(etat.donnees.items, [
      { header: 'Numéro', value: (ligne) => ligne.number },
      { header: 'Date', value: (ligne) => formaterDate(ligne.soldAt, true) },
      { header: 'Client', value: (ligne) => ligne.customerLabel ?? '' },
      { header: 'Vendeur', value: (ligne) => ligne.sellerLabel },
      { header: 'Articles', value: (ligne) => ligne.itemCount },
      { header: 'Statut', value: (ligne) => SALE_LABELS[ligne.status] },
      { header: 'Total', value: (ligne) => csvMoney(ligne.total, settings.currency) },
    ]);
    telecharger(exportFileName('tickets'), contenu);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Tickets"
        sousTitre={
          etat.donnees
            ? `${etat.donnees.total} ticket${etat.donnees.total > 1 ? 's' : ''} · ${monnaie(etat.donnees.sum)}`
            : undefined
        }
        actions={
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees}>
            Exporter
          </Bouton>
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={(valeur) => {
              setRecherche(valeur);
              setOffset(0);
            }}
            placeholder="N° de ticket, IMEI, article…"
            largeur="w-72"
          />
          <ListeFiltre
            valeur={statut}
            onChanger={(valeur) => {
              setStatut(valeur);
              setOffset(0);
            }}
            vide="Tous les statuts"
            options={valuesOf(SALE_STATUS).map((valeur) => ({
              valeur,
              libelle: SALE_LABELS[valeur],
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
            onLigneCliquee={(ligne) => setOuvert(ligne.id)}
            vide={{
              icone: 'ticket',
              titre: 'Aucun ticket',
              detail: 'Aucune vente ne correspond à ces critères.',
            }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.soldAt, true) },
              { cle: 'client', titre: 'Client', rendu: (l) => l.customerLabel ?? '—' },
              { cle: 'vendeur', titre: 'Vendeur', rendu: (l) => l.sellerLabel },
              { cle: 'articles', titre: 'Articles', num: true, rendu: (l) => l.itemCount },
              { cle: 'statut', titre: 'Statut', rendu: (l) => <BadgeVente statut={l.status} /> },
              {
                cle: 'total',
                titre: 'Total',
                num: true,
                rendu: (l) => <span className="font-medium">{monnaie(l.total)}</span>,
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

      {ouvert ? (
        <FicheTicket
          saleId={ouvert}
          onFermer={() => setOuvert(null)}
          onChange={() => etat.recharger()}
          peutAnnuler={peut(PERMISSIONS.saleCancel)}
          peutFacturer={peut(PERMISSIONS.invoiceManage)}
        />
      ) : null}
    </div>
  );
}

function FicheTicket({
  saleId,
  onFermer,
  onChange,
  peutAnnuler,
  peutFacturer,
}: {
  saleId: string;
  onFermer: () => void;
  onChange: () => void;
  peutAnnuler: boolean;
  peutFacturer: boolean;
}) {
  const contexte = useContexte();
  const { db } = useSession();
  const { aller } = useNavigation();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [annulation, setAnnulation] = useState(false);
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    const [detail, remboursements, echanges, facture] = await Promise.all([
      new SaleRepository(db).detail(saleId),
      new RefundRepository(db).forSale(saleId),
      new ExchangeRepository(db).forSale(saleId),
      new InvoiceRepository(db).bySale(saleId),
    ]);
    return { detail, remboursements, echanges, facture };
  }, [db, saleId]);

  const annuler = async () => {
    setOccupe(true);
    try {
      await new SaleService(contexte).cancel(saleId, motif);
      notifier('Vente annulée. Les articles sont revenus en stock.');
      setAnnulation(false);
      setMotif('');
      etat.recharger();
      onChange();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const facturer = async () => {
    setOccupe(true);
    try {
      const facture = await new InvoiceService(contexte).issueForSale(saleId);
      notifier(`Facture ${facture.number} émise.`);
      etat.recharger();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const detail = etat.donnees?.detail;

  return (
    <>
      <Dialogue
        ouvert
        titre={detail ? `Ticket ${detail.sale.number}` : 'Ticket'}
        onFermer={onFermer}
        largeur="lg"
        pied={
          detail ? (
            <>
              <TicketImprimable saleId={saleId} taille="normal" />
              {peutFacturer && !etat.donnees?.facture && detail.sale.status !== 'CANCELLED' ? (
                <Bouton icone="facture" occupe={occupe} onClick={() => void facturer()}>
                  Émettre la facture
                </Bouton>
              ) : null}
              {peutAnnuler && detail.sale.status === 'COMPLETED' ? (
                <Bouton variante="danger" onClick={() => setAnnulation(true)}>
                  Annuler la vente
                </Bouton>
              ) : null}
              <Bouton variante="principal" onClick={onFermer}>
                Fermer
              </Bouton>
            </>
          ) : null
        }
      >
        {etat.chargement ? (
          <Chargement />
        ) : etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
              <Info libelle="Date" valeur={formaterDate(detail.sale.soldAt, true)} />
              <Info libelle="Vendeur" valeur={detail.sellerLabel} />
              <Info libelle="Client" valeur={detail.customerLabel ?? '—'} />
              <Info libelle="Statut" valeur={<BadgeVente statut={detail.sale.status} />} />
            </div>

            {detail.sale.status === 'CANCELLED' ? (
              <Information>
                Vente annulée le {formaterDate(detail.sale.cancelledAt, true)}. Les articles ont été
                remis en stock ; le ticket est conservé pour l'historique.
              </Information>
            ) : null}

            <table className="tableau">
              <thead>
                <tr>
                  <th>Article</th>
                  <th>Identifiant</th>
                  <th className="num">Qté</th>
                  <th className="num">Prix</th>
                  <th className="num">Remise</th>
                  <th className="num">Total</th>
                  <th className="num">Rendu</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((ligne) => (
                  <tr key={ligne.id}>
                    <td>{ligne.label}</td>
                    <td className="mono text-encre-600">{ligne.identifier ?? '—'}</td>
                    <td className="num">{ligne.quantity}</td>
                    <td className="num">{monnaie(ligne.unitPrice)}</td>
                    <td className="num">
                      {ligne.discount > 0 ? `− ${monnaie(ligne.discount)}` : '—'}
                    </td>
                    <td className="num font-medium">{monnaie(ligne.lineTotal)}</td>
                    <td className="num">
                      {ligne.refundedQuantity > 0 ? (
                        <Badge ton="attente">{ligne.refundedQuantity}</Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-end">
              <div className="w-64 space-y-1 text-sm">
                <LigneTotal libelle="Sous-total" valeur={monnaie(detail.sale.subtotal)} />
                {detail.sale.discount > 0 ? (
                  <LigneTotal libelle="Remises" valeur={`− ${monnaie(detail.sale.discount)}`} />
                ) : null}
                {detail.sale.tax > 0 ? (
                  <LigneTotal libelle="TVA" valeur={monnaie(detail.sale.tax)} />
                ) : null}
                <div className="flex justify-between border-t border-encre-200 pt-1 text-base font-semibold">
                  <span>Total</span>
                  <span data-nombre>{monnaie(detail.sale.total)}</span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="mb-1.5 text-encre-800">Règlements</h3>
              <div className="flex flex-wrap gap-2">
                {detail.payments.map((reglement) => (
                  <Badge key={reglement.id} ton="neutre">
                    {reglement.method} · {monnaie(reglement.amount)}
                    {reglement.reference ? ` · ${reglement.reference}` : ''}
                  </Badge>
                ))}
                {detail.sale.changeGiven > 0 ? (
                  <Badge ton="info">Rendu · {monnaie(detail.sale.changeGiven)}</Badge>
                ) : null}
              </div>
            </div>

            {(etat.donnees?.remboursements.length ?? 0) > 0 ||
            (etat.donnees?.echanges.length ?? 0) > 0 ||
            etat.donnees?.facture ? (
              <div>
                <h3 className="mb-1.5 text-encre-800">Documents liés</h3>
                <div className="flex flex-wrap gap-2">
                  {etat.donnees?.facture ? (
                    <button
                      type="button"
                      onClick={() => aller('factures', etat.donnees?.facture?.id)}
                    >
                      <Badge ton="info">Facture {etat.donnees.facture.number}</Badge>
                    </button>
                  ) : null}
                  {etat.donnees?.remboursements.map((remboursement) => (
                    <Badge key={remboursement.id} ton="attente">
                      Remboursement {remboursement.number} · {monnaie(remboursement.total)}
                    </Badge>
                  ))}
                  {etat.donnees?.echanges.map((echange) => (
                    <Badge key={echange.id} ton="neutre">
                      Échange {echange.number}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialogue>

      <Confirmation
        ouvert={annulation}
        titre="Annuler cette vente"
        libelleAction="Annuler la vente"
        danger
        occupe={occupe}
        onConfirmer={() => void annuler()}
        onFermer={() => setAnnulation(false)}
        message="Les articles reviendront en stock et des mouvements inverses seront écrits. Le ticket restera consultable, marqué comme annulé."
      >
        <ZoneTexte
          label="Motif"
          requis
          value={motif}
          onChange={(evenement) => setMotif(evenement.target.value)}
          aide="Il figurera dans le journal d'audit."
        />
      </Confirmation>
    </>
  );
}

function Info({ libelle, valeur }: { libelle: string; valeur: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-encre-500">{libelle}</p>
      <div className="text-encre-900">{valeur}</div>
    </div>
  );
}

function LigneTotal({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-encre-600">{libelle}</span>
      <span data-nombre>{valeur}</span>
    </div>
  );
}
