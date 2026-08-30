-- ============================================================================
-- Variantes de produit : couleur et capacité.
--
-- POURQUOI CES COLONNES PLUTÔT QUE LES ATTRIBUTS LIBRES.
--
-- La couleur et la capacité étaient jusqu'ici rangées dans `attributes`, un
-- JSON prévu pour ce qui varie d'une famille de produits à l'autre. Elles
-- changent de nature : ce sont désormais les AXES sur lesquels un vendeur
-- choisit — « iPhone 17 Pro Max, rouge, 256 Go ». Or on ne filtre pas, on
-- n'indexe pas et on ne groupe pas efficacement sur du JSON.
--
-- `variant_group` réunit les déclinaisons d'un même modèle. Une clé explicite
-- plutôt qu'un rapprochement par le nom : les libellés d'un fichier réel
-- diffèrent d'une casse, d'un accent ou d'une espace finale, et regrouper
-- « Iphone 12 Pro Max » avec « iPhone 12 Pro Max  » relèverait de la devinette.
--
-- Chaque variante reste UN PRODUIT à part entière, avec son SKU, son prix et
-- son stock. C'est ce qui permet de vendre le rouge 256 Go à un prix différent
-- du noir 128 Go, et de savoir lequel des deux manque.
-- ============================================================================

ALTER TABLE product ADD COLUMN color TEXT;
ALTER TABLE product ADD COLUMN capacity TEXT;
ALTER TABLE product ADD COLUMN variant_group TEXT;

-- Reprise des valeurs déjà saisies en attributs libres.
UPDATE product
SET color = json_extract(attributes, '$.couleur')
WHERE color IS NULL AND json_valid(attributes) AND json_extract(attributes, '$.couleur') IS NOT NULL;

UPDATE product
SET capacity = json_extract(attributes, '$.capacite')
WHERE capacity IS NULL AND json_valid(attributes) AND json_extract(attributes, '$.capacite') IS NOT NULL;

-- `variant_group` est laissé vide : il est calculé par l'application, avec la
-- MÊME normalisation que les clés de recherche (accents, ponctuation). Le
-- reproduire en SQL donnerait deux règles qui finiraient par diverger.
-- L'entretien au démarrage le renseigne pour les lignes existantes.

CREATE INDEX ix_product_variant ON product (variant_group, color, capacity);
CREATE INDEX ix_product_color ON product (color) WHERE color IS NOT NULL;
