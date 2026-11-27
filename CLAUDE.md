@~/.claude/facon-de-travailler.md

# Kanade

Logiciel Windows pour gérer ses fichiers musique (MP3, FLAC, MP4/M4A, OGG…) : bibliothèques, morceaux, albums, artistes.

## Ce projet

- **Tickets** : tableau Todoom « Kanade », cartes KAN-1, KAN-2…
- **Dépôt** : https://github.com/mehdiAberkane/kanade (GitHub, public), branche principale `main`.
- **PR/MR** : `gh pr create` vers `main`, en fusion automatique quand la CI est verte.
  Checks obligatoires sur `main` : `interface` (typage, lint, tests et couverture, audit
  npm, sur Ubuntu), `rust` (build, format, Clippy, tests et couverture, cargo-deny, sur
  Windows), `e2e` (la vraie app par tauri-driver, sur Windows), `workflows` (zizmor) et
  `dependency-review`. Renommer un de ces jobs oblige à
  mettre à jour la protection de `main`, sinon plus aucune PR ne fusionne. CodeQL
  (`codeql.yml`) est informatif : ses alertes vont dans l'onglet Security.
- **Techno** : Tauri 2 (Rust, édition 2024) + React 19 + TypeScript 6 (Vite 8) ; Node 22 en CI.

## Commandes

