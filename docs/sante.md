# Santé de la bibliothèque : les règles

La page « Santé » de Kanade (KAN-28) montre ce qui ne va pas dans la collection. Ce
document fixe ses règles de détection, pour qu'Ongaku les reprenne (ONG-59) et que les
deux apps disent la même chose de la même collection. Le code est dans
`src/lib/health.ts`, et chaque règle y a son test (`src/lib/health.test.ts`).

## Principes

- **Lecture seule** : l'écran montre, explique et propose ; il ne modifie aucun fichier.
  La correction passera par l'édition des tags (KAN-7).
- **Rien n'est relu** : tout vient de l'index, sauf la présence d'une image de pochette
  dans un dossier, que seul le disque connaît (Rust, `tracks_without_folder_cover`).
- **Morceaux pris en compte** : ceux présents. Un fichier disparu n'est jamais signalé ;
  un illisible n'est signalé qu'en « Fichiers illisibles ».
- **Même nom** : deux textes sont le même nom quand ils sont égaux sans casse, sans
  accents, sans espaces ni signes (« AC/DC », « Ac-Dc » et « acdc »). Un nom fait
  seulement de signes (« !!! ») n'est comparé à rien.
- **Valeur proposée** : la plus fréquente ; à égalité, celle rencontrée en premier.
- **Album** : celui de Kanade (titre et artiste de l'album, sans casse ni accents ; une
  année différente donne un autre album, voir `src/lib/albums.ts`). Les contrôles
  « dans un dossier » prennent les pistes d'un même dossier dont l'album est le même nom.

## Les contrôles, du plus grave au plus bénin

| Gravité | Contrôle | Règle |
|---|---|---|
| Grave | Fichiers illisibles | Le dernier scan n'a pas pu lire le fichier. |
| Grave | Durée nulle | Lu, mais durée absente ou égale à 0. |
| À corriger | Pistes en double | Dans un album, deux pistes du même disque portent le même numéro. |
| À corriger | Pistes manquantes | Dans un album, des numéros manquent entre 1 et la plus haute piste d'un disque. Ignoré au-delà de 98 numéros manquants (la numérotation veut dire autre chose). |
| À corriger | Album écrit de plusieurs façons | Dans un dossier, les pistes du même album l'écrivent de plusieurs façons. |
| À corriger | Années différentes dans un album | Dans un dossier, les pistes du même album donnent plusieurs années (les pistes sans année ne comptent pas). |
| À corriger | Artiste de l'album absent ou différent | Dans un dossier, les pistes du même album ont plusieurs artistes de l'album, ou une partie n'en a pas. |
| À corriger | Sans titre | Pas de tag titre (Kanade montre le nom du fichier). |
| À corriger | Sans artiste | Pas d'artiste, ou seulement des espaces. |
| À corriger | Sans album | Pas d'album, ou seulement des espaces. |
| À corriger | Sans numéro de piste | Dans un album, sans numéro. |
| À corriger | Artistes écrits de plusieurs façons | Parmi les artistes et artistes de l'album, le même nom écrit de plusieurs façons ; une différence d'espaces seule relève du contrôle suivant. |
| À corriger | Espaces en trop dans un artiste | Un espace au début, à la fin, ou plusieurs à la suite. |
| À corriger | Genres en chiffres | Un genre fait d'un numéro, avec ou sans parenthèses : « (17) », « 17 ». Le nom proposé vient de la table d'ID3v1 et de Winamp (192 genres, de 0 « Blues » à 191 « Psybient ») ; au-delà, « un numéro inconnu ». |
| À corriger | Genres écrits de plusieurs façons | Le même genre écrit de plusieurs façons (les genres en chiffres à part). |
| À corriger | Albums sans pochette | Aucune piste de l'album n'a d'image dans ses tags, et son dossier n'a pas de `cover`, `folder`, `front` ou `albumart` en `.jpg`, `.jpeg`, `.png` ou `.webp`. |
| À voir | Formats mélangés dans un album | Plusieurs formats dans un album. |
| À voir | Débit bas | MP3, MP4 ou AAC sous 128 kb/s, Ogg Vorbis sous 112, Opus sous 64. Les formats sans perte ne sont pas concernés. |
| À voir | Sans année | Dans un album, sans année. |
| À voir | Sans genre | Pas de genre, ou seulement des espaces. |
| À voir | Genres très rares | Parmi au moins 200 morceaux avec un genre : un genre porté par un ou deux morceaux, qui n'est ni un numéro ni une autre écriture d'un genre plus fréquent. |

## Score

Le pourcentage des morceaux (présents ou illisibles) qui ne sont fautifs dans aucun
contrôle grave ou à corriger. Les contrôles « à voir » et les signalements ignorés ne
comptent pas.

Un morceau est **fautif** quand c'est son tag qui s'écarte : celui dont l'album, l'année
ou l'artiste de l'album n'est pas la valeur la plus fréquente, celui qui porte le numéro
en double, l'écriture minoritaire d'un nom. Une piste manquante ne rend fautif aucun des
fichiers présents.

## Ignorer

Un signalement ignoré est gardé dans la base sous la forme `contrôle|clé`, la clé
désignant un morceau (`track:12`), un album (`album:…`), un album dans un dossier
(`folder:…`), un artiste (`artist:…`) ou un genre (`genre:…`). Il ne revient pas, et
peut être montré de nouveau puis remis.
