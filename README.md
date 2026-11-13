# zecross-rice

Config GNOME perso, violet / blanc / noir, pour Ubuntu.

## Ce qu'il y a dedans

| Élément | Détail |
|---|---|
| **Barre du haut en îlots** | 4 îlots « verre » (fond noir, contour blanc, halo) : Activités + Spotify, horloge, utilisation Claude, icônes système |
| **Widget Spotify** | titre/artiste dans la barre ; au clic : pochette, playlist en cours, ⏮ ⏯ ⏭, volume de Spotify |
| **Îlot Discord** | ta photo de profil ; en vocal : salon + avatars (anneau violet = parle) ; au clic : membres, Micro / Casque / Quitter, sous-menu « Rejoindre un vocal » (salons où il y a du monde) |
| **Widget Claude** | utilisation 5 h et hebdo (lit `~/.claude/.credentials.json`, jamais stocké) |
| **Dock à gauche** | même style que la barre, bouton 🔍 en haut |
| **Recherche d'applis** | `Super+F` ou 🔍, moteur `zsearch` en Rust (tolère les fautes, accents, noms FR, frécence) |
| **Sélecteur de terminaux** | `Super+Espace`, aperçus en direct, `Ctrl+Entrée` = nouveau terminal |
| **Fenêtres** | coins arrondis (shader), espace sous la barre / en bas / à droite sur l'écran principal |
| **Roue Kando** *(option)* | clic molette **maintenu** (`zwheel`, Rust, X11 et Wayland) ou `Super+W` ; applis, sous-menu JetBrains (RustRover / IntelliJ / Android Studio / Toolbox), bouton Git intelligent (GitHub ou GitLab : PR/MR ouverte, sinon branche courante), sous-menu Spotify |
| **Thème** | Yaru-purple-dark, curseur Bibata, fond d'écran généré, terminal violet + prompt bash |

## Installation

```bash
git clone git@github.com:zecross-dev/zecross-rice.git ~/zecross-rice
cd ~/zecross-rice
./install.sh            # tout sauf la roue
./install.sh --kando    # + roue Kando
```

Prérequis : Ubuntu avec GNOME, `python3`, `curl`, `rsync`, `unzip`.
Recommandé : Rust (`rustup`) pour `zsearch`/`zwheel`, `python3-pil` pour le fond d'écran, `gh` pour le bouton GitHub.

Ensuite : **X11** → `Alt+F2`, `r`, Entrée. **Wayland** → se déconnecter / reconnecter.

Retour arrière : `./restaurer.sh` (réglages sauvegardés dans `backup/` à chaque installation).

## Compatibilité

- Écrit et testé sur **Ubuntu 24.04, GNOME 46, X11**.
- Testé aussi sur **GNOME 50, Wayland** (Ubuntu récente, terminal Ptyxis).
- GNOME 47 → 49 déclarés dans `metadata.json` mais **non testés** : si quelque chose casse,
  `journalctl --user -b | grep -i zecross` donne l'erreur.
- **Wayland** (Ubuntu 25.10+ n'a plus de session X11) :
  - `zwheel` passe en mode **evdev** : il lit les souris dans `/dev/input` et réémet via une souris
    virtuelle (`uinput`). `install.sh --kando` installe la règle udev `zwheel/70-zwheel.rules`
    (accès « uaccess » pour la session active, demande `sudo`).
  - l'extension GNOME « Kando Integration » est nécessaire (raccourci `Super+W`, position du pointeur).
  - le rechargement à chaud de l'extension marche, mais le premier chargement demande une reconnexion.

## Discord (vocaux)

Passe par le RPC local du client Discord avec **ta propre app** (rien n'est publié, aucun bot) :

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → ajouter la redirection `http://localhost` → copier **Client ID** et **Client Secret**.
3. `zdiscord setup` (le secret est demandé au clavier, jamais en argument), puis `zdiscord login`
   et accepter la fenêtre qui s'ouvre dans Discord.

Config et jetons : `~/.config/zdiscord/` (droits 600), jamais dans ce dépôt.
`zdiscord` est un script Python sans dépendance qui marche aussi **sous Windows** (named pipe).
Le sous-menu « Rejoindre » liste les salons vocaux occupés de tes serveurs (Discord n'expose pas
la présence vocale des amis hors serveurs communs).

## Terminal sans molette

La barre de défilement du terminal est toujours visible. Pour qu'elle marche aussi dans **Claude Code**,
passer en affichage classique (la conversation va dans l'historique du terminal au lieu d'un écran plein écran) :
`/tui default` dans Claude Code, ou `"tui": "default"` dans `~/.claude/settings.json`.
En plein écran, seuls `PgUp` / `PgDn` / `Ctrl+Home` / `Ctrl+End` font défiler.

## Bouton Git de la roue (`zgithub`)

Ouvre le dépôt de la fenêtre active (terminal, JetBrains, VS Code) :
- **GitHub** : PR ouverte de la branche (via `gh`), sinon la branche courante.
- **GitLab** (gitlab.com ou toute instance, détectée via son API) : MR ouverte, sinon la branche.
  Projet privé : ajouter un jeton `read_api` dans `~/.config/zgithub/gitlab-tokens` (`hôte jeton`, droits 600) ou installer `glab`.
- Navigateur : `~/.config/zgithub/browser` (ex. `opera`), mis au premier plan par l'extension.
- Dernière détection : `~/.cache/zgithub/last.log`.

## Spotify

- Sans compte développeur : `zspot add <lien de playlist>` ajoute une playlist à la roue.
- Avec l'API (playlists automatiques + titre au hasard parmi les likés) :
  créer une app sur <https://developer.spotify.com/dashboard> (Redirect URI `http://127.0.0.1:8888/callback`, Web API),
  puis `zspot setup <client_id>` et `zspot login`.

## Arborescence

```
gnome-extension/zecross-rice@zecross/   extension (extension.js = chargeur à chaud, core.js = code)
zsearch/  zwheel/                        sources Rust
bin/                                     zgithub, zlaunch, zspot, zspotify, zkando-icons, kando
kando/                                   menu de la roue (modèle), thème, playlists
dconf/                                   réglages dock/thème/raccourcis + profil terminal
shell/bashrc-prompt.sh                   prompt
wallpaper.py                             génère le fond d'écran
windows/PROMPT-windows.md                prompt pour refaire une config similaire sur Windows
```
