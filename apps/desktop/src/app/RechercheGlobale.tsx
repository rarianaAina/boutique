import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchService, type SearchHit } from '@/core/services/search.service';
import { Icone } from '@/components/ui/Icone';
import { Badge } from '@/components/ui/Badge';
import { useSession } from './session';
import { useNavigation } from './navigation';
import type { CleEcran } from './routes';

/**
 * Recherche globale (§23).
 *
 * Un seul champ pour tout retrouver : IMEI, numéro de série, SKU, code-barres,
 * nom de produit, client, ticket, facture, transfert.
 *
 * COMPORTEMENT VOULU AU COMPTOIR : le vendeur scanne un IMEI, la fiche de
 * l'appareil s'ouvre. Pas de liste à parcourir, pas de clic supplémentaire —
 * quand une seule fiche correspond exactement, on y va directement.
 */

const DESTINATIONS: Record<SearchHit['kind'], CleEcran> = {
  UNIT: 'appareils',
  PRODUCT: 'produits',
  CUSTOMER: 'clients',
  SALE: 'tickets',
  INVOICE: 'factures',
  TRANSFER: 'transferts',
  PURCHASE: 'achats',
  SUPPLIER: 'fournisseurs',
};

const LIBELLES: Record<SearchHit['kind'], string> = {
  UNIT: 'Appareil',
  PRODUCT: 'Produit',
  CUSTOMER: 'Client',
  SALE: 'Ticket',
  INVOICE: 'Facture',
  TRANSFER: 'Transfert',
  PURCHASE: 'Achat',
  SUPPLIER: 'Fournisseur',
};

/** Assez court pour paraître instantané, assez long pour ne pas requêter à chaque touche. */
const DELAI_MS = 180;

export function RechercheGlobale() {
  const { db } = useSession();
  const { aller } = useNavigation();
  const [texte, setTexte] = useState('');
  const [resultats, setResultats] = useState<SearchHit[]>([]);
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(0);
  const champ = useRef<HTMLInputElement>(null);
  const service = useMemo(() => (db ? new SearchService(db) : null), [db]);

  /* Ctrl+K, où qu'on soit : c'est le raccourci que tout le monde essaie. */
  useEffect(() => {
    const surTouche = (evenement: KeyboardEvent) => {
      if ((evenement.ctrlKey || evenement.metaKey) && evenement.key.toLowerCase() === 'k') {
        evenement.preventDefault();
        champ.current?.focus();
        champ.current?.select();
      }
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, []);

  useEffect(() => {
    if (!service || texte.trim().length < 2) {
      setResultats([]);
      return;
    }
    let annule = false;
    const minuteur = setTimeout(async () => {
      try {
        const reponse = await service.search(texte);
        if (annule) return;
        setResultats(reponse.hits);
        setActif(0);
        setOuvert(true);
      } catch {
        if (!annule) setResultats([]);
      }
    }, DELAI_MS);

    return () => {
      annule = true;
      clearTimeout(minuteur);
    };
  }, [service, texte]);

  const ouvrir = (resultat: SearchHit) => {
    aller(DESTINATIONS[resultat.kind], resultat.id);
    setOuvert(false);
    setTexte('');
    champ.current?.blur();
  };

  return (
    <div className="relative w-full max-w-xl">
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-encre-400">
          <Icone nom="recherche" taille={16} />
        </span>
        <input
          ref={champ}
          type="search"
          value={texte}
          onChange={(evenement) => setTexte(evenement.target.value)}
          onFocus={() => resultats.length > 0 && setOuvert(true)}
          onBlur={() => setTimeout(() => setOuvert(false), 150)}
          onKeyDown={(evenement) => {
            if (evenement.key === 'ArrowDown') {
              evenement.preventDefault();
              setActif((precedent) => Math.min(precedent + 1, resultats.length - 1));
            } else if (evenement.key === 'ArrowUp') {
              evenement.preventDefault();
              setActif((precedent) => Math.max(precedent - 1, 0));
            } else if (evenement.key === 'Enter') {
              const cible = resultats[actif];
              if (cible) ouvrir(cible);
            } else if (evenement.key === 'Escape') {
              setOuvert(false);
            }
          }}
          placeholder="IMEI, série, SKU, client, ticket…"
          className="h-9 w-full rounded-md border border-encre-300 bg-white pl-8 pr-16 text-sm placeholder:text-encre-400 focus:border-marque-500"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-encre-200 bg-encre-50 px-1.5 py-0.5 text-[10px] font-medium text-encre-500">
          Ctrl K
        </kbd>
      </div>

      {ouvert && resultats.length > 0 ? (
        <ul className="absolute z-40 mt-1 max-h-96 w-full overflow-auto rounded-md border border-encre-200 bg-white py-1 shadow-flottant">
          {resultats.map((resultat, index) => (
            <li key={`${resultat.kind}-${resultat.id}`}>
              <button
                type="button"
                onMouseDown={(evenement) => evenement.preventDefault()}
                onClick={() => ouvrir(resultat)}
                onMouseEnter={() => setActif(index)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
                  index === actif ? 'bg-marque-50' : 'hover:bg-encre-50'
                }`}
              >
                <Badge ton={resultat.exact ? 'info' : 'neutre'}>{LIBELLES[resultat.kind]}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-encre-900">{resultat.title}</span>
                  <span className="block truncate text-xs text-encre-500">{resultat.subtitle}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
