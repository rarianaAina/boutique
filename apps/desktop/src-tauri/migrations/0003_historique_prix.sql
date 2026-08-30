-- ============================================================================
-- Historique des prix.
--
-- POURQUOI UNE TABLE DÉDIÉE PLUTÔT QUE LE JOURNAL D'AUDIT.
--
-- Le journal d'audit consigne déjà les changements de prix, mais il consigne
-- AUSSI tout le reste : y chercher l'évolution d'un prix d'achat oblige à
-- filtrer des dizaines de milliers de lignes et à interpréter du JSON. Une
-- table dédiée, indexée par produit et par date, répond à la question en une
-- lecture d'index — et c'est une question qu'on pose souvent quand le cours
-- d'un fournisseur bouge.
--
-- DEUX SOURCES ALIMENTENT CETTE TABLE, et il faut les distinguer :
--
--  * le prix CATALOGUE, celui qu'un gérant saisit ou qu'un import modifie.
--    C'est une décision commerciale.
--  * le prix CONSTATÉ, celui réellement facturé par le fournisseur sur une
--    ligne d'achat, frais logistiques compris. C'est un fait, pas une
--    décision, et c'est lui qui reflète le cours réel.
--
-- Confondre les deux donnerait une courbe qui mélange ce qu'on a décidé et ce
-- qu'on a subi. `kind` les sépare.
-- ============================================================================

CREATE TABLE price_history (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES product (id),
  -- PURCHASE : prix d'achat catalogue. SALE : prix de vente. MIN : plancher.
  -- OBSERVED_PURCHASE : prix réellement payé au fournisseur.
  kind        TEXT NOT NULL
              CHECK (kind IN ('PURCHASE', 'SALE', 'MIN', 'OBSERVED_PURCHASE')),
  -- NULL à la création du produit : il n'y avait pas de valeur précédente.
  old_value   INTEGER,
  new_value   INTEGER NOT NULL,
  -- D'où vient le changement : saisie, import, réception d'achat.
  source      TEXT NOT NULL
              CHECK (source IN ('MANUAL', 'IMPORT', 'PURCHASE', 'SYNC')),
  source_id   TEXT,
  source_label TEXT,
  supplier_id TEXT REFERENCES supplier (id),
  shop_id     TEXT REFERENCES shop (id),
  user_id     TEXT REFERENCES app_user (id),
  user_label  TEXT,
  note        TEXT,
  at          TEXT NOT NULL
);

-- La requête de loin la plus fréquente : l'évolution d'un produit dans le temps.
CREATE INDEX ix_price_product ON price_history (product_id, kind, at DESC);
-- Le cours d'un fournisseur, tous produits confondus.
CREATE INDEX ix_price_supplier ON price_history (supplier_id, at DESC)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX ix_price_date ON price_history (at DESC);
