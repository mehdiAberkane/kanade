@~/.claude/facon-de-travailler.md

# Kanade

Logiciel Windows pour gérer ses fichiers musique (MP3, FLAC, MP4/M4A, OGG…) : bibliothèques, morceaux, albums, artistes.

## Ce projet

- **Tickets** : tableau Todoom « Kanade », cartes KAN-1, KAN-2…
- **Dépôt** : https://github.com/mehdiAberkane/kanade (GitHub, public), branche principale `main`.
- **PR/MR** : `gh pr create` vers `main`, en fusion automatique quand la CI est verte
  (CI obligatoire sur `main`).
- **Techno** : Tauri 2 (Rust, édition 2024) + React 19 + TypeScript 6 (Vite 8) ; Node 22 en CI.

## Commandes

- Installer : `npm install`
- Tests : `npm test`, puis `cargo test` dans `src-tauri`
- Typage : `npm run typecheck`
- Lint / format : `npm run lint`, puis dans `src-tauri` : `cargo fmt` et
  `cargo clippy --all-targets -- -D warnings`
- Lancer en local : `npm run tauri dev`
- Interface seule dans le navigateur intégré de Claude : `preview_start` avec `kanade-web`
  (`npm run dev` sur le port 1430, pour ne pas gêner `tauri dev` sur le 1420). L'entrée est
  dans `.claude/launch.json` du dépôt, et dans celui de `C:\xampp\htdocs` pour les sessions
  ouvertes là.

## Vérifier sans prendre la main sur le PC

- **Demande-moi toujours avant de prendre le contrôle du PC** (captures d'écran, clics,
  outils computer-use), à chaque fois : je peux être en train de travailler sur autre
  chose, et la prise de contrôle me bloque.
- L'interface se vérifie dans le **navigateur intégré** de Claude, comme Todoom :
  `preview_start` avec `kanade-web`, puis `read_page`, clics et captures dans ce navigateur.
  Hors de Tauri, en dev seulement, `src/dev/mockBackend.ts` répond aux commandes Rust
  (`mockIPC`) : **chaque nouvelle commande Rust y ajoute sa réponse simulée**, avec des
  données d'exemple réalistes.
- La logique Rust se vérifie par `cargo test`, sur des fichiers d'exemple.
- Seul ce que Windows est le seul à montrer demande une prise de contrôle : fenêtre native,
  barre des tâches, sélecteur de dossier, lecture audio réelle. Demande d'abord ; si je
  refuse ou ne réponds pas, mets-le dans « À vérifier » du compte rendu.

## À savoir

- Rust embarque l'interface construite : sur un clone neuf, lance `npm run build` avant
  `cargo clippy` ou `cargo test` (sinon `../dist` manque).
- Cargo est dans `%USERPROFILE%\.cargo\bin` : l'ajouter au PATH du shell s'il n'y est pas.
- La CI tourne sur Windows (job `checks`), comme l'app : pas de paquets système à installer pour Tauri.
- Interface en français, code et commits en anglais.
- Icône : la source est `app-icon.svg`. Pour la changer, `npm run tauri icon app-icon.svg`,
  puis supprimer `src-tauri/icons/android` et `src-tauri/icons/ios` (app Windows seulement).
  Cargo ne voit pas le changement d'icône : `cargo clean -p kanade` dans `src-tauri` avant
  de relancer, sinon la fenêtre garde l'ancienne.
