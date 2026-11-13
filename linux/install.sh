#!/usr/bin/env bash
# Installe le rice zecross (GNOME / Ubuntu) sur la machine courante.
#
#   ./install.sh              liens des dotfiles + barre, dock, thème, terminal, recherche d'applis
#   ./install.sh --kando      + roue Kando (clic molette maintenu) et sous-menu Spotify
#   ./install.sh --links      seulement (re)faire les liens des dotfiles (après un git pull)
#
# Dotfiles : home/<paquet>/ reproduit $HOME (format GNU Stow). Chaque fichier est lié par
# un lien symbolique (équivalent de « stow --no-folding -d home -t ~ <paquet> ») : modifier
# la config sur la machine, c'est modifier le dépôt. Un fichier déjà présent est d'abord
# déplacé dans backup/ (rien n'est supprimé).
set -euo pipefail

LINUX="$(cd "$(dirname "$0")" && pwd)"
HOME_PKGS="$LINUX/home"
SETUP="$LINUX/setup"
BIN="$HOME/.local/bin"
EXT_UUID="zecross-rice@zecross"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
STAMP="$(date +%F-%H%M%S)"
BACKUP="$LINUX/backup/$STAMP"
PACKAGES=(bin gnome-shell bash ptyxis wireplumber)

WITH_KANDO=0 LINKS_ONLY=0
for a in "$@"; do
  case "$a" in
    --kando) WITH_KANDO=1 ;;
    --links) LINKS_ONLY=1 ;;
    *) echo "option inconnue : $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------ liens des dotfiles
