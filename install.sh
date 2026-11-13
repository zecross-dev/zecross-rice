#!/usr/bin/env bash
# Installe le « rice » zecross (GNOME / Ubuntu) sur la machine courante.
#
#   ./install.sh              barre en îlots, dock, thème, terminal, recherche d'applis…
#   ./install.sh --kando      + roue Kando (clic molette maintenu) et sous-menu Spotify
#
# Rien n'est supprimé : les réglages actuels sont sauvegardés dans ./backup/ avant.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
EXT_UUID="zecross-rice@zecross"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
WITH_KANDO=0
[ "${1:-}" = "--kando" ] && WITH_KANDO=1

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

SESSION="${XDG_SESSION_TYPE:-x11}"
GNOME_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
say "GNOME $GNOME_VER, session $SESSION"
[ "$GNOME_VER" -lt 46 ] && warn "GNOME < 46 : l'extension risque de ne pas fonctionner."
[ "$GNOME_VER" -gt 46 ] && warn "GNOME $GNOME_VER : extension écrite et testée sur GNOME 46, à vérifier."

mkdir -p "$BIN" "$REPO/backup"
dconf dump /org/gnome/ > "$REPO/backup/gnome-dconf-$(date +%F-%H%M).ini"
cp -n ~/.bashrc "$REPO/backup/bashrc.bak" 2>/dev/null || true

# ------------------------------------------------------------ binaires Rust
if command -v cargo >/dev/null; then
  say "Compilation de zsearch (moteur de recherche d'applis)"
  (cd "$REPO/zsearch" && cargo build --release -q) && install -m755 "$REPO/zsearch/target/release/zsearch" "$BIN/zsearch"
  if [ "$WITH_KANDO" = 1 ]; then
    say "Compilation de zwheel (clic molette maintenu -> roue)"
    (cd "$REPO/zwheel" && cargo build --release -q) && install -m755 "$REPO/zwheel/target/release/zwheel" "$BIN/zwheel"
  fi
else
  warn "cargo absent : installe Rust (https://rustup.rs) puis relance pour la recherche d'applis."
fi

# ------------------------------------------------------------ scripts
say "Scripts dans $BIN"
for f in zgithub zlaunch zspot zspotify zkando-icons zdiscord; do install -m755 "$REPO/bin/$f" "$BIN/$f"; done

# ------------------------------------------------------------ extension GNOME
say "Extension GNOME $EXT_UUID"
mkdir -p "$EXT_DIR"
rsync -a --delete --exclude gschemas.compiled "$REPO/gnome-extension/$EXT_UUID/" "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/schemas"
python3 - "$EXT_UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
lst = ast.literal_eval(cur.replace("@as ", "")) if cur else []
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)])
EOF

# ------------------------------------------------------------ réglages
say "Dock, thème, raccourcis"
dconf load / < "$REPO/dconf/settings.ini"
PROFILE="$(gsettings get org.gnome.Terminal.ProfilesList default 2>/dev/null | tr -d "'" || true)"
if [ -n "$PROFILE" ]; then
  say "Profil du terminal (GNOME Terminal)"
  dconf load "/org/gnome/terminal/legacy/profiles:/:$PROFILE/" < "$REPO/dconf/terminal-profile.ini"
fi
# Ptyxis (terminal par défaut depuis Ubuntu 25.04)
PTX="$(gsettings get org.gnome.Ptyxis default-profile-uuid 2>/dev/null | tr -d "'" || true)"
if [ -n "$PTX" ]; then
  say "Profil du terminal (Ptyxis)"
  mkdir -p ~/.local/share/org.gnome.Ptyxis/palettes
  cp "$REPO/dconf/zecross-violet.palette" ~/.local/share/org.gnome.Ptyxis/palettes/
  SP="org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/$PTX/"
  gsettings set "$SP" palette 'zecross-violet'
  gsettings set "$SP" opacity 0.88
  gsettings set "$SP" label 'Zecross Violet'
  gsettings set org.gnome.Ptyxis audible-bell false
  gsettings set org.gnome.Ptyxis cursor-shape 'ibeam'
  gsettings set org.gnome.Ptyxis scrollbar-policy 'always'
fi
gsettings set org.freedesktop.ibus.general.hotkey triggers "@as []" 2>/dev/null || true

