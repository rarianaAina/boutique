import { useState } from 'react';
import { PERMISSIONS, localDay, startOfMonth } from '@boutique/shared';
import { ResultatService, type CompteDeResultat } from '@/core/services/resultat.service';
import { exportFileName, toCsv, csvMoney } from '@/core/services/export.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { Bouton } from '@/components/ui/Bouton';
import { Champ } from '@/components/ui/Champ';
import { BarreFiltres } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { messageDe, useChargement, useMonnaie } from '@/app/hooks';
import { enregistrerBinaire, telecharger } from './telechargement';

/**
 * Compte de résultat entre deux dates.
 *
 * LA QUESTION : est-ce que j'ai gagné de l'argent ce mois-ci, et où est-il
 * passé ? Les rapports existants répondent au « combien j'ai vendu » ; celui-ci
 * répond au « combien il m'en reste », ce qui n'est pas la même chose et ne
 * s'en déduit pas.
 *
 * Le document s'exporte en PDF parce qu'il sortira du logiciel : un comptable,
 * une banque, un associé. Et il porte alors, imprimé sur lui, ce qu'il n'est
 * pas — sans quoi il serait lu comme des comptes annuels.
 */
export function Resultat() {
  const contexte = useContexte();
  const { peut, settings } = useSession();
  const monnaie = useMonnaie();
  const { notifier } = useNotifications();

  const [du, setDu] = useState(startOfMonth());
  const [au, setAu] = useState(localDay());
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(
    async () => new ResultatService(contexte).etablir(du, au),
    [contexte.db, du, au],
  );

  const exporterPdf = async () => {
    setOccupe(true);
    try {
      const octets = await new ResultatService(contexte).pdf(du, au);
      const chemin = await enregistrerBinaire(
        `Compte-de-resultat-${du}_${au}.pdf`,
        octets,
        'Document PDF',
        'pdf',
      );
      if (chemin) notifier('Compte de résultat enregistré.');
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const exporterCsv = () => {
    const compte = etat.donnees;
    if (!compte) return;
    const lignes = [
      { poste: 'Ventes', montant: compte.ventes },
      { poste: 'Remises accordées', montant: -compte.remises },
      { poste: 'Retours et remboursements', montant: -compte.retours },
      { poste: "Chiffre d'affaires net", montant: compte.chiffreAffairesNet },
      { poste: 'Coût des marchandises vendues', montant: -compte.coutMarchandises },
      { poste: 'Marge brute', montant: compte.margeBrute },
      ...compte.charges.map((charge) => ({ poste: charge.libelle, montant: -charge.montant })),
      { poste: 'Total des charges', montant: -compte.totalCharges },
      { poste: 'Résultat', montant: compte.resultat },
    ];
    void telecharger(
      exportFileName(`compte-de-resultat-${du}_${au}`),
      toCsv(lignes, [
        { header: 'Poste', value: (l) => l.poste },
        { header: 'Montant', value: (l) => csvMoney(l.montant, settings.currency) },
      ]),
    );
  };

  return (
    <>
      <EnTetePage
        titre="Compte de résultat"
        sousTitre="Ce que le commerce a gagné sur la période, et ce que cela lui a coûté."
        actions={
          <>
            <Bouton icone="export" onClick={exporterCsv}>
              Exporter en CSV
            </Bouton>
            <Bouton
              variante="principal"
              icone="rapport"
              occupe={occupe}
              onClick={() => void exporterPdf()}
            >
              Enregistrer en PDF
            </Bouton>
          </>
        }
      />

      <Carte>
        <BarreFiltres>
          <Champ label="Du" type="date" value={du} onChange={(e) => setDu(e.target.value)} />
          <Champ label="Au" type="date" value={au} onChange={(e) => setAu(e.target.value)} />
        </BarreFiltres>

        {etat.chargement ? (
          <Chargement />
        ) : etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : etat.donnees ? (
          <Detail compte={etat.donnees} monnaie={monnaie} />
        ) : null}
      </Carte>

      <Information>
        Ce compte donne le résultat de l’exploitation. Il ne porte ni amortissements, ni emprunts,
        ni capital, et ne remplace pas les comptes annuels d’un expert-comptable.
        {peut(PERMISSIONS.chargeManage)
          ? ' Les charges se saisissent dans l’écran « Charges » : sans elles, ce document ne montre qu’une marge.'
          : ''}
      </Information>
    </>
  );
}

function Detail({
  compte,
  monnaie,
}: {
  compte: CompteDeResultat;
  monnaie: (valeur: number) => string;
}) {
  const beneficiaire = compte.resultat >= 0;

  return (
    <div className="mx-auto max-w-2xl space-y-1 py-2">
      <Section titre="Produits" />
      <Ligne
        libelle="Ventes"
        detail={`${compte.nombreVentes} vente(s)`}
        valeur={monnaie(compte.ventes)}
      />
      <Ligne libelle="Remises accordées" valeur={`− ${monnaie(compte.remises)}`} />
      <Ligne libelle="Retours et remboursements" valeur={`− ${monnaie(compte.retours)}`} />
      <Ligne libelle="Chiffre d'affaires net" valeur={monnaie(compte.chiffreAffairesNet)} fort />

      <Section titre="Coût des marchandises vendues" />
      <Ligne
        libelle="Prix de revient des articles sortis"
        detail="frais d’approche compris"
        valeur={`− ${monnaie(compte.coutMarchandises)}`}
      />
      <Ligne
        libelle="Marge brute"
        detail={`${(compte.tauxMarge / 100).toFixed(1).replace('.', ',')} %`}
        valeur={monnaie(compte.margeBrute)}
        fort
        alerte={compte.margeBrute < 0}
      />

      <Section titre="Charges d'exploitation" />
      {compte.charges.length === 0 ? (
        <p className="py-1 text-sm text-encre-500">Aucune charge saisie sur la période.</p>
      ) : (
        compte.charges.map((charge) => (
          <Ligne
            key={charge.categorie}
            libelle={charge.libelle}
            detail={`${charge.nombre} pièce(s)`}
            valeur={`− ${monnaie(charge.montant)}`}
          />
        ))
      )}
      <Ligne libelle="Total des charges" valeur={monnaie(compte.totalCharges)} fort />

      <div
        className={`mt-4 flex items-center justify-between rounded-md px-4 py-3 ${
          beneficiaire ? 'bg-succes-50' : 'bg-danger-50'
        }`}
      >
        <span className={`font-semibold ${beneficiaire ? 'text-succes-800' : 'text-danger-800'}`}>
          {beneficiaire ? 'Bénéfice' : 'Perte'}
        </span>
        <span
          className={`text-lg font-bold ${beneficiaire ? 'text-succes-800' : 'text-danger-800'}`}
          data-nombre
        >
          {monnaie(compte.resultat)}
        </span>
      </div>
    </div>
  );
}

function Section({ titre }: { titre: string }) {
  return (
    <p className="mt-4 border-b border-encre-200 pb-1 text-xs font-semibold uppercase tracking-wide text-encre-500">
      {titre}
    </p>
  );
}

function Ligne({
  libelle,
  detail,
  valeur,
  fort,
  alerte,
}: {
  libelle: string;
  detail?: string;
  valeur: string;
  fort?: boolean;
  alerte?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between py-1 text-sm ${
        fort ? 'border-t border-encre-200 pt-2 font-semibold' : ''
      }`}
    >
      <span className={alerte ? 'text-danger-700' : undefined}>
        {libelle}
        {detail ? <span className="ml-2 text-xs text-encre-500">{detail}</span> : null}
      </span>
      <span className={alerte ? 'text-danger-700' : undefined} data-nombre>
        {valeur}
      </span>
    </div>
  );
}
