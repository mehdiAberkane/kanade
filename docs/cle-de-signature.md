# Clé de signature des mises à jour

Chaque Kanade installé contient la **clé publique** (`plugins.updater.pubkey` dans
`src-tauri/tauri.conf.json`). Il n'installe une mise à jour que si elle est signée par la
**clé privée** qui va avec. Cette clé est propre à Kanade : ce n'est pas celle de Todoom.

| Élément | Où |
|---|---|
| Clé privée | `~/.tauri/kanade.key` (hors du dépôt) et secret `TAURI_SIGNING_PRIVATE_KEY` de l'environnement GitHub `release` |
| Mot de passe | `~/.tauri/kanade.key.password.txt` et secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` du même environnement |
| Clé publique | `~/.tauri/kanade.key.pub` et `src-tauri/tauri.conf.json` |

Garde une copie de `~/.tauri/` dans un gestionnaire de mots de passe. Sans elle, aucune
mise à jour automatique n'est plus possible.

## Où GitHub garde la clé

Dans les secrets de l'**environnement `release`** (Settings → Environments → release),
jamais dans les secrets du dépôt : ceux-là, tout flux de travail du dépôt peut les lire.
Seul un job qui déclare `environment: release` et tourne sur un tag `v*` (sa règle de
déploiement) reçoit ceux de l'environnement : le job `build` de `release.yml`.

Pour y mettre (ou remplacer) la clé et son mot de passe, depuis PowerShell, sans que
leur contenu s'affiche ni passe par le presse-papiers :

```powershell
cmd /c "gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R mehdiAberkane/kanade < %USERPROFILE%\.tauri\kanade.key"
cmd /c "gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release -R mehdiAberkane/kanade < %USERPROFILE%\.tauri\kanade.key.password.txt"
gh secret list --env release -R mehdiAberkane/kanade
```

`gh secret list -R mehdiAberkane/kanade` (sans `--env`) ne doit montrer aucun des deux.

## Principe du remplacement

Une installation ne connaît que la clé publique avec laquelle elle a été construite.
Pour changer de clé sans réinstaller à la main, on publie une **version de transition**.
Elle contient la nouvelle clé publique, mais elle est encore **signée avec l'ancienne** :
les installations l'acceptent, puis font confiance à la nouvelle clé.

## Remplacement préventif (clé non compromise)

1. Générer la nouvelle paire :
   ```bash
   npx tauri signer generate -w ~/.tauri/kanade-2.key -p "<nouveau mot de passe>" --ci
   ```
2. Mettre le contenu de `~/.tauri/kanade-2.key.pub` dans `plugins.updater.pubkey` de
   `src-tauri/tauri.conf.json`, puis passer par une PR comme d'habitude.
3. Publier la version de transition **sans toucher aux secrets GitHub** :
   `npm run release`. Elle est signée avec l'ancienne clé.
4. Installer cette version sur **chaque** PC (Réglages › Mises à jour), puis vérifier le
   numéro de version affiché dans les Réglages.
5. Remplacer les deux secrets de l'environnement `release` par la nouvelle clé et son
   mot de passe (commandes de « Où GitHub garde la clé », avec `kanade-2.key`).
6. Publier une version de test. L'étape « Check update signing secrets » doit passer,
   et la mise à jour doit s'installer.
7. Remplacer `~/.tauri/kanade.key*` par les nouveaux fichiers et mettre à jour la copie
   de sauvegarde. Effacer ensuite l'ancienne clé.

## Clé ou mot de passe exposés

Avec la clé, quelqu'un peut signer une mise à jour que tes installations acceptent. Il
lui faut encore la publier là où Kanade la cherche, dans les Releases du dépôt GitHub.
Une fuite va donc souvent avec un accès au compte GitHub. Dans l'ordre :

1. **Sécuriser GitHub** :
   - changer le mot de passe ;
   - révoquer les jetons et les sessions inconnus ;
   - vérifier les collaborateurs, les clés SSH et les secrets du dépôt.
2. **Supprimer toute Release que tu n'as pas publiée toi-même**, et le tag associé.
3. Suivre **tout de suite** le remplacement préventif ci-dessus (étapes 1 à 7). La
   version de transition est une course contre une version piégée.
4. Un poste dont la version installée ne correspond à aucune Release que tu as publiée
   est à considérer comme compromis. Désinstaller Kanade, puis le réinstaller depuis un
   installeur construit toi-même (voir le README).

## Clé perdue

Sans l'ancienne clé, aucune version de transition n'est possible. Générer une nouvelle
paire (étapes 1, 2 et 5), publier, puis **réinstaller à la main** la nouvelle version
sur chaque poste. Les mises à jour automatiques reprennent ensuite.

## Protections GitHub en place

- **Environnement `release`** : la clé et son mot de passe sont ses secrets, que seul
  un job lancé sur un tag `v*` peut lire.
- **Règles d'étiquettes** (Settings → Rules → Rulesets, « Release tags ») sur
  `refs/tags/v*` : seul l'administrateur du dépôt peut créer, déplacer ou supprimer un
  tag de version.
- **Protection de `main`** : la CI est obligatoire, et l'historique ne peut être ni
  supprimé ni réécrit (`force push`).
- **Actions épinglées** : celles du flux de publication sont épinglées par empreinte de
  commit, et Dependabot propose les mises à jour (`.github/dependabot.yml`). Lire ce qui
  change dans une action avant d'accepter sa mise à jour.
