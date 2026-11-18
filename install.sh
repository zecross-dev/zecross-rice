#!/usr/bin/env bash
# Point d'entrée : lance l'installation du système courant (voir linux/ et windows/).
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in
  Linux) exec "$DIR/linux/install.sh" "$@" ;;
  *) echo "Sous Windows : voir windows/README.md" >&2; exit 1 ;;
esac
