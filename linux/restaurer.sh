#!/usr/bin/env bash
# Remet le bureau comme avant l'installation : réglages GNOME (dernière sauvegarde de backup/),
# liens des dotfiles retirés et fichiers d'origine remis en place.
set -e
LINUX="$(cd "$(dirname "$0")" && pwd)"
LAST="$(ls -t "$LINUX"/backup/gnome-dconf-*.ini 2>/dev/null | head -1)"
[ -z "$LAST" ] && { echo "Aucune sauvegarde dans $LINUX/backup"; exit 1; }
gnome-extensions disable zecross-rice@zecross 2>/dev/null || true
dconf load /org/gnome/ < "$LAST"

# liens vers home/ retirés ; fichiers d'origine (backup/<date>/…) remis, le plus ancien gagne
while IFS= read -r -d '' link; do
  case "$(readlink "$link")" in "$LINUX/home/"*) rm -f "$link" ;; esac
done < <(find "$HOME/.local" "$HOME/.config" -type l -print0 2>/dev/null)
for d in $(ls -d "$LINUX"/backup/20*/ 2>/dev/null | sort -r); do
  (cd "$d" && find . -type f -print0) | while IFS= read -r -d '' rel; do
    mkdir -p "$HOME/$(dirname "${rel#./}")" && cp -a "$d/${rel#./}" "$HOME/${rel#./}"
  done
done

sed -i '/# >>> zecross-rice prompt >>>/,/# <<< zecross-rice prompt <<</d; /# zecross-rice prompt$/d' ~/.bashrc
rm -f ~/.config/autostart/kando.desktop ~/.config/autostart/zwheel.desktop
pkill -x zwheel 2>/dev/null || true
echo "Restauré depuis $(basename "$LAST"). Recharge GNOME (Alt+F2 r sous X11, ou déconnexion sous Wayland)."
