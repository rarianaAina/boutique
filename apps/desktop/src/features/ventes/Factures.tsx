import { useState } from 'react';
import { INVOICE_LABELS, INVOICE_STATUS, valuesOf } from '@boutique/shared';
import { InvoiceRepository } from '@/core/db/repositories/invoice.repository';
import { InvoiceService } from '@/core/services/invoice.service';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import { Avertissement, Carte, Chargement, EnTetePage, Erreur } from '@/components/ui/Page';
import { BadgeFacture } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ } from '@/components/ui/Champ';
import { BarreFiltres, ListeFiltre, Pagination, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useMonnaie } from '@/app/hooks';
import { enregistrerBinaire, telecharger } from '@/features/gestion/telechargement';

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
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [montant, setMontant] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [edition, setEdition] = useState(false);

  /**
   * L'APERÇU ET LE PDF VIENNENT DU MÊME DOCUMENT.
   *
   * C'étaient auparavant deux codes parallèles lisant les mêmes tables : un
   * aperçu qui affichait le NIF sans regarder si la configuration demandait de
   * l'imprimer, et un PDF qui le regardait. Ils ont fini par ne plus dire la
   * même chose — l'écran montrait des mentions que la pièce ne portait pas,
   * ce qui est la pire des deux erreurs : on ne découvre le manque qu'une fois
   * la facture remise.
   *
   * Deux RENDUS d'un même document restent deux rendus ; ce qu'ils affichent,
   * en revanche, ne peut plus diverger, puisqu'il n'est décidé qu'une fois.
   */
  const etat = useChargement(
    async () => new InvoiceService(contexte).documentFacture(invoiceId),
    [contexte.db, invoiceId, contexte.settings],
  );

  const doc = etat.donnees;
  const reste = doc ? doc.total - doc.regle : 0;

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

  /**
   * Produit le PDF et le propose à l'enregistrement.
   *
   * Un VRAI fichier, et non l'impression du navigateur : une facture se joint
   * à un message, se garde, se ressort trois ans plus tard pour une garantie.
   */
  const enregistrerPdf = async () => {
    setEdition(true);
    try {
      const octets = await new InvoiceService(contexte).pdf(invoiceId);
      const chemin = await enregistrerBinaire(
        `Facture-${doc?.numero ?? invoiceId}.pdf`,
        octets,
        'Document PDF',
        'pdf',
      );
      if (chemin) notifier('Facture enregistrée.');
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setEdition(false);
    }
  };

  const identifiants = (partie: { nif?: string | null; stat?: string | null } | null) =>
    [partie?.nif ? `NIF ${partie.nif}` : null, partie?.stat ? `STAT ${partie.stat}` : null]
      .filter(Boolean)
      .join('   ');

  return (
    <Dialogue
      ouvert
      titre={doc ? `Facture ${doc.numero}` : 'Facture'}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          {/*
            UNE SEULE PIÈCE. L'impression du bloc ci-dessous par le navigateur
            existait avant le PDF : elle produisait un document SANS les
            mentions fiscales, qu'une comptabilité refuse. Deux versions
            différentes d'une même facture, selon le bouton pressé, était le
            plus sûr moyen d'en voir circuler une mauvaise. Le PDF s'ouvre dans
            le lecteur du poste, où l'impression est à un clic.
          */}
          <Bouton
            variante="principal"
            icone="facture"
            occupe={edition}
            onClick={() => void enregistrerPdf()}
          >
            Enregistrer en PDF
          </Bouton>
          <Bouton onClick={onFermer}>Fermer</Bouton>
        </>
      }
    >
      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : doc ? (
        <div className="space-y-4">
          <div
            id="zone-impression"
            data-selectable
            className="rounded-md border border-encre-200 p-5"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                {doc.logo ? <img src={doc.logo} alt="" className="mb-2 h-10 w-auto" /> : null}
                <p className="text-lg font-bold uppercase">{doc.emetteur.nom}</p>
                {doc.emetteur.adresse ? (
                  <p className="text-xs text-encre-600">{doc.emetteur.adresse}</p>
                ) : null}
                {identifiants(doc.emetteur) ? (
                  <p className="text-xs text-encre-600">{identifiants(doc.emetteur)}</p>
                ) : null}
                {doc.mentions.map((mention) => (
                  <p key={mention.libelle} className="text-xs text-encre-600">
                    {mention.libelle} : {mention.valeur}
                  </p>
                ))}
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold">FACTURE</p>
                <p className="mono text-sm">{doc.numero}</p>
                <p className="text-xs text-encre-600">{formaterDate(doc.emiseLe)}</p>
                {doc.echeanceLe ? (
                  <p className="text-xs text-encre-600">
                    Échéance : {formaterDate(doc.echeanceLe)}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mb-3 rounded bg-encre-50 p-2 text-sm">
              <span className="text-encre-500">Facturé à : </span>
              {doc.destinataire?.nom ?? 'Client de passage'}
              {identifiants(doc.destinataire) ? (
                <span className="ml-2 text-xs text-encre-600">
                  {identifiants(doc.destinataire)}
                </span>
              ) : null}
            </div>

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
                {doc.lignes.map((ligne, rang) => (
                  <tr key={`${ligne.designation}-${rang}`}>
                    <td>{ligne.designation}</td>
                    <td className="mono">{ligne.identifiant ?? '—'}</td>
                    <td className="num">{ligne.quantite}</td>
                    <td className="num">{monnaie(ligne.prixUnitaire)}</td>
                    <td className="num">{monnaie(ligne.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 flex justify-end">
              <div className="w-64 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-encre-600">Sous-total</span>
                  <span data-nombre>{monnaie(doc.sousTotal)}</span>
                </div>
                {doc.remise > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-encre-600">Remises</span>
                    <span data-nombre>− {monnaie(doc.remise)}</span>
                  </div>
                ) : null}
                {doc.taxe > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-encre-600">TVA</span>
                    <span data-nombre>{monnaie(doc.taxe)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-encre-300 pt-1 font-semibold">
                  <span>Total</span>
                  <span data-nombre>{monnaie(doc.total)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-encre-600">Réglé</span>
                  <span data-nombre>{monnaie(doc.regle)}</span>
                </div>
                {reste > 0 ? (
                  <div className="flex justify-between font-semibold text-danger-700">
                    <span>Reste dû</span>
                    <span data-nombre>{monnaie(reste)}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {doc.conditions ? (
              <p className="mt-4 text-xs text-encre-600">
                <span className="font-semibold">Conditions de vente. </span>
                {doc.conditions}
              </p>
            ) : null}
            {doc.piedDePage ? (
              <p className="mt-2 text-xs text-encre-600">{doc.piedDePage}</p>
            ) : null}
            {doc.signatures ? (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[doc.signatures.gauche, doc.signatures.droite].map((libelle) => (
                  <div key={libelle} className="rounded border border-encre-200 p-2">
                    <p className="text-xs font-semibold">{libelle}</p>
                    <p className="text-xs text-encre-500">Date et signature</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {!doc.emetteur.nif && !doc.emetteur.stat ? (
            <Avertissement>
              Cette facture ne porte aucun identifiant fiscal. Renseignez le NIF et le STAT de la
              boutique dans les paramètres, et vérifiez que « Imprimer les identifiants fiscaux »
              est coché — sans eux, la comptabilité d’une entreprise cliente refusera la pièce.
            </Avertissement>
          ) : null}

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