# ------------------------------------------------------------ audio Bluetooth
# le casque reste en mode musique (A2DP) quand Discord ouvre le micro (sinon la musique coupe)
if command -v wireplumber >/dev/null; then
  say "Audio : casque Bluetooth toujours en mode musique"
  mkdir -p ~/.config/wireplumber/wireplumber.conf.d
  cp "$REPO/pipewire/51-zecross-bluetooth.conf" ~/.config/wireplumber/wireplumber.conf.d/
  warn "Le micro utilisé en vocal sera celui du PC, le micro du casque n'est plus utilisé (actif après reconnexion)."
fi
# puce Bluetooth jamais en veille USB (coupures audio sur les puces Intel)
if [ ! -f /etc/udev/rules.d/71-zecross-bt-power.rules ]; then
  say "Bluetooth : pas de mise en veille de la puce (mot de passe sudo)"
  sudo install -m644 "$REPO/pipewire/71-zecross-bt-power.rules" /etc/udev/rules.d/ \
    && sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=usb --attr-match=bDeviceClass=e0 \
    || warn "règle udev Bluetooth non installée"
fi

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
  python3 "$REPO/wallpaper.py" "$WALL" >/dev/null
  for k in picture-uri picture-uri-dark; do gsettings set org.gnome.desktop.background "$k" "file://$WALL"; done
else
  warn "Pillow absent (sudo apt install python3-pil) : fond d'écran non généré."
fi

# ------------------------------------------------------------ prompt bash
if ! grep -q "zecross-rice prompt" ~/.bashrc; then
  say "Prompt bash"
  { echo; cat "$REPO/shell/bashrc-prompt.sh"; } >> ~/.bashrc
fi

# ------------------------------------------------------------ Kando
if [ "$WITH_KANDO" = 1 ]; then
  if [ ! -x "$HOME/.local/opt/kando/kando" ]; then
    say "Téléchargement de Kando"
    url="$(curl -fsSL https://api.github.com/repos/kando-menu/kando/releases/latest | python3 -c 'import json,sys; print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].startswith("Kando-linux-x64") and a["name"].endswith(".zip")))')"
    tmp="$(mktemp -d)"; curl -fsSL -o "$tmp/k.zip" "$url"; unzip -q "$tmp/k.zip" -d "$tmp"
    mkdir -p "$HOME/.local/opt" && rm -rf "$HOME/.local/opt/kando" && mv "$tmp"/Kando-linux-x64 "$HOME/.local/opt/kando"; rm -rf "$tmp"
  fi
  install -m755 "$REPO/bin/kando" "$BIN/kando"
  mkdir -p ~/.config/kando ~/.local/share/applications ~/.config/autostart
  [ -f ~/.config/kando/menus.json ] && cp ~/.config/kando/menus.json "$REPO/backup/kando-menus.json.bak"
  sed "s#@HOME@#$HOME#g" "$REPO/kando/menus.template.json" > ~/.config/kando/menus.json
  cp "$REPO/kando/config.json" ~/.config/kando/config.json
  "$BIN/zkando-icons" || warn "icônes de la roue non reconstruites"
  while read -r link; do [ -n "$link" ] && "$BIN/zspot" add "$link" >/dev/null || true; done < "$REPO/kando/spotify-playlists.txt"
  "$BIN/zspot" menu >/dev/null || true
  printf '[Desktop Entry]\nType=Application\nName=Kando\nExec=%s/.local/bin/kando\nIcon=kando\nCategories=Utility;\n' "$HOME" > ~/.local/share/applications/kando.desktop
  printf '[Desktop Entry]\nType=Application\nName=Kando\nExec=%s/.local/bin/kando\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$HOME" > ~/.config/autostart/kando.desktop
  if [ -x "$BIN/zwheel" ]; then
    printf '[Desktop Entry]\nType=Application\nName=zwheel (roue molette)\nExec=%s/.local/bin/zwheel --hold 180 -- %s/.local/bin/kando --menu Applications\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$HOME" "$HOME" > ~/.config/autostart/zwheel.desktop
    if [ "$SESSION" != "x11" ]; then
      # Wayland : zwheel lit les souris via evdev et réémet via uinput -> règle udev « uaccess »
      if [ ! -f /etc/udev/rules.d/70-zwheel.rules ]; then
        say "Règle udev pour zwheel (mot de passe sudo)"
        sudo install -m644 "$REPO/zwheel/70-zwheel.rules" /etc/udev/rules.d/70-zwheel.rules \
          && sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=input --subsystem-match=misc \
          || warn "règle udev non installée : le clic molette ne marchera pas sous Wayland"
      fi
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
