# Kanade

Gestionnaire de bibliothèque musicale pour Windows (Tauri 2 + React) : lister ses
fichiers MP3, FLAC, MP4/M4A, OGG…, parcourir ses bibliothèques, albums et artistes.

## Installer et lancer

Il faut Node 22 et Rust (rustup).

```bash
npm install
npm run tauri dev      # l'app de bureau
npm run tauri build    # installeur (.msi / .exe)
```

## Tester

```bash
npm run typecheck && npm run lint && npm test
npm run build          # Rust embarque l'interface construite
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```
