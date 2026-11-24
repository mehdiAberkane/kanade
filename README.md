# Kanade

Gestionnaire de bibliothèque musicale pour Windows (Tauri 2 + React) : lister ses
fichiers MP3, FLAC, MP4/M4A, OGG…, parcourir ses bibliothèques, albums et artistes.

## Installer et lancer

Il faut Node 22 et Rust (rustup).

```bash
npm install
npm run tauri dev      # l'app de bureau
```

Un installeur local (.msi / .exe), sans la clé de signature des mises à jour :

```bash
npm run tauri build -- --config src-tauri/tauri.unsigned.conf.json
```

Sans rien compiler : après chaque fusion sur `main`, la CI joint au run un MSI et un
setup `.exe` (artefact `kanade-windows-<commit>`, gardé 30 jours). Pour récupérer ceux du
dernier run de `main` :

```powershell
gh run download (gh run list -R mehdiAberkane/kanade -w CI -b main -e push -s success -L 1 --json databaseId -q '.[0].databaseId') -R mehdiAberkane/kanade -D "$env:TEMP\kanade-ci"
```

## Tester

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
npm run build          # Rust embarque l'interface construite
cd src-tauri && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
cargo deny --locked check   # failles, licences et sources des crates (deny.toml)
cargo machete               # crates déclarées mais inutilisées
cd .. && npm run knip       # code, exports et paquets npm inutilisés
```

La CI mesure aussi la couverture et échoue si elle baisse sous un seuil :

```bash
npm run test:coverage                              # seuils : vitest.config.ts
cd src-tauri && cargo llvm-cov --locked --fail-under-lines 89
```

Outils : `cargo install cargo-deny --locked --version 0.22.0`,
`cargo install cargo-machete --locked --version 0.10.1`,
`rustup component add llvm-tools-preview` et
`cargo install cargo-llvm-cov --locked --version 0.9.2`.

## Mises à jour

Kanade cherche une nouvelle version sur les Releases GitHub du dépôt : au lancement, puis
toutes les 6 heures, ou avec le bouton de Réglages › Mises à jour. Il ne l'installe que
si elle est signée avec la clé de Kanade.

`npm run release` (ou `minor`, `major`, `x.y.z`) monte la version, puis crée et pousse le
tag. GitHub Actions vérifie le code, construit et signe l'installeur MSI, puis publie la
Release que Kanade propose d'installer. La clé de signature, sa sauvegarde et son
remplacement sont décrits dans [`docs/cle-de-signature.md`](docs/cle-de-signature.md).

L'installeur n'a pas de signature de code Windows. SmartScreen affiche donc une alerte
quand on lance pour la première fois l'installeur téléchargé depuis GitHub.
