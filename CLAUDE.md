@~/.claude/facon-de-travailler.md

# Kanade

Logiciel Windows pour gérer ses fichiers musique (MP3, FLAC, MP4/M4A, OGG…) : bibliothèques, morceaux, albums, artistes.

## Ce projet

- **Tickets** : tableau Todoom « Kanade », cartes KAN-1, KAN-2…
- **Dépôt** : https://github.com/mehdiAberkane/kanade (GitHub, public), branche principale `main`.
- **PR/MR** : `gh pr create` vers `main`, en fusion automatique quand la CI est verte.
  Checks obligatoires sur `main` : `interface` (typage, lint, tests et couverture, audit
  npm, sur Ubuntu), `rust` (build, format, Clippy, tests et couverture, cargo-deny, sur
  Windows), `workflows` (zizmor) et `dependency-review`. Renommer un de ces jobs oblige à
  mettre à jour la protection de `main`, sinon plus aucune PR ne fusionne. CodeQL
  (`codeql.yml`) est informatif : ses alertes vont dans l'onglet Security.
- **Techno** : Tauri 2 (Rust, édition 2024) + React 19 + TypeScript 6 (Vite 8) ; Node 22 en CI.

## Commandes

- Installer : `npm install`
- Tests : `npm test`, puis `cargo test --locked` dans `src-tauri`
- Couverture, comme la CI : `npm run test:coverage` (seuils dans `vitest.config.ts`),
  puis dans `src-tauri` : `cargo llvm-cov --locked --fail-under-lines 95` (seuil dans
  `ci.yml`). Les seuils sont posés juste sous le niveau atteint : monte-les quand des
  tests s'ajoutent, ne les baisse jamais. Installer l'outil :
  `rustup component add llvm-tools-preview` puis
  `cargo install cargo-llvm-cov --locked --version 0.9.2`.
- Typage : `npm run typecheck`
- Lint / format : `npm run lint` et `npm run format` (Prettier ; la CI lance
  `npm run format:check`), puis dans `src-tauri` : `cargo fmt` et
  `cargo clippy --locked --all-targets -- -D warnings`.
  - ESLint lit les types (`strictTypeChecked`) et vérifie l'accessibilité
    (`eslint-plugin-jsx-a11y-x`, le fork : l'original ne supporte pas encore ESLint 10 ;
    son minimatch est forcé en version corrigée par `overrides` dans `package.json`).
    Pas de `eslint-disable` sans un commentaire qui dit pourquoi.
  - Clippy ajoute quelques règles `pedantic` choisies, dans `[lints.clippy]` de
    `src-tauri/Cargo.toml` (conversions de nombres, copies inutiles, lisibilité).
- Crates Rust (failles, licences, sources, doublons) : `cargo deny --locked check` dans
  `src-tauri`, réglé par `src-tauri/deny.toml`. Une nouvelle crate sous une licence
  absente de la liste fait échouer la CI : demande-moi avant de l'ajouter. Installer
  l'outil : `cargo install cargo-deny --locked --version 0.22.0`, la version de la CI.
- Code et dépendances inutilisés : `npm run knip` (fichiers, exports et paquets npm), puis
  `cargo machete` dans `src-tauri` (crates déclarées mais jamais utilisées ; outil :
  `cargo install cargo-machete --locked --version 0.10.1`). La CI échoue sur chacun :
  supprime ce qui ne sert plus. cargo-machete lit le code comme du texte ; une crate
  utilisée seulement par le code qu'une macro génère (comme `serde_json` pour
  `generate_context!`) se garde avec un commentaire, ou va dans
  `[package.metadata.cargo-machete] ignored` si elle n'apparaît nulle part.
