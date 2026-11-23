@~/.claude/facon-de-travailler.md

# Kanade

Logiciel Windows pour gérer ses fichiers musique (MP3, FLAC, MP4/M4A, OGG…) : bibliothèques, morceaux, albums, artistes.

## Ce projet

- **Tickets** : tableau Todoom « Kanade », cartes KAN-1, KAN-2…
- **Dépôt** : https://github.com/mehdiAberkane/kanade (GitHub, public), branche principale `main`.
- **PR/MR** : `gh pr create` vers `main`, en fusion automatique quand la CI est verte.
  Checks obligatoires sur `main` : `checks` (build, tests, lint, audits), `workflows`
  (zizmor) et `dependency-review`. CodeQL (`codeql.yml`) est informatif : ses alertes
  vont dans l'onglet Security.
- **Techno** : Tauri 2 (Rust, édition 2024) + React 19 + TypeScript 6 (Vite 8) ; Node 22 en CI.

## Commandes

- Installer : `npm install`
- Tests : `npm test`, puis `cargo test --locked` dans `src-tauri`
- Typage : `npm run typecheck`
- Lint / format : `npm run lint`, puis dans `src-tauri` : `cargo fmt` et
  `cargo clippy --locked --all-targets -- -D warnings`
- Crates Rust (failles, licences, sources, doublons) : `cargo deny --locked check` dans
  `src-tauri`, réglé par `src-tauri/deny.toml`. Une nouvelle crate sous une licence
  absente de la liste fait échouer la CI : demande-moi avant de l'ajouter. Installer
  l'outil : `cargo install cargo-deny --locked --version 0.22.0`, la version de la CI.
- Lancer en local : `npm run tauri dev`
- Interface seule dans le navigateur intégré de Claude : `preview_start` avec `kanade-web`
  (`npm run dev` sur le port 1430, pour ne pas gêner `tauri dev` sur le 1420). L'entrée est
  dans `.claude/launch.json` du dépôt, et dans celui de `C:\xampp\htdocs` pour les sessions
  ouvertes là. Le faux contrôle des mises à jour se choisit dans l'adresse :
  `?update=available`, `?update=offline` ou `?update=unpublished` (à jour sinon).
- Publier une version : `npm run release` (ou `minor`, `major`, `x.y.z`) depuis `main` à
  jour, **seulement quand je le demande**. Le tag lance `release.yml`, qui vérifie,
  construit et signe l'installeur MSI, puis publie la Release que l'app propose
  d'installer. Clé de signature : `docs/cle-de-signature.md`.

## Vérifier sans prendre la main sur le PC

- **Demande-moi toujours avant de prendre le contrôle du PC** (captures d'écran, clics,
  outils computer-use), à chaque fois : je peux être en train de travailler sur autre
  chose, et la prise de contrôle me bloque.
- L'interface se vérifie dans le **navigateur intégré** de Claude, comme Todoom :
  `preview_start` avec `kanade-web`, puis `read_page`, clics et captures dans ce navigateur.
  Hors de Tauri, en dev seulement, `src/dev/mockBackend.ts` répond aux commandes Rust
  (`mockIPC`) : **chaque nouvelle commande Rust y ajoute sa réponse simulée**, avec des
  données d'exemple réalistes.
- La logique Rust se vérifie par `cargo test`, sur des fichiers d'exemple :
  `src-tauri/tests/fixtures` (un son d'une seconde par format, sans tags ; les tests y
  écrivent les tags avec lofty). Son README dit comment les régénérer avec VLC.
- Seul ce que Windows est le seul à montrer demande une prise de contrôle : fenêtre native,
  barre des tâches, sélecteur de dossier, lecture audio réelle. Demande d'abord ; si je
  refuse ou ne réponds pas, mets-le dans « À vérifier » du compte rendu.

## À savoir

- Rust embarque l'interface construite : sur un clone neuf, lance `npm run build` avant
  `cargo clippy` ou `cargo test` (sinon `../dist` manque).
- Cargo est dans `%USERPROFILE%\.cargo\bin` : l'ajouter au PATH du shell s'il n'y est pas.
- La CI tourne sur Windows (job `checks`), comme l'app : pas de paquets système à installer pour Tauri.
- `tauri build` demande la clé de signature, car il écrit les fichiers de mise à jour.
  Pour un installeur local sans clé :
  `npm run tauri build -- --config src-tauri/tauri.unsigned.conf.json`.
- Interface en français, code et commits en anglais.
- Pas de code `unsafe` dans Kanade : `#![forbid(unsafe_code)]` en tête de `lib.rs` et
  `main.rs`. Il ne se contourne pas avec un `allow`.
- Icône : la source est `app-icon.svg`. Pour la changer, `npm run tauri icon app-icon.svg`,
  puis supprimer `src-tauri/icons/android` et `src-tauri/icons/ios` (app Windows seulement).
  Cargo ne voit pas le changement d'icône : `cargo clean -p kanade` dans `src-tauri` avant
  de relancer, sinon la fenêtre garde l'ancienne.
