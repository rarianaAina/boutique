import { useEffect, useRef, useState } from 'react';
import { Bouton } from '@/components/ui/Bouton';
import { Champ } from '@/components/ui/Champ';
import { Avertissement, Erreur, Information } from '@/components/ui/Page';
import { Dialogue } from '@/components/ui/Dialogue';
import { AuthService } from '@/core/services/auth.service';
import type { SqlExecutor } from '@/core/db/client';
import logo from '@/assets/logo.png';
import { useSession } from '@/app/session';
import { messageDe } from '@/app/hooks';

/**
 * Écran de connexion.
 *
 * Volontairement dépouillé : c'est le premier écran de la journée, et il doit
 * se franchir en deux frappes. Le champ d'identifiant a le focus d'emblée, et
 * la touche Entrée valide — le vendeur n'a pas à toucher la souris.
 *
 * AUCUN APPEL RÉSEAU : la vérification est locale. Une boutique dont la
 * connexion est coupée doit pouvoir ouvrir sa caisse.
 */
export function Connexion() {
  const { connecter, shopName, shopCode, db } = useSession();
  const [deblocage, setDeblocage] = useState(false);
  const [login, setLogin] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const champLogin = useRef<HTMLInputElement>(null);

  useEffect(() => {
    champLogin.current?.focus();
  }, []);

  const valider = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      await connecter(login, motDePasse);
    } catch (cause) {
      setErreur(messageDe(cause));
      setMotDePasse('');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-encre-100 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* Le logo est EMBARQUÉ dans le binaire, pas servi par un réseau :
              c'est le premier écran de la journée, et il doit s'afficher même
              quand la boutique n'a aucune connexion. */}
          <img src={logo} alt="MOBI STOCK" className="h-20 w-auto" />
          {shopName ? (
            <div>
              <h1 className="text-encre-900">{shopName}</h1>
              {shopCode ? <p className="text-xs text-encre-500">{shopCode}</p> : null}
            </div>
          ) : null}
        </div>

        <form
          className="carte space-y-1 p-5"
          onSubmit={(evenement) => {
            evenement.preventDefault();
            void valider();
          }}
        >
          {erreur ? <Erreur message={erreur} /> : null}

          <Champ
            ref={champLogin}
            label="Identifiant"
            autoComplete="username"
            value={login}
            onChange={(evenement) => setLogin(evenement.target.value)}
          />
          <Champ
            label="Mot de passe"
            type="password"
            autoComplete="current-password"
            value={motDePasse}
            onChange={(evenement) => setMotDePasse(evenement.target.value)}
          />

          <Bouton
            type="submit"
            variante="principal"
            taille="grand"
            pleineLargeur
            occupe={occupe}
            disabled={login.trim() === '' || motDePasse === ''}
          >
            Se connecter
          </Bouton>
        </form>

        {/* Discret, mais PRÉSENT sur l'écran de connexion : c'est le seul
            endroit où le cherchera quelqu'un qui ne peut plus entrer. */}
        <p className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setDeblocage(true)}
            className="text-xs text-marque-700 underline underline-offset-2 hover:text-marque-800"
          >
            Mot de passe administrateur oublié ?
          </button>
        </p>

        <p className="mt-3 text-center text-xs text-encre-400">
          Cette application fonctionne hors ligne. Aucune connexion Internet n'est nécessaire pour
          ouvrir la caisse.
        </p>

        {deblocage && db ? <Deblocage db={db} onFermer={() => setDeblocage(false)} /> : null}
      </div>
    </div>
  );
}

/**
 * Déblocage par la clé de secours.
 *
 * SANS SESSION : on est ici parce que personne ne peut plus se connecter. Toute
 * la vérification est dans `AuthService.resetWithRecoveryKey` — l'écran ne
 * décide de rien, il saisit et il affiche.
 *
 * La clé est REMPLACÉE à l'usage, et la nouvelle s'affiche aussitôt. Ne pas la
 * montrer laisserait la boutique sans filet au prochain oubli, ce qui est
 * exactement la situation qu'on vient de réparer.
 */
function Deblocage({ db, onFermer }: { db: SqlExecutor; onFermer: () => void }) {
  const [cle, setCle] = useState('');
  const [login, setLogin] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [nouvelleCle, setNouvelleCle] = useState<string | null>(null);

  const debloquer = async () => {
    setErreur(null);
    if (motDePasse !== confirmation) {
      setErreur('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setOccupe(true);
    try {
      const { nouvelleCle: suivante } = await new AuthService(db).resetWithRecoveryKey(
        cle,
        login,
        motDePasse,
      );
      setNouvelleCle(suivante);
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  if (nouvelleCle) {
    return (
      <Dialogue
        ouvert
        onFermer={onFermer}
        titre="Mot de passe réinitialisé"
        pied={
          <Bouton variante="principal" onClick={onFermer}>
            J’ai noté la nouvelle clé
          </Bouton>
        }
      >
        <Avertissement>
          <strong>Votre ancienne clé ne vaut plus rien.</strong> En voici une nouvelle : notez-la
          hors de cet ordinateur, elle ne sera plus affichée.
        </Avertissement>
        <p className="mono mt-3 select-all rounded-lg border-2 border-marque-300 bg-marque-50 px-4 py-3 text-center tracking-widest text-encre-900">
          {nouvelleCle}
        </p>
      </Dialogue>
    );
  }

  return (
    <Dialogue
      ouvert
      onFermer={onFermer}
      titre="Débloquer un compte administrateur"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton
            variante="principal"
            occupe={occupe}
            disabled={cle.trim() === '' || login.trim() === '' || motDePasse === ''}
            onClick={() => void debloquer()}
          >
            Réinitialiser
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        <Information>
          La clé de secours vous a été remise à l’installation du logiciel. Elle ne débloque qu’un
          compte administrateur, et sera remplacée par une nouvelle après usage.
        </Information>

        {erreur ? <Erreur message={erreur} /> : null}

        <Champ
          label="Clé de secours"
          value={cle}
          onChange={(evenement) => setCle(evenement.target.value)}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          aide="Les tirets, les espaces et les minuscules sont acceptés."
        />
        <Champ
          label="Identifiant du compte à débloquer"
          value={login}
          onChange={(evenement) => setLogin(evenement.target.value)}
        />
        <Champ
          label="Nouveau mot de passe"
          type="password"
          value={motDePasse}
          onChange={(evenement) => setMotDePasse(evenement.target.value)}
        />
        <Champ
          label="Confirmer le mot de passe"
          type="password"
          value={confirmation}
          onChange={(evenement) => setConfirmation(evenement.target.value)}
        />
      </div>
    </Dialogue>
  );
}