- Lancer en local : `npm run tauri dev`
- Interface seule dans le navigateur intégré de Claude : `preview_start` avec `kanade-web`
  (`npm run dev` sur le port 1430, pour ne pas gêner `tauri dev` sur le 1420). L'entrée est
  dans `.claude/launch.json` du dépôt, et dans celui de `C:\xampp\htdocs` pour les sessions
  ouvertes là. Le faux contrôle des mises à jour se choisit dans l'adresse :
  `?update=available`, `?update=offline` ou `?update=unpublished` (à jour sinon). L'état
  de la base aussi : `?db=restored`, `?db=empty`, `?db=newer` ou `?db=failed` (prête
  sinon), et les bibliothèques : `?libraries=empty` (trois d'exemple sinon, dont une
  hors ligne et une avec des fichiers OneDrive). Ils se combinent
  (`?update=available&db=restored`). Le faux sélecteur de dossier (`src/dev/mockLibraries.ts`)
  donne un dossier par clic, dont certains refusés, et les faux scans jouent leur
  progression en deux secondes. Les bibliothèques d'exemple totalisent 50 000 faux
  morceaux (`src/dev/mockTracks.ts`) ; les tests en prennent une fraction (`trackScale`).
- Mesurer une durée dans le navigateur intégré : quand son panneau est masqué, la page
  tourne en arrière-plan et Chromium n'y réveille les minuteries (et React) qu'une fois
  par seconde. Mesurer du code synchrone (`performance.now()` autour de l'appel, modules
  importés par `await import("/src/…")`), pas un clic jusqu'à l'affichage.
- Installeur de test : après chaque fusion sur `main`, le job `installer` de la CI joint
  au run un MSI et un setup `.exe` non signés (artefact `kanade-windows-<commit>`, 30
  jours) ; la commande pour les télécharger est dans le README. Ce job ne tourne pas sur
  les PR et n'est pas exigé.
- Publier une version : `npm run release` (ou `minor`, `major`, `x.y.z`) depuis `main` à
  jour. Le tag lance `release.yml`, qui vérifie, construit et signe l'installeur MSI,
  puis publie la Release que l'app propose d'installer. Ses notes sont les titres des PR
  fusionnées depuis le tag précédent (l'app les montre avant d'installer) : un titre de PR
  se lit donc aussi comme une ligne de notes de version. La page de la Release ajoute le
  SHA-256 du MSI. Clé de signature : secrets de l'environnement GitHub `release`, jamais
  du dépôt (`docs/cle-de-signature.md`). Avant d'installer, l'app copie la base
  (`backup_before_update`). Quand publier :
  - **Une fois tous les tickets de « À faire » terminés** (colonne vide, tout fusionné et
    en « A verifier »), publie une nouvelle version sans attendre que je la demande :
    `npm run release minor` si la série apporte une fonctionnalité, `npm run release`
    sinon. Attends que la Release soit en ligne, puis dis-moi le numéro et ce qu'elle
    contient.
  - Sinon, seulement quand je le demande.

## Vérifier sans prendre la main sur le PC

- **Demande-moi toujours avant de prendre le contrôle du PC** (captures d'écran, clics,
  outils computer-use), à chaque fois : je peux être en train de travailler sur autre
  chose, et la prise de contrôle me bloque.
- L'interface se vérifie dans le **navigateur intégré** de Claude, comme Todoom :
  `preview_start` avec `kanade-web`, puis `read_page`, clics et captures dans ce navigateur.
  Hors de Tauri, en dev seulement, `src/dev/mockBackend.ts` répond aux commandes Rust
  (`mockIPC`) : **chaque nouvelle commande Rust y ajoute sa réponse simulée**, avec des
  données d'exemple réalistes.
- Chaque écran a aussi ses **tests de composants** (Testing Library dans jsdom, voir
  `src/App.test.tsx`) : ils rendent l'interface, cliquent comme un utilisateur et
  répondent aux commandes Rust avec ce même faux backend. Un fichier de test de
  composant commence par `// @vitest-environment jsdom` ; il importe l'app après
  `vi.resetModules()` pour repartir d'un état neuf à chaque test.
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
- La partie Rust de la CI tourne sur Windows (job `rust`), comme l'app : pas de paquets
  système à installer pour Tauri. L'interface tourne sur Ubuntu (job `interface`), en
  parallèle.
