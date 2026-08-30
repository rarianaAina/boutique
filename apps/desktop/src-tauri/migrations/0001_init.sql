-- ============================================================================
-- Schéma initial de la base locale d'une boutique.
--
-- PRINCIPES QUI GOUVERNENT TOUT CE FICHIER
--
--  1. IDENTIFIANTS TEXTE. Aucune clé auto-incrémentée : une boutique hors ligne
--     doit pouvoir créer des lignes sans risquer de heurter celles d'une autre
--     au moment de la synchronisation.
--
--  2. ARGENT EN ENTIERS. Tous les montants sont dans la plus petite unité de la
--     devise. SQLite stockerait volontiers des flottants ; on ne lui en donne
--     jamais l'occasion.
--
--  3. DATES ISO 8601 UTC, en TEXT. Comparables par ordre alphabétique, donc
--     indexables et filtrables sans fonction.
--
--  4. SUPPRESSION LOGIQUE. `deleted_at` partout où la donnée a une valeur
--     comptable ou historique. Un mouvement de stock et une vente validée ne
--     s'effacent JAMAIS.
--
--  5. CONTRAINTES CHECK reprenant les énumérations de @boutique/shared. Une
--     valeur inconnue est refusée à l'écriture, pas découverte à la lecture.
--
-- Les clés étrangères sont actives : sqlx ouvre SQLite avec `foreign_keys=ON`.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Boutiques ──────────────────────────────────────────────────────────────
-- Le réseau entier est décrit dans CHAQUE base locale : sans cela, une boutique
-- hors ligne ne pourrait pas préparer un transfert vers une destination qu'elle
-- ne connaît pas. `is_local` désigne celle installée sur ce poste.
CREATE TABLE shop (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  is_local    INTEGER NOT NULL DEFAULT 0 CHECK (is_local IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- Une seule boutique locale par poste : l'index partiel rend l'erreur
-- impossible plutôt que de compter sur le code applicatif.
CREATE UNIQUE INDEX ux_shop_local ON shop (is_local) WHERE is_local = 1;

-- ─── Rôles et utilisateurs ──────────────────────────────────────────────────
-- Les permissions sont une liste JSON : leur nombre change à chaque version du
-- logiciel, et une table de liaison obligerait à une migration pour chaque
-- nouvelle permission. La liste est validée côté TypeScript avant écriture.
CREATE TABLE role (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE app_user (
  id              TEXT PRIMARY KEY,
  shop_id         TEXT NOT NULL REFERENCES shop (id),
  full_name       TEXT NOT NULL,
  login           TEXT NOT NULL,
  email           TEXT,
  -- Format `pbkdf2-sha256$<itérations>$<sel>$<empreinte>`. Jamais de clair.
  password_hash   TEXT NOT NULL,
  role_id         TEXT NOT NULL REFERENCES role (id),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  last_login_at   TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE UNIQUE INDEX ux_user_login ON app_user (login) WHERE deleted_at IS NULL;
CREATE INDEX ix_user_shop ON app_user (shop_id, status);

-- ─── Catalogue ──────────────────────────────────────────────────────────────
CREATE TABLE category (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES category (id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX ux_category_code ON category (code) WHERE deleted_at IS NULL;
CREATE INDEX ix_category_parent ON category (parent_id);

CREATE TABLE supplier (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  company    TEXT,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  country    TEXT,
  terms      TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  search_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX ux_supplier_code ON supplier (code) WHERE deleted_at IS NULL;
CREATE INDEX ix_supplier_search ON supplier (search_key);

-- Le produit est le MODÈLE (« iPhone 15 128 Go noir »), jamais l'exemplaire.
-- `tracking` est le discriminant du modèle de stock : IMEI et SERIAL créent des
-- lignes dans `product_unit`, QUANTITY alimente `stock_level`.
CREATE TABLE product (
  id                  TEXT PRIMARY KEY,
  sku                 TEXT NOT NULL,
  reference           TEXT,
  barcode             TEXT,
  name                TEXT NOT NULL,
  brand               TEXT,
  model               TEXT,
  category_id         TEXT REFERENCES category (id),
  description         TEXT,
  tracking            TEXT NOT NULL DEFAULT 'QUANTITY'
                      CHECK (tracking IN ('IMEI', 'SERIAL', 'QUANTITY')),
  purchase_price      INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  sale_price          INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  min_price           INTEGER CHECK (min_price IS NULL OR min_price >= 0),
  -- TVA en centièmes de point : 20 % = 2000. NULL = hors champ de la taxe.
  tax_rate            INTEGER CHECK (tax_rate IS NULL OR tax_rate >= 0),
  default_supplier_id TEXT REFERENCES supplier (id),
  unit                TEXT NOT NULL DEFAULT 'pièce',
  min_stock           INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  photo_path          TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'DISCONTINUED', 'ARCHIVED')),
  -- Caractéristiques libres (capacité, RAM, couleur…), en JSON : elles varient
  -- d'une famille de produits à l'autre et n'ont pas à figer le schéma.
  attributes          TEXT NOT NULL DEFAULT '{}',
  -- Clé de recherche précalculée, sans accent ni ponctuation (§31).
  search_key          TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

CREATE UNIQUE INDEX ux_product_sku ON product (sku) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_barcode ON product (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ix_product_search ON product (search_key);
CREATE INDEX ix_product_category ON product (category_id, status);
CREATE INDEX ix_product_brand ON product (brand, model);

-- ─── Unités physiques ───────────────────────────────────────────────────────
-- Une ligne = UN appareil, avec son propre statut et son propre historique.
-- `shop_id` désigne la boutique qui le DÉTIENT ; il ne change qu'à la réception
-- d'un transfert, jamais à l'expédition (tant que le colis roule, l'unité reste
-- rattachée à l'expéditeur, en statut IN_TRANSFER).
CREATE TABLE product_unit (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES product (id),
  shop_id      TEXT NOT NULL REFERENCES shop (id),
  status       TEXT NOT NULL DEFAULT 'IN_STOCK'
               CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'IN_TRANSFER',
                                 'TRANSFERRED', 'RETURNED', 'EXCHANGED', 'REFUNDED',
                                 'DEFECTIVE', 'LOST', 'BLOCKED')),
  condition    TEXT NOT NULL DEFAULT 'NEW'
               CHECK (condition IN ('NEW', 'OPEN_BOX', 'REFURBISHED', 'USED', 'DAMAGED')),
  color        TEXT,
  capacity     TEXT,
  -- Coût d'acquisition RÉEL, frais logistiques ventilés inclus (§11).
  cost_price   INTEGER NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  supplier_id  TEXT REFERENCES supplier (id),
  purchase_id  TEXT,
  received_at  TEXT,
  sold_at      TEXT,
  sale_id      TEXT,
  transfer_id  TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX ix_unit_product ON product_unit (product_id, status);
CREATE INDEX ix_unit_shop ON product_unit (shop_id, status);
CREATE INDEX ix_unit_sale ON product_unit (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX ix_unit_purchase ON product_unit (purchase_id) WHERE purchase_id IS NOT NULL;

-- Identifiants physiques d'une unité : IMEI 1, IMEI 2 (bi-SIM), n° de série.
--
-- POURQUOI UNE TABLE SÉPARÉE plutôt que trois colonnes : l'unicité doit valoir
-- ENTRE LES EMPLACEMENTS. Avec des colonnes, rien n'empêcherait l'IMEI 1 d'un
-- appareil d'être l'IMEI 2 d'un autre — ce qui est exactement le doublon que le
-- cahier des charges interdit (§2). Ici, un seul index le rend impossible.
CREATE TABLE unit_identifier (
  id      TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES product_unit (id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('IMEI', 'SERIAL')),
  slot    INTEGER NOT NULL DEFAULT 1 CHECK (slot IN (1, 2)),
  value   TEXT NOT NULL
);

-- L'unicité globale de l'IMEI, le garde-fou le plus important du logiciel.
CREATE UNIQUE INDEX ux_identifier_value ON unit_identifier (kind, value);
CREATE UNIQUE INDEX ux_identifier_slot ON unit_identifier (unit_id, kind, slot);
-- Recherche par IMEI : lecture d'index pure, quel que soit le volume (§31).
CREATE INDEX ix_identifier_lookup ON unit_identifier (value);

-- Vue de confort : l'unité avec ses identifiants à plat. Les écrans de liste
-- lisent celle-ci, les écritures passent toujours par les deux tables.
CREATE VIEW v_unit AS
SELECT
  u.*,
  (SELECT value FROM unit_identifier i WHERE i.unit_id = u.id AND i.kind = 'IMEI'   AND i.slot = 1) AS imei1,
  (SELECT value FROM unit_identifier i WHERE i.unit_id = u.id AND i.kind = 'IMEI'   AND i.slot = 2) AS imei2,
  (SELECT value FROM unit_identifier i WHERE i.unit_id = u.id AND i.kind = 'SERIAL' AND i.slot = 1) AS serial
FROM product_unit u;

-- ─── Stock des produits non sérialisés ──────────────────────────────────────
CREATE TABLE stock_level (
  product_id TEXT NOT NULL REFERENCES product (id),
  shop_id    TEXT NOT NULL REFERENCES shop (id),
  quantity   INTEGER NOT NULL DEFAULT 0,
  -- Engagé mais pas encore sorti : panier en attente, transfert demandé.
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, shop_id)
);

CREATE INDEX ix_stock_shop ON stock_level (shop_id, quantity);

-- ─── Mouvements de stock ────────────────────────────────────────────────────
-- La mémoire du logiciel. Aucune quantité ne bouge sans une ligne ici, et
-- aucune ligne n'est jamais modifiée ni supprimée : une correction s'écrit en
-- ajoutant un mouvement inverse.
CREATE TABLE stock_movement (
  id           TEXT PRIMARY KEY,
  shop_id      TEXT NOT NULL REFERENCES shop (id),
  product_id   TEXT NOT NULL REFERENCES product (id),
  unit_id      TEXT REFERENCES product_unit (id),
  type         TEXT NOT NULL
               CHECK (type IN ('PURCHASE_RECEIPT', 'SALE', 'SALE_CANCELLED', 'CUSTOMER_RETURN',
                               'REFUND', 'EXCHANGE_OUT', 'EXCHANGE_IN', 'TRANSFER_OUT',
                               'TRANSFER_IN', 'ADJUSTMENT', 'INVENTORY', 'LOSS', 'BREAKAGE',
                               'SUPPLIER_RETURN')),
  -- Signée : positive à l'entrée, négative à la sortie. Le signe est stocké, pas
  -- déduit du type — une correction d'inventaire va dans les deux sens.
  quantity     INTEGER NOT NULL CHECK (quantity <> 0),
  unit_cost    INTEGER,
  source       TEXT NOT NULL
               CHECK (source IN ('PURCHASE', 'SALE', 'REFUND', 'EXCHANGE', 'TRANSFER',
                                 'INVENTORY', 'MANUAL', 'IMPORT')),
  source_id    TEXT,
  -- Numéro du document d'origine, recopié : l'historique reste lisible même si
  -- le document est archivé ou renuméroté.
  source_label TEXT,
  user_id      TEXT REFERENCES app_user (id),
  occurred_at  TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX ix_movement_shop_date ON stock_movement (shop_id, occurred_at DESC);
CREATE INDEX ix_movement_product ON stock_movement (product_id, occurred_at DESC);
CREATE INDEX ix_movement_unit ON stock_movement (unit_id, occurred_at) WHERE unit_id IS NOT NULL;
CREATE INDEX ix_movement_source ON stock_movement (source, source_id);

-- ─── Clients ────────────────────────────────────────────────────────────────
CREATE TABLE customer (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT REFERENCES shop (id),
  first_name TEXT,
  last_name  TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  notes      TEXT,
  search_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX ix_customer_search ON customer (search_key);
CREATE INDEX ix_customer_phone ON customer (phone) WHERE phone IS NOT NULL;

-- ─── Achats ─────────────────────────────────────────────────────────────────
CREATE TABLE purchase (
  id                 TEXT PRIMARY KEY,
  shop_id            TEXT NOT NULL REFERENCES shop (id),
  number             TEXT NOT NULL,
  supplier_id        TEXT NOT NULL REFERENCES supplier (id),
  supplier_reference TEXT,
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED',
                                       'RECEIVED', 'CLOSED', 'CANCELLED')),
  ordered_at         TEXT,
  expected_at        TEXT,
  subtotal           INTEGER NOT NULL DEFAULT 0,
  discount           INTEGER NOT NULL DEFAULT 0,
  tax                INTEGER NOT NULL DEFAULT 0,
  landed_cost_total  INTEGER NOT NULL DEFAULT 0,
  total              INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  created_by         TEXT NOT NULL REFERENCES app_user (id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);

CREATE UNIQUE INDEX ux_purchase_number ON purchase (shop_id, number);
CREATE INDEX ix_purchase_supplier ON purchase (supplier_id, ordered_at DESC);
CREATE INDEX ix_purchase_status ON purchase (shop_id, status, created_at DESC);

CREATE TABLE purchase_line (
  id                TEXT PRIMARY KEY,
  purchase_id       TEXT NOT NULL REFERENCES purchase (id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES product (id),
  label             TEXT NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_price        INTEGER NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount          INTEGER NOT NULL DEFAULT 0,
  tax_rate          INTEGER,
  line_total        INTEGER NOT NULL DEFAULT 0,
  -- Part des frais logistiques imputée à cette ligne, une fois ventilés.
  allocated_cost    INTEGER NOT NULL DEFAULT 0,
  position          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_purchase_line_purchase ON purchase_line (purchase_id, position);
CREATE INDEX ix_purchase_line_product ON purchase_line (product_id);

-- Coûts logistiques rattachés à un achat (§11) : transport, douane, assurance…
CREATE TABLE landed_cost (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchase (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
              CHECK (kind IN ('TRANSPORT', 'DELIVERY', 'CUSTOMS', 'INSURANCE',
                              'HANDLING', 'OTHER')),
  label       TEXT,
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  -- Clé de ventilation : au prorata de la valeur des lignes, ou des quantités.
  allocation  TEXT NOT NULL DEFAULT 'BY_VALUE'
              CHECK (allocation IN ('BY_VALUE', 'BY_QUANTITY')),
  created_at  TEXT NOT NULL
);

CREATE INDEX ix_landed_cost_purchase ON landed_cost (purchase_id);

CREATE TABLE purchase_receipt (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchase (id),
  shop_id     TEXT NOT NULL REFERENCES shop (id),
  received_at TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES app_user (id),
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX ix_receipt_purchase ON purchase_receipt (purchase_id, received_at);

CREATE TABLE purchase_receipt_line (
  id               TEXT PRIMARY KEY,
  receipt_id       TEXT NOT NULL REFERENCES purchase_receipt (id) ON DELETE CASCADE,
  purchase_line_id TEXT NOT NULL REFERENCES purchase_line (id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX ix_receipt_line_receipt ON purchase_receipt_line (receipt_id);

-- ─── Ventes ─────────────────────────────────────────────────────────────────
CREATE TABLE sale (
  id           TEXT PRIMARY KEY,
  shop_id      TEXT NOT NULL REFERENCES shop (id),
  number       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'COMPLETED'
               CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REFUNDED',
                                 'PARTIALLY_REFUNDED')),
  customer_id  TEXT REFERENCES customer (id),
  user_id      TEXT NOT NULL REFERENCES app_user (id),
  sold_at      TEXT NOT NULL,
  subtotal     INTEGER NOT NULL DEFAULT 0,
  discount     INTEGER NOT NULL DEFAULT 0,
  tax          INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  paid         INTEGER NOT NULL DEFAULT 0,
  change_given INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES app_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE UNIQUE INDEX ux_sale_number ON sale (shop_id, number);
CREATE INDEX ix_sale_date ON sale (shop_id, sold_at DESC);
CREATE INDEX ix_sale_user ON sale (user_id, sold_at DESC);
CREATE INDEX ix_sale_customer ON sale (customer_id, sold_at DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE sale_line (
  id                TEXT PRIMARY KEY,
  sale_id           TEXT NOT NULL REFERENCES sale (id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES product (id),
  unit_id           TEXT REFERENCES product_unit (id),
  label             TEXT NOT NULL,
  -- IMEI ou n° de série recopié : un ticket doit rester lisible sans jointure.
  identifier        TEXT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price        INTEGER NOT NULL CHECK (unit_price >= 0),
  discount          INTEGER NOT NULL DEFAULT 0,
  tax_rate          INTEGER,
  line_total        INTEGER NOT NULL,
  -- Coût figé à l'instant de la vente : la marge historique ne bouge plus,
  -- même si le prix d'achat du produit change ensuite.
  unit_cost         INTEGER NOT NULL DEFAULT 0,
  refunded_quantity INTEGER NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  position          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_sale_line_sale ON sale_line (sale_id, position);
CREATE INDEX ix_sale_line_product ON sale_line (product_id);
CREATE INDEX ix_sale_line_unit ON sale_line (unit_id) WHERE unit_id IS NOT NULL;

CREATE TABLE payment_method (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  change_allowed INTEGER NOT NULL DEFAULT 0 CHECK (change_allowed IN (0, 1)),
  position       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sale_payment (
  id        TEXT PRIMARY KEY,
  sale_id   TEXT NOT NULL REFERENCES sale (id) ON DELETE CASCADE,
  method    TEXT NOT NULL REFERENCES payment_method (code),
  amount    INTEGER NOT NULL,
  reference TEXT,
  paid_at   TEXT NOT NULL
);

CREATE INDEX ix_payment_sale ON sale_payment (sale_id);
CREATE INDEX ix_payment_method ON sale_payment (method, paid_at);

-- ─── Factures ───────────────────────────────────────────────────────────────
-- `sale_id` est facultatif : une facture peut être émise sans passage en caisse.
CREATE TABLE invoice (
  id          TEXT PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shop (id),
  number      TEXT NOT NULL,
  sale_id     TEXT REFERENCES sale (id),
  customer_id TEXT REFERENCES customer (id),
  status      TEXT NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID',
                                'CANCELLED', 'REFUNDED')),
  issued_at   TEXT NOT NULL,
  due_at      TEXT,
  subtotal    INTEGER NOT NULL DEFAULT 0,
  discount    INTEGER NOT NULL DEFAULT 0,
  tax         INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  paid        INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE UNIQUE INDEX ux_invoice_number ON invoice (shop_id, number);
CREATE UNIQUE INDEX ux_invoice_sale ON invoice (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX ix_invoice_customer ON invoice (customer_id, issued_at DESC);

-- ─── Remboursements ─────────────────────────────────────────────────────────
CREATE TABLE refund (
  id          TEXT PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shop (id),
  number      TEXT NOT NULL,
  sale_id     TEXT NOT NULL REFERENCES sale (id),
  status      TEXT NOT NULL DEFAULT 'COMPLETED'
              CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
  reason      TEXT,
  method      TEXT NOT NULL REFERENCES payment_method (code),
  total       INTEGER NOT NULL CHECK (total >= 0),
  user_id     TEXT NOT NULL REFERENCES app_user (id),
  refunded_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE UNIQUE INDEX ux_refund_number ON refund (shop_id, number);
CREATE INDEX ix_refund_sale ON refund (sale_id, refunded_at);

CREATE TABLE refund_line (
  id           TEXT PRIMARY KEY,
  refund_id    TEXT NOT NULL REFERENCES refund (id) ON DELETE CASCADE,
  sale_line_id TEXT NOT NULL REFERENCES sale_line (id),
  product_id   TEXT NOT NULL REFERENCES product (id),
  unit_id      TEXT REFERENCES product_unit (id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  -- Faux quand l'article revient cassé : il est remboursé sans rejoindre le stock.
  restock      INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0, 1))
);

CREATE INDEX ix_refund_line_refund ON refund_line (refund_id);
CREATE INDEX ix_refund_line_sale_line ON refund_line (sale_line_id);

-- ─── Échanges ───────────────────────────────────────────────────────────────
-- L'échange NE MODIFIE PAS la vente d'origine (§15) : il la référence, reprend
-- une unité et en sort une autre. `new_sale_id` porte l'encaissement éventuel
-- de la différence de prix.
CREATE TABLE exchange (
  id               TEXT PRIMARY KEY,
  shop_id          TEXT NOT NULL REFERENCES shop (id),
  number           TEXT NOT NULL,
  original_sale_id TEXT NOT NULL REFERENCES sale (id),
  new_sale_id      TEXT REFERENCES sale (id),
  returned_unit_id TEXT NOT NULL REFERENCES product_unit (id),
  new_unit_id      TEXT REFERENCES product_unit (id),
  new_product_id   TEXT REFERENCES product (id),
  -- Positive : le client complète. Négative : la boutique rembourse.
  price_difference INTEGER NOT NULL DEFAULT 0,
  settled_method   TEXT REFERENCES payment_method (code),
  reason           TEXT,
  user_id          TEXT NOT NULL REFERENCES app_user (id),
  exchanged_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);

CREATE UNIQUE INDEX ux_exchange_number ON exchange (shop_id, number);
CREATE INDEX ix_exchange_sale ON exchange (original_sale_id);
CREATE INDEX ix_exchange_unit ON exchange (returned_unit_id);

-- ─── Transferts inter-boutiques ─────────────────────────────────────────────
CREATE TABLE transfer (
  id               TEXT PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE,
  from_shop_id     TEXT NOT NULL REFERENCES shop (id),
  to_shop_id       TEXT NOT NULL REFERENCES shop (id),
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'REQUESTED', 'APPROVED', 'SHIPPED',
                                     'IN_TRANSIT', 'RECEIVED', 'REJECTED', 'CANCELLED')),
  requested_by     TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  approved_at      TEXT,
  shipped_at       TEXT,
  received_at      TEXT,
  received_by      TEXT,
  note             TEXT,
  rejection_reason TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  -- Une boutique ne se transfère pas à elle-même : l'erreur de saisie est
  -- refusée par la base, pas seulement par l'écran.
  CHECK (from_shop_id <> to_shop_id)
);

CREATE INDEX ix_transfer_from ON transfer (from_shop_id, status, requested_at DESC);
CREATE INDEX ix_transfer_to ON transfer (to_shop_id, status, requested_at DESC);

CREATE TABLE transfer_line (
  id                TEXT PRIMARY KEY,
  transfer_id       TEXT NOT NULL REFERENCES transfer (id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES product (id),
  unit_id           TEXT REFERENCES product_unit (id),
  label             TEXT NOT NULL,
  identifier        TEXT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  position          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_transfer_line_transfer ON transfer_line (transfer_id, position);
-- Une unité ne peut pas figurer deux fois dans le même transfert.
CREATE UNIQUE INDEX ux_transfer_line_unit ON transfer_line (transfer_id, unit_id)
  WHERE unit_id IS NOT NULL;

-- ─── Inventaire ─────────────────────────────────────────────────────────────
CREATE TABLE inventory_session (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shop (id),
  number     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN'
             CHECK (status IN ('OPEN', 'COUNTED', 'APPLIED', 'CANCELLED')),
  started_by TEXT NOT NULL REFERENCES app_user (id),
  started_at TEXT NOT NULL,
  applied_at TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX ux_inventory_number ON inventory_session (shop_id, number);

CREATE TABLE inventory_line (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES inventory_session (id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES product (id),
  unit_id           TEXT REFERENCES product_unit (id),
  expected_quantity INTEGER NOT NULL DEFAULT 0,
  counted_quantity  INTEGER,
  note              TEXT
);

CREATE INDEX ix_inventory_line_session ON inventory_line (session_id);

-- ─── Journal d'audit ────────────────────────────────────────────────────────
-- `user_label` recopie le nom de l'utilisateur : un compte archivé ne doit pas
-- rendre illisible un journal qu'on consulte des mois plus tard.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  user_id    TEXT,
  user_label TEXT,
  shop_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  before     TEXT,
  after      TEXT
);

CREATE INDEX ix_audit_date ON audit_log (at DESC);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_user ON audit_log (user_id, at DESC);

-- ─── Synchronisation ────────────────────────────────────────────────────────
-- File SORTANTE : un événement par opération synchronisable. `id` est l'unique
-- clé d'idempotence acceptée par le serveur ; un rejeu après coupure ne peut
-- donc pas doubler une vente.
CREATE TABLE sync_outbox (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  shop_id         TEXT NOT NULL,
  user_id         TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CONFLICT')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  -- Porte le recul exponentiel : une boutique déconnectée ne martèle pas.
  next_attempt_at TEXT,
  sent_at         TEXT
);

CREATE INDEX ix_outbox_pending ON sync_outbox (status, next_attempt_at, created_at);

-- File ENTRANTE : mémorise ce qui a déjà été appliqué. C'est cette table, et
-- non une comparaison de contenu, qui garantit qu'un événement reçu deux fois
-- n'est appliqué qu'une seule.
CREATE TABLE sync_inbox (
  event_id   TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  shop_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  status     TEXT NOT NULL DEFAULT 'PENDING'
             CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CONFLICT')),
  error      TEXT
);

CREATE INDEX ix_inbox_seq ON sync_inbox (seq);
CREATE INDEX ix_inbox_status ON sync_inbox (status, seq);

-- Clé/valeur d'exploitation : curseur de synchronisation, identifiant du poste,
-- horodatage de la dernière sauvegarde, drapeaux de démarrage.
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ─── Paramètres et compteurs ────────────────────────────────────────────────
-- Un paramètre non rattaché à une boutique (`shop_id` NULL) vaut pour le poste.
CREATE TABLE setting (
  key        TEXT NOT NULL,
  shop_id    TEXT,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, shop_id)
);

-- Compteurs de numérotation. La clé primaire porte la période, ce qui suffit à
-- remettre la série à zéro chaque année sans effacer quoi que ce soit.
CREATE TABLE document_counter (
  scope      TEXT NOT NULL,
  shop_id    TEXT NOT NULL,
  period     TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, shop_id, period)
);

-- ─── Journal des imports ────────────────────────────────────────────────────
CREATE TABLE import_batch (
  id           TEXT PRIMARY KEY,
  shop_id      TEXT NOT NULL REFERENCES shop (id),
  file_name    TEXT NOT NULL,
  sheet_name   TEXT,
  mode         TEXT NOT NULL DEFAULT 'CREATE_ONLY'
               CHECK (mode IN ('CREATE_ONLY', 'CREATE_AND_UPDATE', 'UPDATE_ONLY')),
  status       TEXT NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT', 'APPLIED', 'ROLLED_BACK', 'FAILED')),
  mapping      TEXT NOT NULL DEFAULT '{}',
  total_rows   INTEGER NOT NULL DEFAULT 0,
  created_rows INTEGER NOT NULL DEFAULT 0,
  updated_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  error_rows   INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  user_id      TEXT NOT NULL REFERENCES app_user (id),
  note         TEXT
);

CREATE INDEX ix_import_shop ON import_batch (shop_id, started_at DESC);

-- Trace ligne à ligne, pour le rapport final ET pour l'annulation d'un import :
-- on sait exactement quelles entités ce lot a créées.
CREATE TABLE import_row (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('CREATED', 'UPDATED', 'SKIPPED', 'ERROR')),
  entity     TEXT,
  entity_id  TEXT,
  message    TEXT,
  raw        TEXT
);

CREATE INDEX ix_import_row_batch ON import_row (batch_id, row_number);
