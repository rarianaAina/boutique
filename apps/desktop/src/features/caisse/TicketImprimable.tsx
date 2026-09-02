import { useState } from 'react';
import { formatMoney } from '@boutique/shared';
import { SaleRepository, type SaleDetail } from '@/core/db/repositories/sale.repository';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Chargement, Erreur } from '@/components/ui/Page';
import { useSession } from '@/app/session';
import { formaterDate, useChargement } from '@/app/hooks';
import { saitImprimer } from '@/core/plateforme';

/**
 * Ticket de caisse (§12).
 *
 * Rendu en HTML puis imprimé par la WebView, plutôt qu'envoyé en commandes
 * ESC/POS : la boutique imprime le plus souvent sur une imprimante bureautique
 * ordinaire, et un pilote système gère les deux cas. La mise en page est
 * étroite (80 mm) pour rester lisible sur un rouleau thermique comme sur une
 * feuille A4.
 *
 * Le ticket porte TOUT ce que le §12 exige : numéro, date, boutique, vendeur,
 * articles avec IMEI, remises, total, mode de paiement et client.
 */
export function TicketImprimable({
  saleId,
  libelle = 'Imprimer',
  taille = 'petit',
}: {
  saleId: string;
  libelle?: string;
  taille?: 'petit' | 'normal';
}) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <Bouton taille={taille} icone="ticket" onClick={() => setOuvert(true)}>
        {libelle}
      </Bouton>
      <ApercuTicket saleId={saleId} ouvert={ouvert} onFermer={() => setOuvert(false)} />
    </>
  );
}

export function ApercuTicket({
  saleId,
  ouvert,
  onFermer,
}: {
  saleId: string;
  ouvert: boolean;
  onFermer: () => void;
}) {
  const { db, shopName, settings } = useSession();
  const etat = useChargement(
    async () => (db && ouvert ? new SaleRepository(db).detail(saleId) : null),
    [db, saleId, ouvert],
  );

  return (
    <Dialogue
      ouvert={ouvert}
      titre="Ticket de caisse"
      onFermer={onFermer}
      largeur="sm"
      pied={
        <>
          <Bouton onClick={onFermer}>Fermer</Bouton>
          {/*
            Android n'a pas de boîte d'impression : `window.print()` n'y fait
            RIEN, et un bouton qui ne fait rien est pire qu'un bouton absent —
            on le presse deux fois, puis on croit que le ticket est parti.
          */}
          {saitImprimer() ? (
            <Bouton variante="principal" icone="ticket" onClick={() => window.print()}>
              Imprimer
            </Bouton>
          ) : null}
        </>
      }
    >
      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : etat.donnees ? (
        <CorpsTicket
          detail={etat.donnees}
          boutique={shopName}
          entete={settings.receiptHeader}
          pied={settings.receiptFooter}
          devise={settings.currency}
        />
      ) : null}
    </Dialogue>
  );
}

function CorpsTicket({
  detail,
  boutique,
  entete,
  pied,
  devise,
}: {
  detail: SaleDetail;
  boutique: string;
  entete: string;
  pied: string;
  devise: Parameters<typeof formatMoney>[1];
}) {
  const { sale, lines, payments } = detail;
  const montant = (valeur: number) => formatMoney(valeur, devise);

  return (
    <div
      id="zone-impression"
      data-selectable
      className="mx-auto max-w-[80mm] bg-white p-4 font-mono text-[11px] leading-snug text-black"
    >
      <div className="text-center">
        <p className="text-sm font-bold uppercase">{boutique}</p>
        {entete ? <p className="whitespace-pre-line">{entete}</p> : null}
      </div>

      <div className="my-2 border-t border-dashed border-black/40" />

      <div className="flex justify-between">
        <span>Ticket</span>
        <span className="font-bold">{sale.number}</span>
      </div>
      <div className="flex justify-between">
        <span>Date</span>
        <span>{formaterDate(sale.soldAt, true)}</span>
      </div>
      <div className="flex justify-between">
        <span>Vendeur</span>
        <span>{detail.sellerLabel}</span>
      </div>
      {detail.customerLabel ? (
        <div className="flex justify-between">
          <span>Client</span>
          <span>{detail.customerLabel}</span>
        </div>
      ) : null}

      <div className="my-2 border-t border-dashed border-black/40" />

      {lines.map((ligne) => (
        <div key={ligne.id} className="mb-1.5">
          <div className="font-bold">{ligne.label}</div>
          {ligne.identifier ? <div className="text-[10px]">{ligne.identifier}</div> : null}
          <div className="flex justify-between">
            <span>
              {ligne.quantity} × {montant(ligne.unitPrice)}
            </span>
            <span>{montant(ligne.quantity * ligne.unitPrice)}</span>
          </div>
          {ligne.discount > 0 ? (
            <div className="flex justify-between">
              <span>Remise</span>
              <span>− {montant(ligne.discount)}</span>
            </div>
          ) : null}
        </div>
      ))}

      <div className="my-2 border-t border-dashed border-black/40" />

      <div className="flex justify-between">
        <span>Sous-total</span>
        <span>{montant(sale.subtotal)}</span>
      </div>
      {sale.discount > 0 ? (
        <div className="flex justify-between">
          <span>Remises</span>
          <span>− {montant(sale.discount)}</span>
        </div>
      ) : null}
      {sale.tax > 0 ? (
        <div className="flex justify-between">
          <span>TVA</span>
          <span>{montant(sale.tax)}</span>
        </div>
      ) : null}
      <div className="mt-1 flex justify-between text-sm font-bold">
        <span>TOTAL</span>
        <span>{montant(sale.total)}</span>
      </div>

      <div className="my-2 border-t border-dashed border-black/40" />

      {payments.map((reglement) => (
        <div key={reglement.id} className="flex justify-between">
          <span>{reglement.method}</span>
          <span>{montant(reglement.amount)}</span>
        </div>
      ))}
      {sale.changeGiven > 0 ? (
        <div className="flex justify-between font-bold">
          <span>Rendu</span>
          <span>{montant(sale.changeGiven)}</span>
        </div>
      ) : null}

      {pied ? (
        <>
          <div className="my-2 border-t border-dashed border-black/40" />
          <p className="whitespace-pre-line text-center">{pied}</p>
        </>
      ) : null}
    </div>
  );
}