- Cache Rust de la CI (rust-cache) : il n'enregistre rien quand sa clé existe déjà, et la
  clé ne suit que `Cargo.toml`, `Cargo.lock` et la version de Rust. Après l'ajout d'un
  outil installé par `cargo install` ou d'un nouveau build, monte `key` dans `ci.yml`
  (`v1` → `v2`), sinon il est refait à chaque run.
- `tauri build` demande la clé de signature, car il écrit les fichiers de mise à jour.
  Pour un installeur local sans clé :
  `npm run tauri build -- --config src-tauri/tauri.unsigned.conf.json`.
- Interface en français, code et commits en anglais.
- Index des morceaux (`src-tauri/src/library`) : chaque morceau a un identifiant
  (`TrackId`) qui ne change pas quand son fichier est renommé ou déplacé, et qui n'est
  jamais redonné. Les commandes Rust et l'interface désignent un morceau par cet
  identifiant, jamais par son chemin. Un fichier manquant ou illisible reste dans l'index,
  marqué, pendant 30 jours (`KEEP_GONE_MS`) avant d'en sortir.
- Bibliothèques (`library/libraries.rs`) : un morceau appartient à la bibliothèque dont la
  racine contient son chemin ; deux racines ne se chevauchent jamais (même dossier, l'un
  dans l'autre), et le disque système ou le profil entier sont refusés.
  - **L'interface ne donne jamais de chemin** : un dossier vient du sélecteur ouvert côté
    Rust (`rfd`, dans `commands.rs`) ou d'un glisser-déposer, que Windows remet au Rust.
    Les commandes prennent l'identifiant de la bibliothèque.
  - Les scans tournent sur un fil à part (`library/scanner.rs`), un à la fois, avec
    progression (événements Tauri) et annulation. Retirer ou déplacer une bibliothèque
    passe par `Scanner::without_scan_of`, pour qu'aucun scan ne réécrive ses morceaux.
  - Les commandes se testent par l'IPC de Tauri (runtime de test, `tauri` avec `test` en
    dev-dependency) ; les dialogues passent par le trait `Dialogs`, simulé dans les tests.
    `build.rs` met le manifeste Windows (`windows-app-manifest.xml`) dans tous les
    binaires, ceux des tests compris : sans lui, le binaire de test ne démarre pas
    (`STATUS_ENTRYPOINT_NOT_FOUND`).
- Liste des morceaux (`library/listing.rs`, `src/lib/tracks.ts`) : Rust envoie tous les
  morceaux d'un coup, un tableau compact par morceau (`tracks_list`) ; l'interface trie,
  filtre et sélectionne en mémoire, et ne dessine que les lignes à l'écran. Mesuré sur
  50 000 morceaux : 130 ms et 10,7 Mo côté Rust, tri en 35 à 60 ms (230 ms par chemin).
  Le tri passe par `Intl.Collator` (accents, casse, nombres) sur des rangs calculés une
  fois par valeur distincte ; ajouter un champ = l'ajouter à `TrackRow` des deux côtés,
  dans le même ordre.
- Albums (`src/lib/albums.ts`, onglet « Albums » de la page Musique) : regroupés dans
  l'interface, à partir des mêmes lignes que la liste. Règles :
  - un album = titre + artiste de l'album, sans casse ni accents ;
  - une année différente donne un autre album ;
  - des dossiers fusionnent si leurs numéros disque/piste ne se recouvrent pas (CD1/CD2),
    sinon deux albums nommés par leur dossier ;
  - un dossier « CD2 » donne le disque quand le tag manque ;
  - sans tag d'album : un « Sans album » par artiste.
