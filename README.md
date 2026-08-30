# Boutique — gestion hors ligne de boutiques de téléphonie et d'informatique

Logiciel de gestion pour des boutiques vendant smartphones, accessoires
électroniques et matériel informatique. Il fonctionne **entièrement hors
ligne** : chaque boutique tient sa propre base locale et continue de vendre,
recevoir et inventorier sans aucune connexion. Internet ne sert qu'aux échanges
entre boutiques, et uniquement quand on le demande.

---

## Sommaire

- [Ce que fait le logiciel](#ce-que-fait-le-logiciel)
- [Architecture](#architecture)
- [Démarrage rapide](#démarrage-rapide)
- [Le modèle de données](#le-modèle-de-données)
- [Les décisions qui structurent tout](#les-décisions-qui-structurent-tout)
- [Synchronisation entre boutiques](#synchronisation-entre-boutiques)
- [Import Excel](#import-excel)
- [Sauvegardes](#sauvegardes)
- [Tests](#tests)
- [Compilation et distribution](#compilation-et-distribution)

---

## Ce que fait le logiciel

| Domaine             | Contenu                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Catalogue**       | Produits suivis par IMEI, par numéro de série ou par quantité ; catégories, fournisseurs, attributs libres    |
| **Stock**           | Unités physiques avec historique individuel, mouvements tracés, inventaire, alertes de seuil                  |
| **IMEI**            | Validation par clé de Luhn, unicité garantie sur tout le réseau, fiche complète par appareil                  |
| **Caisse**          | Recherche et scan, panier, remises soumises à permission, paiements mixtes, ticket imprimable                 |
| **Documents**       | Tickets, factures, remboursements, échanges — numérotés, jamais supprimés                                     |
| **Achats**          | Cycle brouillon → commandé → réception partielle → complète → clôturé, avec ventilation des frais logistiques |
| **Transferts**      | Cycle complet entre boutiques, réservation à la demande, arbitrage des IMEI                                   |
| **Synchronisation** | Événements idempotents, ordre serveur, conflits visibles et arbitrables                                       |
| **Import**          | Excel, avec détection des colonnes, prévisualisation, journal et annulation                                   |
| **Rapports**        | Ventes, marges, stock, mouvements, achats, remboursements, échanges, transferts                               |
| **Administration**  | Utilisateurs, rôles et permissions, paramètres, journal d'audit, sauvegardes                                  |

---

## Architecture

```
boutique/
├── packages/shared/        @boutique/shared      — vocabulaire du domaine, sans dépendance
│   ├── enums.ts            statuts, types de mouvements, énumérations
│   ├── money.ts            entiers, mise en forme, ventilation sans perte
│   ├── permissions.ts      permissions, rôles livrés, garde `requirePermission`
│   ├── validation/imei.ts  clé de Luhn, normalisation, IMEISV
│   └── sync/protocol.ts    enveloppe d'événement, push / pull / claim
│
├── apps/desktop/           @boutique/desktop     — l'application (Tauri + React)
│   ├── src-tauri/          Rust : migrations embarquées, lots transactionnels, sauvegardes
│   ├── src/core/db/        client SQL, dépôts — AUCUN composant React n'écrit de SQL
│   ├── src/core/services/  logique métier : permissions, invariants, audit, événements
│   ├── src/core/sync/      transport, moteur, application des événements reçus
│   ├── src/core/import/    lecture de classeur, mapping, analyse
│   └── src/features/       écrans, un dossier par domaine
│
└── apps/sync-server/       @boutique/sync-server — journal d'événements + arbitrage des IMEI
```

**La règle de dépendance est stricte et à sens unique :**

```
écrans  →  services  →  dépôts  →  client SQL  →  SQLite
```

Un écran n'écrit jamais de SQL ; un dépôt ne vérifie jamais une permission ; un
service ne connaît pas React. C'est ce qui permet de tester toute la logique
métier sur une vraie base SQLite, sans lancer l'application ni compiler Rust.

---

## Démarrage rapide

Prérequis : **Node ≥ 22**, **pnpm ≥ 11**, et — pour l'exécutable de bureau —
**Rust ≥ 1.77** avec les dépendances système de Tauri.

```bash
pnpm install

pnpm --filter @boutique/desktop dev        # front seul, dans le navigateur
pnpm --filter @boutique/desktop tauri:dev  # application de bureau complète
pnpm -r test                               # toute la suite de tests
pnpm -r typecheck                          # TypeScript strict, partout
```

Au premier lancement, l'application propose d'**installer** la boutique : un
code, un nom, un compte administrateur. Le code apparaît ensuite dans tous les
numéros de documents (`T-CENT-2026-00001`), ce qui les rend uniques dans tout le
réseau sans coordination entre boutiques — il ne peut plus être modifié.

Les **Paramètres** proposent un jeu de démonstration : deux boutiques, sept
rôles, un catalogue réaliste, des achats avec frais de douane, des ventes, un
transfert, un remboursement et un échange. Il passe par les mêmes services que
l'utilisation normale — ce ne sont pas des lignes insérées pour faire joli.

---

## Le modèle de données

Trente-six tables, décrites dans
[`0001_init.sql`](apps/desktop/src-tauri/migrations/0001_init.sql). Les cinq
principes qui les gouvernent :

1. **Identifiants texte, jamais auto-incrémentés.** Deux boutiques hors ligne
   doivent pouvoir créer des lignes sans se heurter à la synchronisation.
2. **Argent en entiers**, dans la plus petite unité de la devise. Un flottant ne
   représente pas 0,1 exactement, et l'écart finit par apparaître au bilan.
3. **Dates ISO 8601 UTC en texte** : comparables alphabétiquement, donc
   indexables et filtrables sans fonction.
4. **Suppression logique** partout où la donnée a une valeur comptable. Une
   vente validée et un mouvement de stock ne s'effacent jamais.
5. **Contraintes CHECK** reprenant les énumérations du code : une valeur inconnue
   est refusée à l'écriture, pas découverte à la lecture.

### Produit ≠ unité physique

« iPhone 15 128 Go noir » est un **produit** ; l'appareil dont l'IMEI finit par
47 est une **unité**. Confondre les deux rend impossible de savoir lequel de deux
téléphones identiques est parti chez quel client.

Le champ `tracking` du produit est le discriminant du modèle de stock :

| `tracking` | Stock tenu par                        | Exemple                 |
| ---------- | ------------------------------------- | ----------------------- |
| `IMEI`     | une ligne `product_unit` par appareil | smartphones             |
| `SERIAL`   | idem, avec un numéro de série         | JBL Boombox, DJI Osmo   |
| `QUANTITY` | une ligne `stock_level` par boutique  | câbles, vitres, housses |

Aucun code ne teste la catégorie d'un produit pour décider : c'est ce champ, et
lui seul, qui commande.

---

## Les décisions qui structurent tout

### L'unicité de l'IMEI est portée par la base

Les identifiants vivent dans une table `unit_identifier` avec un index unique
sur `(kind, value)`. Une table séparée plutôt que trois colonnes, parce que
l'unicité doit valoir **entre les emplacements** : avec des colonnes, rien
n'empêcherait l'IMEI 1 d'un appareil d'être l'IMEI 2 d'un autre.

Une vérification en JavaScript avant l'insertion ne suffirait pas : entre le
contrôle et l'écriture, une seconde fenêtre peut insérer.

### Aucune quantité ne bouge sans mouvement

Toute variation de stock écrit une ligne dans `stock_movement`, dans la même
transaction que l'état. C'est ce qui permet de répondre à « d'où vient cet
appareil ? » un an plus tard, et de **recalculer** un stock si un total venait à
diverger — les mouvements font foi, et l'écran des paramètres propose ce
recalcul.

Une correction s'écrit en ajoutant un mouvement inverse, jamais en effaçant
celui qui gêne.

### Une opération = une transaction

État, mouvement, événement de synchronisation et entrée d'audit sont écrits
**ensemble ou pas du tout**. Les séparer laisserait la porte ouverte à un
téléphone marqué vendu sur un ticket qui n'existe pas — ou l'inverse, bien pire.

Techniquement : `tauri-plugin-sql` ouvre la base avec un pool de dix connexions,
si bien qu'un `BEGIN` et un `COMMIT` envoyés séparément peuvent atterrir sur deux
connexions différentes. Les écritures d'un bloc sont donc accumulées côté
TypeScript puis exécutées par la commande Rust `execute_batch`, en une seule
transaction sur une seule connexion.

**Conséquence à connaître :** dans un bloc transactionnel, les lectures sont
immédiates et ne voient pas les écritures en attente. Aucun service ne relit ce
qu'il vient d'écrire ; les invariants qui en dépendraient sont portés par des
contraintes de la base. Le harnais de test reproduit exactement cette
sémantique — un service qui relirait ses propres écritures échoue en test.

### La double vente est impossible

Vendre un appareil met à jour son statut avec un `WHERE status IN ('IN_STOCK',
'RETURNED')`. Deux fenêtres qui encaisseraient le même IMEI au même instant ne
peuvent pas réussir toutes les deux. Le service vérifie **avant** pour donner un
message clair au vendeur ; la base garantit **après**.

### Une variante est un produit, un modèle est un regroupement

« iPhone 17 Pro Max rouge 256 Go » et « iPhone 17 Pro Max noir 128 Go » sont
**deux produits** — deux prix, deux stocks, deux SKU — et **un seul modèle** aux
yeux du vendeur.

La couleur et la capacité sont donc passées d'attributs libres à des **colonnes**
(`product.color`, `product.capacity`) : ce sont les axes sur lesquels on choisit
au comptoir, et l'on ne filtre ni n'indexe efficacement du JSON. Une troisième
colonne, `variant_group`, réunit les déclinaisons d'un même modèle — une clé
explicite plutôt qu'un rapprochement par le nom, les libellés d'un fichier réel
différant d'une casse, d'un accent ou d'une espace finale.

Au comptoir, cliquer sur un modèle ouvre le choix : les capacités puis les
couleurs réellement au catalogue, **y compris celles à zéro** — un vendeur doit
pouvoir répondre « le rouge, je ne l'ai plus » plutôt que de laisser croire
qu'il n'existe pas.

### Scanner n'est jamais obligatoire

Le scan d'un IMEI reste le geste le plus rapide, et il ajoute l'appareil au
panier sans aucun clic. Mais un scanner tombe en panne, un code-barres se
décolle, un téléphone est déjà déballé — et la vente ne doit pas s'arrêter là.

Choisir un produit ouvre donc la **liste des exemplaires disponibles**, avec
leur IMEI, leur état et leur date d'entrée : le vendeur en désigne un à l'œil.
Un bouton « Prendre le plus ancien » couvre le cas courant en un clic.

### Supprimer un produit : effacer ou archiver

La suppression a **deux issues**, et l'écran annonce laquelle s'appliquera
_avant_ d'agir :

- **rien ne le cite** — créé par erreur, jamais reçu ni vendu : il est effacé
  pour de bon. Laisser une fiche fantôme au catalogue serait une pollution que
  personne ne nettoie jamais ;
- **il a une histoire** — une vente, un achat, un mouvement : il est **archivé**.
  Il quitte les listes et le comptoir, mais tous les documents qui le citent
  restent lisibles. C'est la règle du §27, et elle n'est pas négociable :
  effacer un produit vendu rendrait illisible un ticket déjà remis à un client.

La boîte de dialogue énumère ce qui retient la suppression — « 3 lignes de
vente, 12 mouvements de stock » — plutôt que de refuser sans expliquer.

### La référence produit est facultative

Dans un fichier réel de boutique, près d'une ligne sur deux n'a pas de référence
interne : le gérant reconnaît ses articles à leur désignation, leur marque et
leur capacité, pas à un code qu'il n'a jamais eu besoin d'inventer.

La base, elle, a besoin d'une clé unique. Quand la référence manque, elle est
donc **dérivée** du modèle — `AUTO-IPHONE-12-PRO-MAX-512-SILVER` — de façon
**déterministe** : trois lignes décrivant le même téléphone produisent la même
référence, donc un seul produit, et non trois doublons à fusionner à la main.
Deux modèles réellement distincts qui partageraient une désignation sont
suffixés (`-2`, `-3`).

La règle vit dans `@boutique/shared/sku.ts` : elle sert à l'import **comme** au
formulaire de création. Vider le champ sur une fiche existante ne la renomme
jamais — un document déjà émis la cite.

### La clé de contrôle des IMEI est stricte, mais désactivable

La dernière décimale d'un IMEI est une clé de Luhn : elle attrape les chiffres
inversés à la saisie. Elle est **exigée par défaut**, et le message nomme le
chiffre attendu, pour que l'erreur soit corrigeable sans recalcul.

Certains appareils reconditionnés ou de marques secondaires portent pourtant un
IMEI qui ne la respecte pas. Le paramètre « Contrôler la clé des IMEI » permet
alors de l'accepter — le numéro reste consigné comme douteux, et **la longueur
et l'unicité restent vérifiées** : ce sont elles qui protègent l'intégrité, la
clé ne protège que de la faute de frappe.

### Les permissions sont vérifiées deux fois

Une permission masquée à l'écran est un confort ; une permission vérifiée dans
le service est une protection. Les deux existent, et c'est le service qui fait
foi.

### L'échange ne touche jamais la vente d'origine

Un échange produit : la reprise de l'ancien appareil (qui revient en stock avec
son historique complet), et une **nouvelle vente** pour l'appareil remis,
portant une remise égale à la valeur créditée. Sans cette nouvelle vente, le
nouvel appareil n'aurait ni ticket, ni client rattaché, et son IMEI
n'apparaîtrait dans aucun document de sortie.

Quand l'appareil rendu vaut plus que le nouveau, la remise est plafonnée au prix
du nouvel appareil et le solde donne lieu à un remboursement rattaché à la vente
d'origine — le seul document où cet argent a été encaissé.

### Le coût d'acquisition est le coût RÉEL

Les frais logistiques d'un achat (transport, douane, assurance…) sont ventilés
sur les lignes, au prorata de la valeur ou des quantités selon la nature du
frais. C'est le coût ainsi obtenu qui est porté par chaque unité entrée en
stock, puis figé sur la ligne de vente.

La ventilation ne perd **aucune unité monétaire** : la méthode du plus fort
reste attribue les résidus, et la somme des parts égale exactement le total —
un comptable peut la refaire à la main.

La marge est calculée sur ce coût figé, jamais sur le prix d'achat courant : une
marge historique ne doit pas changer quand un fournisseur augmente ses tarifs.

---

## Synchronisation entre boutiques

**On ne synchronise pas des tables, on synchronise des événements.** Envoyer la
base au serveur — ou comparer des lignes champ par champ — obligerait à décider,
pour chaque colonne, qui a raison entre deux boutiques hors ligne. Un événement
décrit une intention datée et signée : « cet IMEI est entré chez moi le 12 à 9 h ».

Trois propriétés portent toute la fiabilité :

| Propriété       | Mécanisme                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idempotence** | chaque événement porte un `id` généré localement ; le serveur refuse d'appliquer deux fois le même. Un `push` rejoué après coupure ne double pas une vente.          |
| **Ordre**       | le serveur attribue un `seq` monotone. Un pair reprend au dernier `seq` appliqué — jamais à une date, les horloges des postes n'étant pas fiables.                   |
| **Détention**   | un IMEI n'a qu'un détenteur. Le serveur arbitre : la seconde boutique à le déclarer voit son événement refusé, et le conflit remonte à l'écran au lieu de se perdre. |

Le déclenchement est **explicite**. Rien ne part tout seul : un envoi
automatique consommerait un forfait mobile sans qu'on le demande, et donnerait
surtout l'illusion d'être à jour alors que la connexion est peut-être morte
depuis trois jours. L'écran de synchronisation montre ce qui attend, ce qui a été
refusé, et quand la dernière synchronisation a eu lieu.

**Un appareil en transit reste rattaché à la boutique expéditrice** jusqu'à la
réception. C'est le seul choix qui ne perd jamais un appareil : s'il changeait de
boutique à l'expédition, un colis égaré disparaîtrait du stock des deux côtés.

### Lancer le serveur

```bash
BOUTIQUES="id-a:CENT:Boutique Centre:jeton-a,id-b:NORD:Boutique Nord:jeton-b" \
SYNC_DB=/var/lib/boutique/sync.db \
PORT=4310 \
pnpm --filter @boutique/sync-server start
```

Trois routes : `POST /sync/push`, `POST /sync/pull`, `POST /sync/claim`,
authentifiées par un jeton de boutique. `GET /sante` pour la surveillance.

---

## Import Excel

Onze étapes, dans l'ordre : fichier → feuille → colonnes détectées → association
→ prévisualisation → erreurs et doublons → correction → import → rapport.

L'importateur est réglé sur les **fichiers réels de la boutique**, rangés dans
[`examples/`](examples/), et une suite de tests les rejoue à chaque exécution
(`import-fichiers-reels.test.ts`). Leurs particularités sont traitées
nommément :

| Particularité du fichier                     | Traitement                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| « Référence interne » vide (46 % des lignes) | une référence `AUTO-…` est dérivée du modèle, marquée comme telle à l'écran                       |
| Colonne « Étiquettes »                       | reconnue comme la **catégorie** ; la catégorie manquante est créée                                |
| Colonne « Fournisseur » / « Fournisseurs »   | le fournisseur manquant est créé à partir de son code                                             |
| Colonne « Emplacement »                      | conservée en caractéristique du produit                                                           |
| « Batterie % », « Garantie », « Cycle »      | conservées en caractéristiques — ce qu'un vendeur consulte avant de céder un téléphone d'occasion |
| Colonne « État » (Neuf, Scellé, Bon état)    | traduite en état d'appareil ; « scellé » vaut neuf                                                |
| Colonne IMEI présente mais **vide**          | le produit est créé en suivi par IMEI, **sans stock** : les numéros seront scannés à la réception |
| Même modèle répété sur plusieurs lignes      | un seul produit, les lignes suivantes ignorées avec un avertissement                              |
| Classeur à plusieurs feuilles                | option « importer les N feuilles », chacune avec sa propre association de colonnes                |
| Ligne sans prix de vente                     | seule cause de rejet, ligne par ligne, motif nommé dans le rapport                                |

- **La détection des colonnes n'est pas écrite pour un fichier précis** : chaque
  champ porte une liste de libellés reconnus, en français et en anglais, avec les
  variantes qu'on trouve réellement (« Prix Achat », « P.A. », « cout »,
  « purchase price »). Les correspondances exactes passent avant les
  approchantes, pour qu'une colonne « Prix » ne rafle pas le champ « prix
  d'achat ».
- **Les IMEI sont lus sur la valeur brute de la cellule**, jamais sur son
  affichage : Excel montre volontiers un nombre de quinze chiffres en notation
  scientifique, et recopier ce qui est à l'écran donnerait un IMEI faux que
  l'appareil porterait toute sa vie.
- **Rien n'est écrasé en silence** : un produit existant n'est modifié que si le
  mode « mise à jour » a été choisi, et l'écran annonce combien de lignes seront
  touchées avant qu'on valide.
- **Tout est tracé** : chaque ligne laisse une entrée dans le journal d'import,
  ce qui rend l'annulation possible. Elle retire les appareils créés qui n'ont
  pas bougé depuis, conserve ceux qui ont été vendus ou transférés, et **dit
  lesquels** — plutôt que de prétendre à un retour en arrière complet.

---

## Sauvegardes

L'application fonctionne hors ligne : les ventes du jour, les IMEI entrés et les
réceptions **n'existent nulle part ailleurs** tant que la synchronisation n'a pas
eu lieu.

La copie utilise `VACUUM INTO`, seule méthode sûre sur une base en cours
d'utilisation : recopier le fichier pendant que le mode WAL est actif produit une
sauvegarde incohérente, donc inutilisable au moment précis où l'on en aurait
besoin. Elle est déclenchée **à la connexion**, une fois par jour — un poste de
boutique s'éteint rarement proprement, et c'est justement le cas à couvrir.

Une vérification d'intégrité (`PRAGMA integrity_check`) est disponible dans les
paramètres. La restauration dépose la copie à côté de la base et opère la
permutation au démarrage suivant : écraser une base ouverte la corromprait.

---

## Tests

```
254 tests · 21 fichiers
```

| Fichier                   | Ce qu'il vérifie                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `stock-imei.test.ts`      | clé de Luhn, IMEISV, unicité inter-emplacements, refus des lots partiels                                 |
| `sale.test.ts`            | double vente, stock insuffisant, remises et plancher, annulation                                         |
| `refund-exchange.test.ts` | plafond de remboursement, double remboursement, échanges dans les deux sens                              |
| `purchase.test.ts`        | réceptions partielles, ventilation des frais au centime, coût réel par appareil                          |
| `transfer.test.ts`        | cycle complet, double réception, refus, réservation                                                      |
| `sync.test.ts`            | **deux boutiques, deux bases, le vrai serveur** : transfert de bout en bout, idempotence, conflit d'IMEI |
| `import.test.ts`          | détection des colonnes, IMEISV en notation scientifique, doublons, annulation                            |
| `schema.test.ts`          | les contraintes existent vraiment dans la base, pas seulement dans le fichier                            |
| `seed.test.ts`            | le jeu de démonstration produit des données recalculables depuis les mouvements                          |

Les tests des dépôts et des services s'exécutent sur une **vraie base SQLite**
(`node:sqlite`), avec le schéma de production : un test qui ne passerait pas par
SQLite ne dirait rien des contraintes d'unicité, qui sont précisément ce qui
protège les IMEI.

Le test de synchronisation branche le **serveur réel** en mémoire, chaque
boutique ayant sa propre base. Ce qui n'a pas été synchronisé n'existe donc
réellement pas chez le voisin.

---

## Compilation et distribution

```bash
pnpm --filter @boutique/desktop tauri:build
```

Produit un installateur NSIS et un MSI sous Windows, un `.deb` et un AppImage
sous Linux. Les migrations sont **embarquées dans le binaire** et appliquées à
l'ouverture de la base, avant que la fenêtre ne soit prête : aucun écran ne peut
tomber sur un schéma incomplet, et il n'y a rien à déployer à côté de
l'exécutable.

La base vit dans le dossier de configuration de l'application
(`%APPDATA%\com.boutique.gestion` sous Windows, `~/.config/com.boutique.gestion`
sous Linux), les sauvegardes dans son sous-dossier `sauvegardes`.

---

## Raccourcis clavier

| Touche        | Action                                                |
| ------------- | ----------------------------------------------------- |
| `Ctrl` + `K`  | recherche globale (IMEI, série, SKU, client, ticket…) |
| `Alt` + `1…5` | tableau de bord, caisse, tickets, produits, appareils |
| `F2`          | revenir au champ de recherche de la caisse            |
| `F4`          | ouvrir l'encaissement                                 |
| `Échap`       | vider le champ de recherche                           |

Un IMEI scanné dans la caisse ajoute directement l'appareil au panier : c'est le
geste le plus fréquent de la journée, il ne doit coûter aucun clic.
