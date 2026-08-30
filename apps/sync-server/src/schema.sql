-- ============================================================================
-- Journal du serveur de synchronisation.
--
-- Le serveur ne détient PAS l'état des boutiques : il ne fait que conserver et
-- ordonner leurs événements, et arbitrer la détention des identifiants uniques.
-- C'est ce qui permet à une boutique de fonctionner sans lui — il n'est un
-- point de passage que pour ce qui concerne DEUX boutiques.
-- ============================================================================

PRAGMA journal_mode = WAL;

-- Boutiques enrôlées, avec leur jeton d'accès.
CREATE TABLE IF NOT EXISTS shop (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen  TEXT
);

-- Journal ordonné. `seq` est attribué par le serveur : c'est LUI qui fait
-- l'ordre, jamais l'horloge d'un poste — deux boutiques peuvent avoir des
-- montres décalées de plusieurs minutes.
CREATE TABLE IF NOT EXISTS event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Identifiant produit par la boutique émettrice : clé d'idempotence. Un
  -- rejeu après coupure retombe sur cette contrainte et ne réapplique rien.
  id          TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  shop_id     TEXT NOT NULL,
  user_id     TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_event_shop ON event (shop_id, seq);
CREATE INDEX IF NOT EXISTS ix_event_entity ON event (entity, entity_id);

-- Registre de DÉTENTION des identifiants physiques.
--
-- Un IMEI est unique au monde : deux boutiques ne peuvent pas le détenir en
-- même temps. Cette table est l'arbitre. Elle ne bloque pas la vente courante
-- (une boutique vend hors ligne ce qu'elle détient) ; elle tranche au moment de
-- la synchronisation, et rend visible le conflit au lieu de le laisser passer.
CREATE TABLE IF NOT EXISTS identifier_registry (
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  unit_id    TEXT NOT NULL,
  shop_id    TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);

CREATE INDEX IF NOT EXISTS ix_registry_shop ON identifier_registry (shop_id);
CREATE INDEX IF NOT EXISTS ix_registry_unit ON identifier_registry (unit_id);

-- Position de lecture de chaque poste, pour le diagnostic d'un parc.
CREATE TABLE IF NOT EXISTS device_cursor (
  device_id  TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