- Pochettes (`library/covers.rs`, `src/lib/covers.ts`) :
  - `track_cover` reçoit un identifiant de morceau et renvoie un JPEG de 400 ou 900 px,
    jamais l'image d'origine ni un chemin ;
  - l'image vient des tags (couverture avant d'abord), sinon de
    `cover/folder/front/albumart` du dossier ;
  - elle est gardée dans `cache\covers` (pas dans `kanade.db`), avec les morceaux
    disparus ou modifiés purgés au lancement ;
  - une image est bornée avant décodage (32 Mo, 8 000 px) et une panique est rattrapée ;
  - l'interface demande 6 pochettes à la fois et en garde 400 ;
  - le faux backend les dessine en SVG.
- Base de données (`src-tauri/src/store`) : un seul fichier, `kanade.db`, dans
  `%LOCALAPPDATA%\fr.devsecopsforce.kanade` (jamais un dossier synchronisé), ouvert au
  lancement. Tout y est précieux (morceaux et leurs identifiants, puis données de
  l'utilisateur), donc tout est sauvegardé : une copie par jour dans `backups\`, les 30
  dernières gardées, plus une copie avant chaque changement de schéma.
  - **Changer le schéma = ajouter une étape** à `store/migrations.rs` (jamais modifier une
    étape publiée), avec un test qui part d'une base de la version précédente.
  - Base abîmée : mise de côté (`kanade-broken-<date>.db`), dernière sauvegarde lisible
    restaurée, l'interface le dit. Base d'une version plus récente : refusée, intacte.
  - WAL : une lecture (`store::open_reader`) n'attend pas une écriture en cours.
  - Les données lourdes et reconstructibles (vignettes, empreintes) iront dans un cache à
    part, pas dans `kanade.db`.
- Pas de code `unsafe` dans Kanade : `#![forbid(unsafe_code)]` en tête de `lib.rs` et
  `main.rs`. Il ne se contourne pas avec un `allow`.
- Chemins Windows (`library/paths.rs`) : jamais de `Path::starts_with` ni de `==` entre
  chemins.
  - Une racine passe par `normalize_root` : vrai chemin du disque, casse réelle,
    sans `\\?\`.
  - « Ce fichier est-il sous ce dossier » passe par `is_under`, insensible à la casse.
  - Un fichier s'ouvre par `for_io` (forme `\\?\`, qui atteint les chemins longs et les
    noms comme `NUL.mp3`).
  - Les fichiers « en ligne uniquement » (OneDrive…) ne sont pas lus : `is_online_only`.
  - Dans les tests, comparer un chemin à l'index via la forme normalisée : sur GitHub, le
    dossier temporaire a un nom court (`RUNNER~1`).
- Fichiers audio abîmés ou hostiles (`library/track.rs`) : la lecture d'un fichier ne fait
  jamais tomber Kanade. Une panique de lofty est rattrapée : **pas de `panic = "abort"`**
  dans le profil de publication. lofty est limité à 16 Mo par élément de tag (au-delà, les
  pochettes sont sautées), une valeur de tag est coupée à 1 024 caractères, un fichier de
  plus de 4 Go n'est pas lu. Une erreur est classée « access » (fichier verrouillé : relu à
  chaque scan) ou « content »/« panic » (abîmé : indexé illisible, relu seulement quand il
  change). Fuzzing : `KANADE_FUZZ_ITERATIONS=20000 cargo test --release --lib fuzzed`
  dans `src-tauri` ; la CI le lance chaque semaine (`fuzz.yml`). Une panique trouvée se
  signale à lofty, et le fichier en cause devient un test.
- Icône : la source est `app-icon.svg`. Pour la changer, `npm run tauri icon app-icon.svg`,
  puis supprimer `src-tauri/icons/android` et `src-tauri/icons/ios` (app Windows seulement).
  Cargo ne voit pas le changement d'icône : `cargo clean -p kanade` dans `src-tauri` avant
  de relancer, sinon la fenêtre garde l'ancienne.