- Installer : `npm install`
- Tests : `npm test`, puis `cargo test --locked` dans `src-tauri`
- Tests de bout en bout : `npm run test:e2e` (build avec l'option `e2e`, puis `e2e/` par
  tauri-driver). Il ouvre une vraie fenêtre Kanade sur le PC quelques secondes :
  demande-moi avant de le lancer. Outil : `cargo install tauri-driver --locked --version
  2.1.0` (version aussi dans `e2e/setup.mjs` et `ci.yml`) ; le pilote d'Edge qui
  correspond à WebView2 se télécharge seul depuis Microsoft, signature vérifiée.
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
  hors ligne et une avec des fichiers OneDrive), et l'image de fond :
  `?background=light` (une image claire, pour vérifier le texte dessus), et la
  surveillance des dossiers : `?watch=live` (12 fichiers arrivent dans « Musique » toutes
  les 8 s). Ils se combinent
  (`?update=available&db=restored`). Le zoom de la fenêtre y est imité par le zoom CSS de
  la page. Le faux sélecteur de dossier (`src/dev/mockLibraries.ts`)
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
- La vraie app se vérifie par les tests de bout en bout (`e2e/`, job `e2e` de la CI) : le
  build `e2e` (`src-tauri/src/e2e.rs`, jamais publié) prend sa base dans
  `KANADE_E2E_DATA`, répond au sélecteur de dossier par `KANADE_E2E_LIBRARY`, n'a pas de
  mises à jour et a son propre identifiant (`tauri.e2e.conf.json`). Il passe lui-même à
  WebView2 les options du pilote Edge (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`), que
  WebView2 ignore sur les runners GitHub ; ce code ne compile qu'avec l'option `e2e`, ses
  tests (`cargo test --features e2e --lib e2e`) tournent dans le job `e2e`. Le test s'arrête
  avant tout clic si la base n'apparaît pas dans son dossier (un autre build ouvrirait
  la vraie). Un parcours que seule la vraie app montre (Rust et interface ensemble, base
  gardée après une relance) y ajoute un scénario ; les écrans eux-mêmes restent aux
  tests de composants.
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
  - Exclusions (KAN-43, `library/exclusions.rs`, `src/lib/exclusions.ts`) : par
    bibliothèque, des sous-dossiers (gardés relatifs à la racine) et des extensions,
    dans la colonne `exclusions` de `libraries`. Le scan ne les parcourt pas, la
    surveillance les ignore. Leurs morceaux sont cachés tout de suite (`excluded_ms`),
    gardés `KEEP_GONE_MS`, puis sortent de l'index. Une exclusion retirée les remet,
    même identifiant, favoris et notes. Pour retirer un dossier, l'interface renvoie le
    nom que Rust a listé, jamais un nouveau chemin. La liste des extensions existe des
    deux côtés : un test Rust vérifie qu'elles restent pareilles.
  - Les scans tournent sur un fil à part (`library/scanner.rs`), un à la fois, avec
    progression (événements Tauri) et annulation. Retirer ou déplacer une bibliothèque
    passe par `Scanner::without_scan_of`, pour qu'aucun scan ne réécrive ses morceaux.
  - Surveillance des dossiers (KAN-27, `library/watcher.rs`) : chaque bibliothèque est
    surveillée pendant que Kanade est ouvert (réglage `watch`, activé par défaut). Les
    changements sont regroupés (2 s de calme, 30 s au plus pendant une longue copie), puis
    leurs dossiers relus sur le fil des scans par une mise à jour discrète
    (`ScanQueue::enqueue_folders`) : pas de progression, le résumé du dernier scan
    intact, l'événement `library-updated` seulement si quelque chose a changé. Une
    bibliothèque non surveillée, ou que Windows ne sait pas surveiller, est scannée toutes
    les 30 min. `notify` reste en 8.x : la 9 entraîne une crate sous licence Boost
    (BSL-1.0), absente de `deny.toml`.
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
- Artistes (`src/lib/artists.ts`, onglet « Artistes ») : tirés des albums.
  - La liste montre les artistes d'album ; une case ajoute ceux des seuls morceaux
    (invités, compilations).
  - « A feat. B » est rangé sous A, B en invité (réglage `groupFeaturing`, activé par
    défaut). La coupe suit la règle d'Ongaku (ONG-21, `src/lib/featuring.ts`) : seulement
    « feat », « ft », « featuring », jamais « & » ni une virgule. Garder les deux apps
    pareilles.
  - « Various Artists », « VA », « Compilation »… : une seule entrée « Artistes divers »,
    en fin de liste, après « Artiste inconnu ».
  - Le dernier départage d'un tri compare les clés code par code (`byCode`) : le
    collator prend « Strauß » et « Strauss » pour égaux.
- Recherche et filtres (`src/lib/search.ts`, barre au-dessus des trois onglets) : en
  mémoire, comme le tri.
  - Chaque morceau a un texte normalisé (`searchText`), fait une fois et préparé en
    arrière-plan à l'arrivée de la liste (`warmSearch`).
  - Mesuré sur 50 000 morceaux : préparation d'environ 450 ms en étapes de 9 ms ;
    recherche en 10 à 15 ms ; nombres du panneau en 20 à 40 ms.
  - Pas de SQL, donc rien de tapé n'atteint une requête.
  - Un panneau ou un menu qui se ferme sur Échap écoute en capture et marque la touche
    traitée, pour que la page dessous (un artiste, un album) ne recule pas aussi.
- Santé de la bibliothèque (KAN-28, page « Santé », `src/lib/health.ts`) : chaque contrôle
  est une fonction pure sur les mêmes lignes que la liste, calculée dans l'interface (pas
  de cache). Seule la présence d'une image de pochette dans un dossier est demandée au
  Rust (`tracks_without_folder_cover`, par identifiant). Les règles sont dans
  `docs/sante.md`, à garder pareilles qu'Ongaku (ONG-59). Les signalements ignorés vont
  dans `settings` (`health_ignored`). Mesuré sur 50 000 morceaux : albums en 95 ms, puis
  contrôles en 100 ms, lancés juste après l'affichage de la page.
- Lire avec un lecteur installé (KAN-45, `src-tauri/src/player/`, `src/lib/player.ts`) :
  - les lecteurs sont lus dans le registre (`player/registry.rs`, crate
    `windows-registry` déjà amenée par Tauri) : `RegisteredApplications`, les
    « Ouvrir avec » des extensions audio, et le choix de Windows (`UserChoice`) ;
  - le registre et le lancement passent par des traits (`Registry`, `Launcher`),
    simulés dans les tests ; aucun vrai lecteur ne démarre en test ;
  - Rust lance le programme lui-même, chaque fichier en argument séparé : jamais de
    `cmd /c`. Au-delà de 32 000 caractères, une liste M3U8 dans `cache\playlists` ;
  - les options des lecteurs connus (VLC, foobar2000, AIMP, MusicBee, Winamp) sont
    dans `KNOWN` (`player/mod.rs`), à vérifier sur le PC ;
  - une app du Store n'a pas de .exe : le premier morceau s'ouvre par l'Explorateur ;
  - icônes par la crate `file_icon_provider` (MIT) : le code `unsafe` reste dans la
    crate ;
  - l'interface désigne un lecteur par son `id` (jamais un chemin), un morceau par son
    identifiant. Le choix est gardé dans `settings` (`library/playback.rs`) ;
  - double clic : la ligne ; Entrée et le menu : la sélection. Des fichiers « en
    ligne uniquement » : l'interface demande avant (`allowOnline`).
- Lecteur intégré (KAN-8, `src-tauri/src/audio/`, `src/lib/audio.ts`, `NowPlaying.tsx`) :
  le choix par défaut de « Lire avec » (Réglages › Lecture, id `builtin`).
  - Son décodé par Symphonia et joué par rodio (cpal, WASAPI), sur ses propres fils :
    la lecture continue fenêtre réduite. Formats lus : MP3, FLAC, MP4 (AAC, ALAC), Ogg
    Vorbis, WAV, AIFF (`audio::reads`). L'Opus, l'APE, le WavPack, le Musepack et le
    WMA sont laissés de côté ; s'il n'y a qu'eux, le lecteur de Windows les lit.
  - `queue.rs` : la file par identifiant, aléatoire sans répétition avant d'avoir fait
    le tour, répéter (non, tout, un). `engine.rs` : la piste suivante est ajoutée à rodio
    5 s avant la fin de la courante, d'où l'enchaînement sans blanc ; un morceau
    introuvable, illisible ou d'un format non lu est passé, trois de suite arrêtent.
  - `clear` et `try_seek` de rodio attendent la sortie : la file de rodio est jetée au
    lieu d'être vidée, et une sortie perdue (rappel d'erreur de cpal) est rouverte.
  - Sortie et bibliothèque derrière des traits (`Output`, `Library`) : faux dans les
    tests, `Speakers::silent()` pour les commandes. Aucun test ne sort de son du PC.
  - Commandes : `audio_add` (lire, ensuite, à la fin), `audio_control` (les boutons),
    `audio_state`, `audio_queue` (une fenêtre de la file : 50 000 morceaux joués depuis
    une liste). Évènements : `player-state`, et `player-position` quatre fois par
    seconde, écouté par la seule barre de progression.
  - Double clic : la liste depuis la ligne ; seule la piste de départ, si elle n'est que
    sur OneDrive, fait poser la question. Un autre lecteur lancé met Kanade en pause.
  - File, position, volume et répétition gardés dans `settings` (`player_memory`),
    retrouvés en pause au lancement.
  - Touches multimédia, pastille de Windows, boutons de la vignette, sortie changée :
    KAN-55.
- Statistiques (KAN-36, page « Statistiques », `src/lib/stats.ts`) :
  - calculées dans l'interface, comme la Santé, sur les lignes de la liste : mêmes
    albums et artistes que les onglets. Les fichiers introuvables ne sont pas comptés ;
  - mesuré sur 50 000 morceaux : 160 à 200 ms (dont 77 ms pour les albums), lancé
    juste après l'affichage de la page ;
  - graphiques faits maison (`components/Charts.tsx`) : barres en HTML, colonnes en
    SVG, couleurs du thème ;
  - un chiffre qu'un filtre sait dire ouvre la liste filtrée (`TracksStart`, passé par
    `App`) ;
  - export : texte (copier, ou `stats_save_text`) et image. L'image est la carte SVG
    du résumé, ses styles recopiés sur chaque élément (`summaryImage.ts`), dessinée
    sur un canvas, puis envoyée en PNG à `stats_save_image`. Rust n'accepte qu'un
    texte de taille raisonnable ou un vrai PNG (`summary.rs`) ;
  - les statistiques d'écoute iront dans KAN-50, avec les écoutes de KAN-48.
- Favoris et notes (KAN-32, `library/marks.rs`, `src/lib/marks.ts`) :
  - un cœur et une note de 0 à 5 étoiles, dans les colonnes `favorite` et `rating` de
    `tracks` : ils suivent le morceau renommé ou déplacé ;
  - la liste les montre tout de suite (`mark` de `useTracks`, donné aux listes par
    `MarksContext`), puis les envoie à `tracks_mark` ; un refus relit la liste ;
  - touches 0 à 5 : la sélection, sinon le morceau qui a le focus. Les lettres sautent
    toujours au titre. Le favori : le cœur ou le menu du morceau ;
  - échange (`marks_export`, `marks_import`) : un JSON `kanade-marks` qui décrit chaque
    morceau par titre, artiste et album. La sauvegarde d'Ongaku se lit aussi (ses
    favoris). L'interface retrouve les morceaux comme Ongaku (même titre, artiste et
    album, sinon titre et artiste) et ajoute sans rien retirer ;
  - une colonne d'une nouvelle version se place après celle qu'elle suit par défaut
    (`completeView`) ;
  - lire et écrire les notes dans les fichiers : KAN-49, avec KAN-7.
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
- Apparence (KAN-44, page « Apparence ») :
  - les choix et leur effet sur `<html>` sont dans `src/lib/appearance.ts` : attributs
    `data-theme`, `data-contrast`, `data-density`, `data-motion`, `data-backdrop`, et
    variables CSS lues par `App.css` ;
  - `AppearanceProvider` lit l'apparence au lancement, applique chaque changement tout de
    suite et l'enregistre 300 ms plus tard. La dernière apparence est aussi dans le
    stockage du navigateur, appliquée avant le premier rendu (`main.tsx`) ;
  - côté Rust, un seul JSON dans `settings` (`library/appearance.rs`) ; une valeur
    inconnue redevient celle par défaut. Les listes (thèmes, polices, vitesses) existent
    des deux côtés : les garder pareilles ;
  - couleur principale : chaque couleur proposée a sa variante claire et sombre, une
    couleur libre est foncée ou éclaircie juste assez. Les tests vérifient le contraste
    AA (AAA en contraste élevé) des boutons, liens et lignes sélectionnées ;
  - sur une image ou le néon, les panneaux sont à 84 % (`--glass`) et le texte posé sur
    le fond a un halo. Changer ces nombres = refaire le calcul de `appearance.test.ts` ;
  - image de fond : un fichier `background.jpg` à côté de `kanade.db`, jamais dedans
    (`background.rs`). L'interface la réduit (2 560 px, JPEG) et envoie ses octets ; Rust
    refuse ce qui n'est pas un tel JPEG ;
  - la hauteur des lignes des listes virtualisées vient de `ROW_HEIGHTS`, partagée avec la
    CSS (`--track-row-height`) ;
  - polices livrées (Atkinson Hyperlegible, Nunito) : paquets `@fontsource` sous OFL,
    importés dans `main.tsx` (latin et latin-ext seulement).
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
