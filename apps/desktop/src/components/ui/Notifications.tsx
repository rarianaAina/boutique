import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icone } from './Icone';

/**
 * Notifications passagères.
 *
 * Elles servent à CONFIRMER une action réussie (« Ticket T-CENT-2026-00042
 * enregistré »), jamais à signaler une erreur bloquante : une erreur qui
 * disparaît toute seule au bout de cinq secondes n'a pas été lue. Les erreurs
 * s'affichent dans l'écran, à l'endroit où elles se sont produites.
 */
export type TonNotification = 'succes' | 'info' | 'erreur';

interface Notification {
  id: number;
  ton: TonNotification;
  message: string;
}

interface ContexteNotifications {
  notifier: (message: string, ton?: TonNotification) => void;
}

const Contexte = createContext<ContexteNotifications | null>(null);

/** Assez long pour être lu, assez court pour ne pas gêner. */
const DUREE_MS = 4500;

export function FournisseurNotifications({ children }: { children: ReactNode }) {
  const [liste, setListe] = useState<Notification[]>([]);

  const notifier = useCallback((message: string, ton: TonNotification = 'succes') => {
    const id = Date.now() + Math.random();
    setListe((precedent) => [...precedent, { id, ton, message }]);
    setTimeout(() => {
      setListe((precedent) => precedent.filter((element) => element.id !== id));
    }, DUREE_MS);
  }, []);

  const valeur = useMemo(() => ({ notifier }), [notifier]);

  const tons = {
    succes: 'border-succes-200 bg-succes-50 text-succes-900',
    info: 'border-marque-200 bg-marque-50 text-marque-900',
    erreur: 'border-danger-200 bg-danger-50 text-danger-900',
  } as const;

  return (
    <Contexte.Provider value={valeur}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {liste.map((notification) => (
          <div
            key={notification.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm shadow-flottant ${tons[notification.ton]}`}
          >
            <span className="mt-0.5 shrink-0">
              <Icone
                nom={
                  notification.ton === 'erreur'
                    ? 'alerte'
                    : notification.ton === 'info'
                      ? 'info'
                      : 'check'
                }
                taille={16}
              />
            </span>
            <span className="min-w-0 flex-1">{notification.message}</span>
            <button
              type="button"
              aria-label="Fermer"
              className="shrink-0 opacity-50 hover:opacity-100"
              onClick={() =>
                setListe((precedent) =>
                  precedent.filter((element) => element.id !== notification.id),
                )
              }
            >
              <Icone nom="croix" taille={14} />
            </button>
          </div>
        ))}
      </div>
    </Contexte.Provider>
  );
}

export function useNotifications(): ContexteNotifications {
  const contexte = useContext(Contexte);
  if (!contexte) throw new Error('useNotifications hors de son fournisseur');
  return contexte;
}
