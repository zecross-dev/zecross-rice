#!/usr/bin/env bash
# Remet le bureau comme avant l'installation (dernière sauvegarde de ./backup/).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LAST="$(ls -t "$DIR"/backup/gnome-dconf-*.ini 2>/dev/null | head -1)"
[ -z "$LAST" ] && { echo "Aucune sauvegarde dans $DIR/backup"; exit 1; }
gnome-extensions disable zecross-rice@zecross 2>/dev/null || true
dconf load /org/gnome/ < "$LAST"
sed -i '/# >>> zecross-rice prompt >>>/,/# <<< zecross-rice prompt <<</d' ~/.bashrc
rm -f ~/.config/autostart/kando.desktop ~/.config/autostart/zwheel.desktop
pkill -x zwheel 2>/dev/null || true
echo "Restauré depuis $(basename "$LAST"). Recharge GNOME (Alt+F2 r sous X11, ou déconnexion sous Wayland)."
