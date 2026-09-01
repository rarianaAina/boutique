import { useState } from 'react';
import { Bouton } from '@/components/ui/Bouton';
import { Champ } from '@/components/ui/Champ';
import { Avertissement, Erreur, Information } from '@/components/ui/Page';
import logo from '@/assets/logo.png';
import { useSession } from '@/app/session';
import { messageDe } from '@/app/hooks';

/**
 * Premier démarrage.
 *
 * Une base neuve n'a ni boutique ni compte : afficher un formulaire de
 * connexion impossible à satisfaire serait une impasse. On demande donc le
 * strict nécessaire — la boutique et un administrateur — et rien d'autre : tout
 * le reste se règle ensuite, dans les paramètres.
 */
export function Installation() {
  const { installer, terminerInstallation } = useSession();
  /**
   * Clé de secours, montrée UNE FOIS.
   *
   * L'écran ne bascule pas tout seul vers la connexion : tant que cette clé
   * est affichée, elle est la seule chose qui compte. Elle n'existera plus
   * nulle part après — seule son empreinte est conservée.
   */
  const [cleSecours, setCleSecours] = useState<string | null>(null);
  const [notee, setNotee] = useState(false);
  const [copiee, setCopiee] = useState(false);
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [adresse, setAdresse] = useState('');
  const [telephone, setTelephone] = useState('');
  const [gerant, setGerant] = useState('');
  const [login, setLogin] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const valider = async () => {
    setErreur(null);
    if (motDePasse !== confirmation) {
      setErreur('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setOccupe(true);
    try {
      const cle = await installer({
        shopCode: code,
        shopName: nom,
        address: adresse || null,
        phone: telephone || null,
        adminFullName: gerant,
        adminLogin: login,
        adminPassword: motDePasse,
      });
      setCleSecours(cle);
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  if (cleSecours) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-encre-100 p-6">
        <div className="w-full max-w-2xl">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <img src={logo} alt="MOBI STOCK" className="h-20 w-auto" />
            <h1 className="text-encre-900">Votre clé de secours</h1>
          </div>

          <div className="carte space-y-4 p-6">
            <Avertissement>
              <strong>Notez cette clé et rangez-la hors de l’ordinateur.</strong> Elle est le seul
              moyen de rouvrir le logiciel si l’administrateur oublie son mot de passe. Elle ne sera
              plus jamais affichée : le logiciel n’en conserve qu’une empreinte, et personne — pas
              même l’éditeur — ne peut la retrouver.
            </Avertissement>

            <p className="mono select-all rounded-lg border-2 border-marque-300 bg-marque-50 px-4 py-4 text-center text-lg tracking-widest text-encre-900">
              {cleSecours}
            </p>

            <div className="flex justify-center">
              <Bouton
                onClick={() => {
                  void navigator.clipboard?.writeText(cleSecours).catch(() => undefined);
                  setCopiee(true);
                  setTimeout(() => setCopiee(false), 2000);
                }}
              >
                {copiee ? 'Copiée' : 'Copier la clé'}
              </Bouton>
            </div>

            <label className="flex items-start gap-2 text-sm text-encre-800">
              <input
                type="checkbox"
                checked={notee}
                onChange={(evenement) => setNotee(evenement.target.checked)}
                className="mt-0.5 size-4 rounded border-encre-300"
              />
              <span>
                J’ai noté cette clé ailleurs que sur cet ordinateur, et je comprends qu’elle ne sera
                plus affichée.
              </span>
            </label>

            <Bouton
              variante="principal"
              className="w-full"
              disabled={!notee}
              onClick={terminerInstallation}
            >
              Continuer vers la connexion
            </Bouton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-encre-100 p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src={logo} alt="MOBI STOCK" className="h-20 w-auto" />
          <h1 className="text-encre-900">Installation</h1>
          <p className="text-sm text-encre-600">
            Quelques informations suffisent pour commencer. Tout le reste se règle ensuite.
          </p>
        </div>

        <form
          className="carte space-y-4 p-6"
          onSubmit={(evenement) => {
            evenement.preventDefault();
            void valider();
          }}
        >
          {erreur ? <Erreur message={erreur} /> : null}

          <section>
            <h2 className="mb-2 text-encre-800">Votre boutique</h2>
            <div className="grid grid-cols-3 gap-3">
              <Champ
                label="Code"
                requis
                value={code}
                onChange={(evenement) => setCode(evenement.target.value.toUpperCase())}
                placeholder="CENT"
                aide="2 à 8 caractères."
              />
              <Champ
                label="Nom"
                requis
                className="col-span-2"
                value={nom}
                onChange={(evenement) => setNom(evenement.target.value)}
                placeholder="Boutique Centre"
              />
            </div>
            <Information>
              Le code apparaît dans tous les numéros de documents — par exemple{' '}
              <span className="mono">T-{code || 'CENT'}-2026-00001</span>. C'est lui qui rend un
              numéro unique dans tout le réseau, sans coordination entre les boutiques. Il ne pourra
              plus être modifié.
            </Information>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Champ
                label="Adresse"
                value={adresse}
                onChange={(evenement) => setAdresse(evenement.target.value)}
              />
              <Champ
                label="Téléphone"
                value={telephone}
                onChange={(evenement) => setTelephone(evenement.target.value)}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-encre-800">Compte administrateur</h2>
            <div className="grid grid-cols-2 gap-3">
              <Champ
                label="Nom complet"
                requis
                value={gerant}
                onChange={(evenement) => setGerant(evenement.target.value)}
              />
              <Champ
                label="Identifiant de connexion"
                requis
                value={login}
                onChange={(evenement) => setLogin(evenement.target.value)}
                aide="Court et sans espace."
              />
              <Champ
                label="Mot de passe"
                type="password"
                requis
                value={motDePasse}
                onChange={(evenement) => setMotDePasse(evenement.target.value)}
                aide="Au moins 8 caractères."
              />
              <Champ
                label="Confirmation"
                type="password"
                requis
                value={confirmation}
                onChange={(evenement) => setConfirmation(evenement.target.value)}
              />
            </div>
          </section>

          <Bouton
            type="submit"
            variante="principal"
            taille="grand"
            pleineLargeur
            occupe={occupe}
            disabled={
              code.trim() === '' || nom.trim() === '' || login.trim() === '' || motDePasse === ''
            }
          >
            Créer la boutique
          </Bouton>
        </form>
      </div>
    </div>
  );
}
