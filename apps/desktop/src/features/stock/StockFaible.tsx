import { ProductRepository } from '@/core/db/repositories/product.repository';
import { toCsv, exportFileName } from '@/core/services/export.service';
import { Carte, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Tableau } from '@/components/ui/Tableau';
import { useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { useChargement, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Stock faible (§22).
 *
 * L'écran répond à « qu'est-ce que je dois racheter ? ». Le seuil de chaque
 * produit l'emporte sur le seuil général : un iPhone à une pièce et un câble à
 * cent n'ont pas la même urgence, et un seuil unique rendrait la liste inutile.
 */
export function StockFaible() {
  const { db, shopId, settings } = useSession();
  const { aller } = useNavigation();
  const monnaie = useMonnaie();

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new ProductRepository(db).search({
      shopId,
      lowStockOnly: true,
      lowStockFallback: settings.lowStockThreshold,
      limit: 300,
    });
  }, [db, shopId, settings.lowStockThreshold]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('stock-faible'),
      toCsv(etat.donnees.items, [
        { header: 'SKU', value: (l) => l.sku },
        { header: 'Désignation', value: (l) => l.name },
        { header: 'Marque', value: (l) => l.brand ?? '' },
        { header: 'Disponible', value: (l) => l.available },
        { header: 'Seuil', value: (l) => l.minStock || settings.lowStockThreshold },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Stock faible"
        sousTitre={`Produits dont le stock est au niveau du seuil d'alerte ou en dessous (seuil général : ${settings.lowStockThreshold}).`}
        actions={
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees}>
            Exporter
          </Bouton>
        }
      />

      {etat.donnees && etat.donnees.items.length === 0 ? (
        <Information>Aucun produit sous son seuil. Le stock est à niveau.</Information>
      ) : null}

      <Carte compact className="min-h-0 flex-1">
        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees?.items ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => aller('produits', ligne.id)}
            vide={{ icone: 'check', titre: 'Rien à réapprovisionner' }}
            colonnes={[
              {
                cle: 'nom',
                titre: 'Désignation',
                rendu: (l) => (
                  <div>
                    <div className="font-medium text-encre-900">{l.name}</div>
                    <div className="mono text-xs text-encre-500">{l.sku}</div>
                  </div>
                ),
              },
              { cle: 'marque', titre: 'Marque', rendu: (l) => l.brand ?? '—' },
              {
                cle: 'dispo',
                titre: 'Disponible',
                num: true,
                rendu: (l) => (
                  <Badge ton={l.available <= 0 ? 'danger' : 'attente'}>{l.available}</Badge>
                ),
              },
              {
                cle: 'seuil',
                titre: 'Seuil',
                num: true,
                rendu: (l) => l.minStock || settings.lowStockThreshold,
              },
              {
                cle: 'prix',
                titre: 'Prix de vente',
                num: true,
                rendu: (l) => monnaie(l.salePrice),
              },
            ]}
          />
        )}
      </Carte>
    </div>
  );
}
