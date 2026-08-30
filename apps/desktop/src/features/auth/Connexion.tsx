import { useEffect, useRef, useState } from 'react';
import { Bouton } from '@/components/ui/Bouton';
import { Champ } from '@/components/ui/Champ';
import { Erreur } from '@/components/ui/Page';
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
  const { connecter, shopName, shopCode } = useSession();
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

        <p className="mt-4 text-center text-xs text-encre-400">
          Cette application fonctionne hors ligne. Aucune connexion Internet n'est nécessaire pour
          ouvrir la caisse.
        </p>
      </div>
    </div>
  );
}
