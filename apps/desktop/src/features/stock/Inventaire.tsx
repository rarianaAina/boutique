import { useState } from 'react';
import { InventoryService, type InventoryLineView } from '@/core/services/inventory.service';
import { toCsv, exportFileName } from '@/core/services/export.service';
import { Carte, Chargement, EnTetePage, Erreur, Information, Vide } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Confirmation } from '@/components/ui/Dialogue';
import { ChampRecherche } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Inventaire physique.
 *
 * Le comptage n'écrit RIEN dans le stock : il remplit une feuille. Les écarts
 * ne deviennent des mouvements qu'à la validation. C'est ce qui permet de
 * compter à plusieurs, sur plusieurs heures, de recompter une allée, et de ne
 * toucher au stock qu'une fois, quand le responsable est sûr.
 *
 * Les lignes NON comptées sont ignorées à la validation : un inventaire partiel
 * est la norme, et considérer « non compté » comme « absent » ferait disparaître
 * du stock bien réel.
 */
export function Inventaire() {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recherche, setRecherche] = useState('');
  const [validation, setValidation] = useState(false);
  const [occupe, setOccupe] = useState(false);

  const service = new InventoryService(contexte);

  const sessions = useChargement(async () => service.list(20), [contexte.db, sessionId]);

  const courante = useChargement(async () => {
    const ouverte = (sessions.donnees ?? []).find((element) => element.status === 'OPEN') ?? null;
    const cible = sessionId ?? ouverte?.id ?? null;
    if (!cible) return null;
    const [session, lignes] = await Promise.all([service.byId(cible), service.lines(cible)]);
    return session ? { session, lignes } : null;
  }, [contexte.db, sessionId, sessions.donnees]);

  const ouvrir = async () => {
    setOccupe(true);
    try {
      const id = await service.open();
      setSessionId(id);
      sessions.recharger();
      notifier('Inventaire ouvert. Le stock attendu a été photographié.');
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const compter = async (ligne: InventoryLineView, valeur: string) => {
    const quantite = Number(valeur);
    if (!Number.isFinite(quantite) || quantite < 0) return;
    await service.count(ligne.id, quantite);
    courante.recharger();
  };

  const valider = async () => {
    if (!courante.donnees) return;
    setOccupe(true);
    try {
      const resultat = await service.apply(courante.donnees.session.id);
      notifier(
        resultat.adjusted === 0
          ? 'Inventaire validé : aucun écart.'
          : `Inventaire validé : ${resultat.adjusted} écart(s), solde ${resultat.difference > 0 ? '+' : ''}${resultat.difference}.`,
      );
      setValidation(false);
      setSessionId(null);
      sessions.recharger();
      courante.recharger();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const lignes = (courante.donnees?.lignes ?? []).filter((ligne) => {
    if (recherche.trim() === '') return true;
    const terme = recherche.toLowerCase();
    return (
      ligne.productName.toLowerCase().includes(terme) ||
      ligne.sku.toLowerCase().includes(terme) ||
      (ligne.identifier ?? '').toLowerCase().includes(terme)
    );
  });

  const ecarts = (courante.donnees?.lignes ?? []).filter(
    (ligne) => ligne.counted !== null && ligne.counted !== ligne.expected,
  );
  const comptees = (courante.donnees?.lignes ?? []).filter((ligne) => ligne.counted !== null);

  const exporter = () => {
    if (!courante.donnees) return;
    telecharger(
      exportFileName('inventaire'),
      toCsv(courante.donnees.lignes, [
        { header: 'Produit', value: (l) => l.productName },
        { header: 'SKU', value: (l) => l.sku },
        { header: 'Identifiant', value: (l) => l.identifier ?? '' },
        { header: 'Attendu', value: (l) => l.expected },
        { header: 'Compté', value: (l) => (l.counted === null ? '' : l.counted) },
        { header: 'Écart', value: (l) => (l.counted === null ? '' : l.counted - l.expected) },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Inventaire"
        sousTitre={
          courante.donnees
            ? `${courante.donnees.session.number} · ouvert le ${formaterDate(courante.donnees.session.startedAt, true)}`
            : 'Aucun inventaire en cours'
        }
        actions={
          courante.donnees && courante.donnees.session.status === 'OPEN' ? (
            <>
              <Bouton icone="export" onClick={exporter}>
                Exporter la feuille
              </Bouton>
              <Bouton
                variante="principal"
                icone="check"
                disabled={comptees.length === 0}
                onClick={() => setValidation(true)}
              >
                Valider l'inventaire
              </Bouton>
            </>
          ) : (
            <Bouton variante="principal" icone="plus" occupe={occupe} onClick={() => void ouvrir()}>
              Ouvrir un inventaire
            </Bouton>
          )
        }
      />

      {courante.chargement ? (
        <Chargement />
      ) : courante.erreur ? (
        <Erreur message={courante.erreur} />
      ) : !courante.donnees ? (
        <Carte>
          <Vide
            icone="inventaire"
            titre="Aucun inventaire ouvert"
            detail="L'ouverture photographie le stock attendu. Vous pouvez ensuite compter sur plusieurs heures ; rien n'est modifié avant la validation."
          />
        </Carte>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Compteur libelle="Lignes à compter" valeur={courante.donnees.lignes.length} />
            <Compteur libelle="Comptées" valeur={comptees.length} />
            <Compteur
              libelle="Écarts"
              valeur={ecarts.length}
              ton={ecarts.length > 0 ? 'attente' : 'neutre'}
            />
            <Compteur
              libelle="Solde des écarts"
              valeur={ecarts.reduce(
                (somme, ligne) => somme + ((ligne.counted ?? 0) - ligne.expected),
                0,
              )}
            />
          </div>

          {courante.donnees.session.status !== 'OPEN' ? (
            <Information>
              Cet inventaire est {courante.donnees.session.status === 'APPLIED' ? 'validé' : 'clos'}{' '}
              : il ne peut plus être modifié.
            </Information>
          ) : null}

          <Carte compact className="min-h-0 flex-1">
            <div className="border-b border-encre-200 bg-encre-50/60 px-3 py-2.5">
              <ChampRecherche
                valeur={recherche}
                onChanger={setRecherche}
                placeholder="Filtrer par produit, SKU ou IMEI…"
                largeur="w-80"
                autoFocus
              />
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th>Identifiant</th>
                    <th className="num">Attendu</th>
                    <th className="num" style={{ width: '7rem' }}>
                      Compté
                    </th>
                    <th className="num">Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((ligne) => {
                    const ecart = ligne.counted === null ? null : ligne.counted - ligne.expected;
                    return (
                      <tr key={ligne.id}>
                        <td>
                          <div>{ligne.productName}</div>
                          <div className="mono text-xs text-encre-500">{ligne.sku}</div>
                        </td>
                        <td className="mono">{ligne.identifier ?? '—'}</td>
                        <td className="num">{ligne.expected}</td>
                        <td className="num">
                          <input
                            defaultValue={ligne.counted ?? ''}
                            inputMode="numeric"
                            disabled={courante.donnees?.session.status !== 'OPEN'}
                            onBlur={(evenement) => void compter(ligne, evenement.target.value)}
                            className="h-7 w-20 rounded border border-encre-300 px-2 text-right"
                            data-nombre
                          />
                        </td>
                        <td className="num">
                          {ecart === null ? (
                            <span className="text-encre-400">—</span>
                          ) : ecart === 0 ? (
                            <Badge ton="succes">0</Badge>
                          ) : (
                            <Badge ton={ecart > 0 ? 'info' : 'danger'}>
                              {ecart > 0 ? `+${ecart}` : ecart}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Carte>
        </>
      )}

      <Confirmation
        ouvert={validation}
        titre="Valider l'inventaire"
        libelleAction="Valider et écrire les écarts"
        occupe={occupe}
        onConfirmer={() => void valider()}
        onFermer={() => setValidation(false)}
        message={
          <>
            {ecarts.length} écart(s) vont être écrits sous forme de mouvements de stock. Les lignes
            non comptées sont ignorées : elles ne seront pas mises à zéro. Un appareil compté absent
            passera au statut « perdu », sans disparaître de l'historique.
          </>
        }
      />
    </div>
  );
}

function Compteur({
  libelle,
  valeur,
  ton = 'neutre',
}: {
  libelle: string;
  valeur: number;
  ton?: 'neutre' | 'attente';
}) {
  return (
    <div className="carte px-4 py-2.5">
      <p className="text-xs text-encre-500">{libelle}</p>
      <p
        className={`text-lg font-semibold ${ton === 'attente' ? 'text-alerte-700' : 'text-encre-900'}`}
        data-nombre
      >
        {valeur}
      </p>
    </div>
  );
}
