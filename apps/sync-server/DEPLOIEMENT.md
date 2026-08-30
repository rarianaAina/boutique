# Mettre le serveur de synchronisation en ligne

Le serveur ne sert **qu'aux transferts entre boutiques**. Chaque boutique
fonctionne hors connexion : elle ouvre, vend, encaisse et imprime sans lui. Il
n'est appelé que lorsque quelqu'un clique sur _Synchroniser_.

Comptez une demi-heure, une seule fois.

---

## 1. Créer le service

### Chez Render

1. Créez un compte sur [render.com](https://render.com) et reliez votre compte
   GitHub.
2. **New → Blueprint**, choisissez le dépôt `boutique`. Render lit `render.yaml`
   à la racine et propose le service `synchro-boutique`.
3. Il demande les deux valeurs manquantes — laissez-les vides pour l'instant,
   nous y revenons à l'étape 3.
4. **Apply**. Au bout de quelques minutes, il affiche une adresse du type
   `https://synchro-boutique.onrender.com`. **Notez-la.**

### Ou chez Fly.io

Depuis la racine du dépôt :

```bash
fly launch --config apps/sync-server/fly.toml --no-deploy
fly volumes create donnees --size 1
fly deploy
```

L'adresse est affichée à la fin, du type `https://synchro-boutique.fly.dev`.

> **Le disque n'est pas optionnel.** Il porte le journal des événements. Sans
> lui, tout repart de zéro à chaque redémarrage et les postes restent bloqués
> avec un curseur qui pointe dans le vide.

---

## 2. Produire les lignes d'enrôlement

**Dans chaque boutique**, sur le poste où elle est installée :

1. Ouvrez **Synchronisation**.
2. Dans l'encadré « Enrôler cette boutique sur le serveur », cliquez sur
   **Produire le jeton de cette boutique**.
3. Cliquez sur **Copier la ligne**, et collez-la quelque part — un message, un
   bloc-notes.
4. Cliquez sur **Enregistrer**.

Vous obtenez une ligne par boutique, de la forme :

```
3f2b…-a91c:CENT:Boutique Centre:9f3a1c…
```

Ne la retapez jamais à la main : c'est le geste qui casse, et le symptôme —
« jeton invalide » — ne dit pas pourquoi.

---

## 3. Renseigner le serveur

Dans l'interface de l'hébergeur, section _Environment_ (Render) ou via
`fly secrets set` :

| Variable         | Valeur                                                 |
| ---------------- | ------------------------------------------------------ |
| `BOUTIQUES`      | les lignes des boutiques, **séparées par une virgule** |
| `ADMIN_PASSWORD` | un mot de passe long, pour consulter le journal        |

Exemple pour deux boutiques :

```
3f2b…-a91c:CENT:Boutique Centre:9f3a1c…,7d41…-c02e:TMV:Tamatave:be77d2…
```

Le service redémarre seul. Vérifiez dans ses traces qu'il affiche bien vos deux
boutiques ; une ligne mal formée y est signalée nommément.

> `ADMIN_PASSWORD` vide, la page de consultation **n'existe pas**. C'est
> délibéré : le journal porte le nom de vos clients, il ne s'ouvre pas par
> oubli.

---

## 4. Relier les boutiques

**Dans chaque boutique**, écran **Synchronisation** :

- **Adresse du serveur** : l'adresse notée à l'étape 1 ;
- **Jeton de la boutique** : déjà rempli depuis l'étape 2 ;
- **Enregistrer**.

Cliquez sur **Synchroniser maintenant**. La date de dernière synchronisation
doit s'afficher.

---

## 5. Vérifier

Ouvrez `https://votre-adresse/sante` : vous devez lire le nombre d'événements
et le dernier rang.

Ouvrez `https://votre-adresse/admin` : le navigateur demande un mot de passe —
le nom d'utilisateur n'a pas d'importance, seul `ADMIN_PASSWORD` compte. Vous y
voyez les boutiques enrôlées, la position de lecture de chaque poste, et les
derniers événements.

---

## Le jour où un colis n'arrive pas

Ouvrez `/admin` et remontez le journal.

- **L'expédition n'y figure pas** → la boutique expéditrice n'a pas
  synchronisé, ou son envoi a échoué. Regardez sa file dans son écran
  Synchronisation.
- **Elle y figure, mais la destination n'a rien reçu** → le poste destinataire
  n'a pas encore synchronisé. Sa position de lecture est affichée en haut de la
  page : comparez-la au rang de l'expédition.
- **La destination l'a reçue mais rien n'apparaît** → le colis attend d'être
  réceptionné dans son écran Transferts. C'est normal : le stock n'entre que
  lorsque le gérant valide.

---

## Sauvegardes

Le serveur copie son journal toutes les six heures dans `/donnees/sauvegardes`,
et garde les quatorze dernières copies. Réglable par `BACKUP_HOURS` et
`BACKUP_KEEP`.

Ces copies vivent sur le même disque que le journal : elles protègent d'une
corruption, **pas d'une perte du disque**. Si le réseau grandit, téléchargez-en
une de temps en temps, ou faites-les écrire ailleurs.

Perdre le journal n'efface aucune donnée de boutique — chacune garde les
siennes en entier — mais bloque les transferts en cours et oblige à remettre
les curseurs à zéro.

---

## Ce que le serveur ne fait pas

- Il ne détient pas l'état des boutiques : il conserve, ordonne et arbitre.
- Il n'envoie à une boutique que ce qui la concerne : le catalogue, et les
  colis dont elle est expéditrice ou destinataire. Le stock, les ventes et les
  appareils des autres ne quittent jamais leur boutique.
- Il n'est jamais appelé pendant une vente. S'il est injoignable, la boutique
  travaille normalement et le colis partira à la prochaine tentative.