# lie chaque fichier de home/<paquet>/ vers $HOME (les dossiers restent de vrais dossiers)
link_pkg() {
  local src="$HOME_PKGS/$1" rel dst target n=0
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    case "$rel" in */gschemas.compiled|*/__pycache__/*) continue ;; esac
    dst="$HOME/$rel" target="$src/$rel"
    [ -L "$dst" ] && [ "$(readlink "$dst")" = "$target" ] && continue
    mkdir -p "$(dirname "$dst")"
    if [ -e "$dst" ] || [ -L "$dst" ]; then
      mkdir -p "$BACKUP/$(dirname "$rel")"
      mv "$dst" "$BACKUP/$rel"
    fi
    ln -s "$target" "$dst"
    n=$((n + 1))
  done < <(cd "$src" && find . \( -type f -o -type l \) -print0)
  printf '   %-12s %s lien(s)\n' "$1" "$n"
}

say "Dotfiles : liens vers $HOME"
for p in "${PACKAGES[@]}"; do link_pkg "$p"; done
[ -d "$BACKUP" ] && warn "Fichiers remplacés sauvegardés dans ${BACKUP#$LINUX/}"
glib-compile-schemas "$EXT_DIR/schemas"

# prompt : une ligne qui charge ~/.config/zecross/bashrc-prompt.sh
if ! grep -q "zecross-rice prompt" ~/.bashrc 2>/dev/null; then
  say "Prompt bash"
  printf '\n[ -f ~/.config/zecross/bashrc-prompt.sh ] && . ~/.config/zecross/bashrc-prompt.sh  # zecross-rice prompt\n' >> ~/.bashrc
fi

if [ "$LINKS_ONLY" = 1 ]; then
  say "Liens à jour."
  exit 0
fi

# ------------------------------------------------------------ vérifications, sauvegarde
SESSION="${XDG_SESSION_TYPE:-x11}"
GNOME_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
say "GNOME $GNOME_VER, session $SESSION"
[ "$GNOME_VER" -lt 46 ] && warn "GNOME < 46 : l'extension risque de ne pas fonctionner."

mkdir -p "$LINUX/backup"
dconf dump /org/gnome/ > "$LINUX/backup/gnome-dconf-$STAMP.ini"
cp -n ~/.bashrc "$LINUX/backup/bashrc.bak" 2>/dev/null || true

# ------------------------------------------------------------ binaires Rust
if command -v cargo >/dev/null; then
  say "Compilation de zsearch (moteur de recherche d'applis)"
  (cd "$LINUX/src/zsearch" && cargo build --release -q) && install -m755 "$LINUX/src/zsearch/target/release/zsearch" "$BIN/zsearch"
  if [ "$WITH_KANDO" = 1 ]; then
    say "Compilation de zwheel (clic molette maintenu -> roue)"
    (cd "$LINUX/src/zwheel" && cargo build --release -q) && install -m755 "$LINUX/src/zwheel/target/release/zwheel" "$BIN/zwheel"
  fi
else
  warn "cargo absent : installe Rust (https://rustup.rs) puis relance pour la recherche d'applis."
fi

# ------------------------------------------------------------ extension GNOME
say "Extension GNOME $EXT_UUID"
python3 - "$EXT_UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
lst = ast.literal_eval(cur.replace("@as ", "")) if cur else []
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)])
EOF

# ------------------------------------------------------------ réglages GNOME (dconf)
say "Dock, thème, raccourcis"
dconf load / < "$SETUP/dconf/settings.ini"
PROFILE="$(gsettings get org.gnome.Terminal.ProfilesList default 2>/dev/null | tr -d "'" || true)"
if [ -n "$PROFILE" ]; then
  say "Profil du terminal (GNOME Terminal)"
  dconf load "/org/gnome/terminal/legacy/profiles:/:$PROFILE/" < "$SETUP/dconf/terminal-profile.ini"
fi
# Ptyxis (terminal par défaut depuis Ubuntu 25.04) : la palette est liée par le paquet « ptyxis »
PTX="$(gsettings get org.gnome.Ptyxis default-profile-uuid 2>/dev/null | tr -d "'" || true)"
if [ -n "$PTX" ]; then
  say "Profil du terminal (Ptyxis)"
  SP="org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/$PTX/"
  gsettings set "$SP" palette 'zecross-violet'
  gsettings set "$SP" opacity 0.88
  gsettings set "$SP" label 'Zecross Violet'
  gsettings set org.gnome.Ptyxis audible-bell false
  gsettings set org.gnome.Ptyxis cursor-shape 'ibeam'
  gsettings set org.gnome.Ptyxis scrollbar-policy 'always'
fi
gsettings set org.freedesktop.ibus.general.hotkey triggers "@as []" 2>/dev/null || true

# ------------------------------------------------------------ fichiers système (copiés, sudo)
# system/ reproduit / : règles udev (Bluetooth sans veille, zwheel sous Wayland)
install_system() { # $1 = chemin sous system/, $2 = description
  local src="$LINUX/system/$1" dst="/$1"
  if ! cmp -s "$src" "$dst" 2>/dev/null; then
    say "$2 (mot de passe sudo)"
    sudo install -m644 "$src" "$dst" && sudo udevadm control --reload && sudo udevadm trigger || warn "non installé : $dst"
  fi
}
install_system etc/udev/rules.d/71-zecross-bt-power.rules "Bluetooth : pas de mise en veille de la puce"
command -v wireplumber >/dev/null && warn "Audio : le casque Bluetooth reste en mode musique, le micro utilisé en vocal est celui du PC."

# ------------------------------------------------------------ curseur
if [ ! -d "$HOME/.local/share/icons/Bibata-Modern-Classic" ]; then
  say "Curseur Bibata"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/b.tar.xz" https://github.com/ful1e5/Bibata_Cursor/releases/download/v2.0.7/Bibata-Modern-Classic.tar.xz
  mkdir -p "$HOME/.local/share/icons" && tar -xf "$tmp/b.tar.xz" -C "$HOME/.local/share/icons"
  mkdir -p "$HOME/.icons" && ln -sfn "$HOME/.local/share/icons/Bibata-Modern-Classic" "$HOME/.icons/Bibata-Modern-Classic"
  rm -rf "$tmp"
fi

# ------------------------------------------------------------ fond d'écran
WALL="$(xdg-user-dir PICTURES 2>/dev/null || echo "$HOME/Images")/zecross-violet.png"
if python3 -c "import PIL" 2>/dev/null; then
  say "Fond d'écran"
  python3 "$SETUP/wallpaper.py" "$WALL" >/dev/null
  for k in picture-uri picture-uri-dark; do gsettings set org.gnome.desktop.background "$k" "file://$WALL"; done
else
  warn "Pillow absent (sudo apt install python3-pil) : fond d'écran non généré."
fi

# ------------------------------------------------------------ Kando
if [ "$WITH_KANDO" = 1 ]; then
  if [ ! -x "$HOME/.local/opt/kando/kando" ]; then
    say "Téléchargement de Kando"
    url="$(curl -fsSL https://api.github.com/repos/kando-menu/kando/releases/latest | python3 -c 'import json,sys; print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].startswith("Kando-linux-x64") and a["name"].endswith(".zip")))')"
    tmp="$(mktemp -d)"; curl -fsSL -o "$tmp/k.zip" "$url"; unzip -q "$tmp/k.zip" -d "$tmp"
    mkdir -p "$HOME/.local/opt" && rm -rf "$HOME/.local/opt/kando" && mv "$tmp"/Kando-linux-x64 "$HOME/.local/opt/kando"; rm -rf "$tmp"
  fi
  # config et menu de Kando : copiés, pas liés (Kando et zspot / zkando-icons les réécrivent)
  mkdir -p ~/.config/kando ~/.local/share/applications ~/.config/autostart
  [ -f ~/.config/kando/menus.json ] && cp ~/.config/kando/menus.json "$LINUX/backup/kando-menus-$STAMP.json"
  sed "s#@HOME@#$HOME#g" "$SETUP/kando/menus.template.json" > ~/.config/kando/menus.json
  cp "$SETUP/kando/config.json" ~/.config/kando/config.json
  "$BIN/zkando-icons" || warn "icônes de la roue non reconstruites"
  while read -r link; do [ -n "$link" ] && "$BIN/zspot" add "$link" >/dev/null || true; done < "$SETUP/kando/spotify-playlists.txt"
  "$BIN/zspot" menu >/dev/null || true
  printf '[Desktop Entry]\nType=Application\nName=Kando\nExec=%s/.local/bin/kando\nIcon=kando\nCategories=Utility;\n' "$HOME" > ~/.local/share/applications/kando.desktop
  printf '[Desktop Entry]\nType=Application\nName=Kando\nExec=%s/.local/bin/kando\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$HOME" > ~/.config/autostart/kando.desktop
  if [ -x "$BIN/zwheel" ]; then
    printf '[Desktop Entry]\nType=Application\nName=zwheel (roue molette)\nExec=%s/.local/bin/zwheel --hold 180 -- %s/.local/bin/kando --menu Applications\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$HOME" "$HOME" > ~/.config/autostart/zwheel.desktop
    if [ "$SESSION" != "x11" ]; then
      # Wayland : zwheel lit les souris (evdev) et réémet (uinput) -> règle udev « uaccess »
      install_system etc/udev/rules.d/70-zwheel.rules "Règle udev pour zwheel"
      warn "Wayland : installe aussi l'extension « Kando Integration » (raccourci clavier + position du pointeur)."
    fi
  else
    warn "zwheel absent (cargo manquant ?) : pas de roue au clic molette."
  fi
fi

say "Terminé."
if [ "$SESSION" = "x11" ]; then
  echo "Recharge GNOME : Alt+F2, tape r, Entrée."
else
  echo "Déconnecte-toi puis reconnecte-toi pour charger l'extension (Wayland)."
fi
