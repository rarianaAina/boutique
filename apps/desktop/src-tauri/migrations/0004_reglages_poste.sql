-- ============================================================================
-- `setting.shop_id` : plus jamais NULL.
--
-- POURQUOI. Un réglage qui appartient au POSTE et non à une boutique — clé de
-- licence, cliquet d'horloge, empreinte de la clé de secours — s'écrivait avec
-- `shop_id` NULL. Deux défauts en découlaient, l'un déjà constaté, l'autre à
-- venir :
--
--  1. SQLite tient deux NULL pour DISTINCTS. La clé primaire `(key, shop_id)`
--     ne s'opposait donc à rien : chaque écriture d'un réglage du poste
--     ajoutait une ligne au lieu d'en remplacer une. Le cliquet d'horloge
--     n'avançait jamais, effacer une clé de licence ne l'effaçait pas, et une
--     clé de secours renouvelée laissait l'ancienne valable.
--
--  2. Postgres refuse un NULL dans une colonne de clé primaire. La base en
--     ligne n'aurait pas pu recevoir ces lignes, et la migration d'un
--     commerçant hors ligne vers l'offre en ligne aurait échoué chez lui.
--
-- Une chaîne vide dit la même chose qu'un NULL — « aucune boutique » — sans
-- aucun de ces deux inconvénients.
--
-- SQLite ne sait pas changer la nullabilité d'une colonne : on rebâtit la
-- table, ce qui est l'occasion d'effacer les doublons laissés par le défaut 1.
-- ============================================================================

CREATE TABLE setting_rebati (
  key        TEXT NOT NULL,
  shop_id    TEXT NOT NULL DEFAULT '',
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, shop_id)
);

-- @sqlite-uniquement — reprise de données : une base en ligne neuve n'a rien à
-- reprendre, et la forme `MAX(...)` avec colonnes nues est propre à SQLite.
--
-- Des doublons peuvent exister pour une même clé du poste (défaut 1). On garde
-- la ligne la plus récente : SQLite garantit que les colonnes nues d'un
-- regroupement à `MAX()` proviennent de la ligne qui porte ce maximum.
INSERT INTO setting_rebati (key, shop_id, value, updated_at)
SELECT key, COALESCE(shop_id, ''), value, MAX(updated_at)
  FROM setting
 GROUP BY key, COALESCE(shop_id, '');

DROP TABLE setting;

ALTER TABLE setting_rebati RENAME TO setting;
