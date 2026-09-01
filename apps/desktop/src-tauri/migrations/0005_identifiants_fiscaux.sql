-- ============================================================================
-- Identifiants fiscaux sur la facture.
--
-- Une facture sans NIF ni STAT n'a aucune valeur pour la comptabilité d'une
-- entreprise cliente : elle ne peut ni la déduire, ni la produire en cas de
-- contrôle. Le logiciel émettait jusqu'ici un document commercial, pas une
-- facture.
--
-- DES DEUX CÔTÉS. L'émetteur les porte parce que la loi l'exige ; le
-- destinataire les porte parce que sans eux, sa comptabilité refusera la
-- pièce. Un particulier n'en a pas : les colonnes restent facultatives.
--
-- Ce que la société veut ajouter en plus — registre du commerce, capital,
-- coordonnées bancaires, numéro Mvola — ne se met pas en colonnes : cela
-- change d'une société à l'autre, et une colonne par mention obligerait à une
-- migration à chaque nouveau besoin. Ces mentions sont un réglage de boutique
-- (`facture.mentions`), une liste de libellés et de valeurs.
-- ============================================================================

ALTER TABLE shop ADD COLUMN nif TEXT;
ALTER TABLE shop ADD COLUMN stat TEXT;

ALTER TABLE customer ADD COLUMN nif TEXT;
ALTER TABLE customer ADD COLUMN stat TEXT;
