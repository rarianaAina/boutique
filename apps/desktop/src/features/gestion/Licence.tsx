import { useState } from 'react';
import { BOUTIQUE, licenceAllows, type LicenceStatus } from '@boutique/shared';
import { useSession } from '@/app/session';
import { Bouton } from '@/components/ui/Bouton';
import { Badge } from '@/components/ui/Badge';
import { Icone } from '@/components/ui/Icone';
import { Carte, Erreur, Information } from '@/components/ui/Page';

/**
 * Activation du poste (§35).
 *
 * Le même composant sert à DEUX endroits, et c'est délibéré : dans les
 * paramètres, où l'on consulte son échéance et renouvelle sa clé ; et en plein
 * écran, quand la licence est échue et qu'il n'y a plus rien d'autre à faire.
 * Deux écrans auraient divergé, et celui qu'on voit le moins souvent est
 * justement celui qui doit être irréprochable — c'est celui d'un commerçant
 * bloqué.
 */
export function Licence({ pleinEcran = false }: { pleinEcran?: boolean }) {
  const { licence, codeInstallation, activerLicence } = useSession();
  const [saisie, setSaisie] = useState('');
  const [refus, setRefus] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [copie, setCopie] = useState(false);

  const activer = async () => {
    setOccupe(true);
    setRefus(null);
    try {
      const resultat = await activerLicence(saisie);
      if (
        resultat.state === 'invalide' ||
        resultat.state === 'autre-entreprise' ||
        resultat.state === 'autre-produit'
      ) {
        setRefus(resultat.reason ?? 'Clé refusée.');
        return;
      }
      setSaisie('');
    } catch (cause) {
      setRefus(cause instanceof Error ? cause.message : 'Activation impossible.');
    } finally {
      setOccupe(false);
    }
  };

  const copier = () => {
    void navigator.clipboard?.writeText(codeInstallation).catch(() => undefined);
    setCopie(true);
    setTimeout(() => setCopie(false), 1500);
  };

  const resume = resumer(licence);

  const contenu = (
    <div className="space-y-4">
      <div
        className={`rounded-lg border px-4 py-3 ${
          resume.ton === 'ok'
            ? 'border-succes-200 bg-succes-50 text-succes-800'
            : resume.ton === 'alerte'
              ? 'border-attention-200 bg-attention-50 text-attention-800'
              : 'border-danger-200 bg-danger-50 text-danger-800'
        }`}
      >
        <p className="font-medium">{resume.titre}</p>
        <p className="mt-0.5 text-sm">{resume.detail}</p>
      </div>

      <div>
        <p className="text-sm text-encre-600">
          Code d’installation — c’est lui qu’il faut communiquer pour obtenir une clé.
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="mono rounded-md border border-encre-300 bg-encre-50 px-3 py-2 text-base tracking-wider">
            {codeInstallation || '…'}
          </code>
          <Bouton taille="petit" variante="discret" onClick={copier}>
            <Icone nom={copie ? 'check' : 'export'} taille={15} />
            {copie ? 'Copié' : 'Copier'}
          </Bouton>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-encre-700" htmlFor="cle-licence">
          Clé d’activation
        </label>
        <textarea
          id="cle-licence"
          value={saisie}
          onChange={(evenement) => setSaisie(evenement.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="BOUTIQUE-2.…"
          className="mono mt-1 w-full rounded-lg border border-encre-300 px-3 py-2 text-xs outline-none focus:border-marque-500"
        />
        <Bouton
          variante="principal"
          occupe={occupe}
          onClick={() => void activer()}
          disabled={saisie.trim() === ''}
        >
          Activer ce poste
        </Bouton>
      </div>

      {refus ? <Erreur message={refus} /> : null}

      {licence.payload ? (
        <div>
          <p className="text-sm font-medium text-encre-700">Modules compris dans votre licence</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {BOUTIQUE.fonctions.map((fonction) => (
              <Badge
                key={fonction.cle}
                ton={licenceAllows(licence, fonction.cle) ? 'succes' : 'neutre'}
              >
                {fonction.libelle}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <Information>
        La vérification est entièrement locale : aucune connexion n’est nécessaire, ni maintenant,
        ni plus tard. Vos données restent intactes même si la licence expire.
      </Information>
    </div>
  );

  if (!pleinEcran) return <Carte titre="Licence">{contenu}</Carte>;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-encre-100 p-6">
      <div className="w-full max-w-xl">
        <h1 className="mb-4 text-center text-lg font-semibold text-encre-900">
          Ce poste n’est pas activé
        </h1>
        <Carte>{contenu}</Carte>
      </div>
    </div>
  );
}

/**
 * Ce que l'écran dit de l'état, en une phrase.
 *
 * Chaque cas a son propre message : « licence invalide » ne dit rien à qui a
 * collé la clé de son autre logiciel, ni à qui a reçu la clé du voisin.
 */
function resumer(status: LicenceStatus): {
  ton: 'ok' | 'alerte' | 'bloque';
  titre: string;
  detail: string;
} {
  const jours = (nombre: number) => `${nombre} jour${Math.abs(nombre) > 1 ? 's' : ''}`;

  switch (status.state) {
    case 'valide': {
      const essai = status.payload?.s === 'essai';
      return {
        ton: (status.daysLeft ?? 0) <= 30 ? 'alerte' : 'ok',
        titre: essai ? 'Période d’essai' : `Poste activé — ${status.payload?.n ?? ''}`,
        detail: essai
          ? `Il reste ${jours(status.daysLeft ?? 0)}. Toutes les fonctions sont ouvertes.`
          : `Valable jusqu’au ${status.payload?.e ?? ''}, soit ${jours(status.daysLeft ?? 0)}.`,
      };
    }
    case 'grace':
      return {
        ton: 'alerte',
        titre: 'Licence échue',
        detail:
          `Elle a expiré le ${status.payload?.e ?? ''}. Tout fonctionne encore pendant ` +
          `${jours(status.graceLeft ?? BOUTIQUE.graceJours)}, puis le poste se fermera.`,
      };
    case 'expiree':
      return {
        ton: 'bloque',
        titre: status.payload?.s === 'essai' ? 'Période d’essai terminée' : 'Licence expirée',
        detail: 'Vos données sont intactes et vous les retrouverez intégralement dès l’activation.',
      };
    case 'autre-entreprise':
      return {
        ton: 'bloque',
        titre: 'Clé émise pour une autre installation',
        detail: status.reason ?? 'Vérifiez le code d’installation communiqué.',
      };
    case 'autre-produit':
      return {
        ton: 'bloque',
        titre: 'Clé émise pour un autre logiciel',
        detail: `${status.reason ?? ''} Vérifiez que vous n’avez pas collé la clé d’un autre de vos logiciels.`,
      };
    case 'invalide':
      return {
        ton: 'bloque',
        titre: 'Clé refusée',
        detail: status.reason ?? 'Cette clé n’a pas pu être vérifiée.',
      };
    default:
      return {
        ton: 'bloque',
        titre: 'Poste non activé',
        detail: 'Saisissez la clé qui vous a été communiquée.',
      };
  }
}
