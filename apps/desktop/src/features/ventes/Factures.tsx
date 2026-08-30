import { useState } from 'react';
import { INVOICE_LABELS, INVOICE_STATUS, valuesOf } from '@boutique/shared';
import { InvoiceRepository } from '@/core/db/repositories/invoice.repository';
import { InvoiceService } from '@/core/services/invoice.service';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import { Carte, Chargement, EnTetePage, Erreur } from '@/components/ui/Page';
import { BadgeFacture } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ } from '@/components/ui/Champ';
import { BarreFiltres, ListeFiltre, Pagination, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Factures (§13).
 *
 * Une facture est un document à part entière : sa propre série, son propre
 * statut de paiement. Elle s'imprime, elle s'encaisse partiellement, elle
 * s'annule — mais elle ne se supprime jamais.
 */
export function Factures({ parametre }: { parametre?: string | null }) {
  const { db, shopId, settings } = useSession();
  const monnaie = useMonnaie();
  const [statut, setStatut] = useState('');
  const [offset, setOffset] = useState(0);
  const [ouverte, setOuverte] = useState<string | null>(parametre ?? null);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new InvoiceRepository(db).list({
      shopId,
      status: statut ? (statut as never) : null,
      limit: limite,
      offset,
    });
  }, [db, shopId, statut, offset]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('factures'),
      toCsv(etat.donnees.items, [
        { header: 'Numéro', value: (l) => l.number },
        { header: 'Date', value: (l) => formaterDate(l.issuedAt) },
        { header: 'Client', value: (l) => l.customerLabel ?? '' },
        { header: 'Statut', value: (l) => INVOICE_LABELS[l.status] },
        { header: 'Total', value: (l) => csvMoney(l.total, settings.currency) },
        { header: 'Réglé', value: (l) => csvMoney(l.paid, settings.currency) },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Factures"
        sousTitre={
          etat.donnees
            ? `${etat.donnees.total} facture(s) · ${monnaie(etat.donnees.sum)}`
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
          <ListeFiltre
            valeur={statut}
            onChanger={(valeur) => {
              setStatut(valeur);
              setOffset(0);
            }}
            vide="Tous les statuts"
            options={valuesOf(INVOICE_STATUS).map((valeur) => ({
              valeur,
              libelle: INVOICE_LABELS[valeur],
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
            onLigneCliquee={(ligne) => setOuverte(ligne.id)}
            vide={{
              icone: 'facture',
              titre: 'Aucune facture',
              detail: 'Les factures se créent depuis un ticket.',
            }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              { cle: 'date', titre: 'Émise le', rendu: (l) => formaterDate(l.issuedAt) },
              { cle: 'client', titre: 'Client', rendu: (l) => l.customerLabel ?? '—' },
              { cle: 'statut', titre: 'Statut', rendu: (l) => <BadgeFacture statut={l.status} /> },
              { cle: 'regle', titre: 'Réglé', num: true, rendu: (l) => monnaie(l.paid) },
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

      {ouverte ? (
        <FicheFacture
          invoiceId={ouverte}
          onFermer={() => setOuverte(null)}
          onChange={() => etat.recharger()}
        />
      ) : null}
    </div>
  );
}

function FicheFacture({
  invoiceId,
  onFermer,
  onChange,
}: {
  invoiceId: string;
  onFermer: () => void;
  onChange: () => void;
}) {
  const contexte = useContexte();
  const { shopName, settings } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [montant, setMontant] = useState('');
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(
    async () => new InvoiceService(contexte).document(invoiceId),
    [contexte.db, invoiceId],
  );

  const encaisser = async () => {
    setOccupe(true);
    try {
      await new InvoiceService(contexte).registerPayment(invoiceId, Number(montant) || 0);
      notifier('Règlement enregistré.');
      setMontant('');
      etat.recharger();
      onChange();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const facture = etat.donnees?.invoice;
  const vente = etat.donnees?.sale;
  const reste = facture ? facture.total - facture.paid : 0;

  return (
    <Dialogue
      ouvert
      titre={facture ? `Facture ${facture.number}` : 'Facture'}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton icone="facture" onClick={() => window.print()}>
            Imprimer
          </Bouton>
          <Bouton variante="principal" onClick={onFermer}>
            Fermer
          </Bouton>
        </>
      }
    >
      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : facture ? (
        <div className="space-y-4">
          <div
            id="zone-impression"
            data-selectable
            className="rounded-md border border-encre-200 p-5"
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="text-lg font-bold uppercase">{shopName}</p>
                <p className="text-xs text-encre-600">{settings.receiptHeader}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold">FACTURE</p>
                <p className="mono text-sm">{facture.number}</p>
                <p className="text-xs text-encre-600">{formaterDate(facture.issuedAt)}</p>
              </div>
            </div>

            {vente ? (
              <>
                <p className="mb-2 text-sm">
                  <span className="text-encre-500">Client : </span>
                  {vente.customerLabel ?? 'Client de passage'}
                </p>
                <table className="tableau">
                  <thead>
                    <tr>
                      <th>Désignation</th>
                      <th>Identifiant</th>
                      <th className="num">Qté</th>
                      <th className="num">P.U.</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vente.lines.map((ligne) => (
                      <tr key={ligne.id}>
                        <td>{ligne.label}</td>
                        <td className="mono">{ligne.identifier ?? '—'}</td>
                        <td className="num">{ligne.quantity}</td>
                        <td className="num">{monnaie(ligne.unitPrice)}</td>
                        <td className="num">{monnaie(ligne.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}

            <div className="mt-4 flex justify-end">
              <div className="w-64 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-encre-600">Sous-total</span>
                  <span data-nombre>{monnaie(facture.subtotal)}</span>
                </div>
                {facture.discount > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-encre-600">Remises</span>
                    <span data-nombre>− {monnaie(facture.discount)}</span>
                  </div>
                ) : null}
                {facture.tax > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-encre-600">TVA</span>
                    <span data-nombre>{monnaie(facture.tax)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-encre-300 pt-1 font-semibold">
                  <span>Total</span>
                  <span data-nombre>{monnaie(facture.total)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-encre-600">Réglé</span>
                  <span data-nombre>{monnaie(facture.paid)}</span>
                </div>
                {reste > 0 ? (
                  <div className="flex justify-between font-semibold text-danger-700">
                    <span>Reste dû</span>
                    <span data-nombre>{monnaie(reste)}</span>
                  </div>
                ) : null}
              </div>
            </div>

            <p className="mt-4 text-xs text-encre-600">{settings.receiptFooter}</p>
          </div>

          {reste > 0 ? (
            <div className="sans-impression flex items-end gap-2">
              <Champ
                label="Encaisser un règlement"
                className="flex-1"
                inputMode="decimal"
                value={montant}
                onChange={(evenement) => setMontant(evenement.target.value)}
                aide={`Reste dû : ${monnaie(reste)}`}
              />
              <Bouton
                variante="principal"
                className="mb-5"
                occupe={occupe}
                onClick={() => void encaisser()}
              >
                Enregistrer
              </Bouton>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialogue>
  );
}
