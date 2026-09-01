-- ============================================================================
-- Charges d'exploitation.
--
-- Le logiciel savait ce que la boutique achète et ce qu'elle vend, donc sa
-- marge sur marchandises. Il ne savait rien de ce qu'elle dépense pour
-- fonctionner — loyer, salaires, JIRAMA, transport, impôts — et sans cela il
-- n'y a pas de bénéfice, seulement une marge.
--
-- CE QUI N'ENTRE PAS ICI : les achats de marchandise. Ils passent par les
-- achats, et leur coût rejoint le résultat par le prix de revient des articles
-- vendus. Les saisir aussi comme charges les compterait deux fois, et le
-- résultat serait faux dans le sens le plus trompeur — trop bas les mois où
-- l'on réapprovisionne, trop haut les autres.
--
-- La charge porte la boutique : dans un réseau, un loyer d'Antananarivo n'a
-- rien à faire dans le résultat de Toamasina.
-- ============================================================================

CREATE TABLE charge (
  id          TEXT NOT NULL PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shop (id),
  category    TEXT NOT NULL
              CHECK (category IN ('LOYER', 'SALAIRES', 'ELECTRICITE_EAU', 'TELECOM',
                                  'TRANSPORT', 'FOURNITURES', 'ENTRETIEN', 'SECURITE',
                                  'PUBLICITE', 'BANQUE', 'IMPOTS', 'AUTRE')),
  label       TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  -- Date d'ENGAGEMENT, qui décide de la période du résultat — et non la date
  -- de saisie, qui peut venir des semaines plus tard.
  occurred_at TEXT NOT NULL,
  supplier_id TEXT REFERENCES supplier (id),
  -- Numéro de la pièce justificative : facture, quittance, reçu.
  reference   TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- Le compte de résultat interroge toujours une boutique sur un intervalle.
CREATE INDEX ix_charge_periode ON charge (shop_id, occurred_at);

-- @sqlite-uniquement — reprise de données : une base en ligne neuve n'a aucun
-- rôle à mettre à jour, et `json_insert` est propre à SQLite.
--
-- Les rôles sont enregistrés avec la liste de leurs permissions au moment où
-- ils ont été créés. Sans cette reprise, un administrateur d'une base déjà en
-- service n'aurait accès ni aux charges ni au compte de résultat, et rien ne
-- le lui dirait : les écrans seraient simplement absents de son menu.
UPDATE role
   SET permissions = json_insert(
         json_insert(json_insert(permissions, '$[#]', 'charge.manage'), '$[#]', 'page.charges'),
         '$[#]', 'page.resultat'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE code IN ('ADMIN', 'MANAGER')
   AND json_valid(permissions)
   AND permissions NOT LIKE '%charge.manage%';
