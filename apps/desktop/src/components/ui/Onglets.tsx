/**
 * Onglets d'un écran.
 *
 * Extrait d'« Utilisateurs et rôles », qui les avait écrits à la main, au
 * moment où un deuxième écran en a eu besoin. Deux implémentations du même
 * soulignement auraient fini par diverger d'un pixel, et l'application aurait
 * eu l'air d'avoir été assemblée par deux personnes.
 */
export function Onglets<T extends string>({
  valeur,
  onChanger,
  onglets,
}: {
  valeur: T;
  onChanger: (valeur: T) => void;
  onglets: { valeur: T; libelle: string }[];
}) {
  return (
    <div className="mb-3 flex gap-1 border-b border-encre-200">
      {onglets.map((onglet) => (
        <button
          key={onglet.valeur}
          type="button"
          onClick={() => onChanger(onglet.valeur)}
          aria-current={valeur === onglet.valeur ? 'page' : undefined}
          className={`border-b-2 px-3 py-1.5 text-sm ${
            valeur === onglet.valeur
              ? 'border-marque-600 font-medium text-marque-700'
              : 'border-transparent text-encre-600 hover:text-encre-900'
          }`}
        >
          {onglet.libelle}
        </button>
      ))}
    </div>
  );
}
