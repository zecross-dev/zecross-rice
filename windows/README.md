<div align="center">

# 🪟 zecross-rice · Windows

**Le même rice en îlots de verre, sur Windows 11**

![Windows 11](https://img.shields.io/badge/Windows-11-8b5cf6?style=flat-square&logo=windows11&logoColor=white)
![statut](https://img.shields.io/badge/statut-en_cours-f5d38a?style=flat-square)

<!-- capture à ajouter : assets/windows/desktop.jpg -->

</div>

> [!NOTE]
> La version Windows est **en cours de construction**. Ce fichier décrit la cible et la façon de
> l'installer ; les outils retenus et les captures seront complétés une fois la config terminée.

---

## 📋 Détails (cible)

| | |
|---|---|
| **OS** | Windows 11 |
| **Barre** | îlots flottants en CSS (YASB ou Zebar) — barre des tâches native masquée |
| **Dock** | vertical à gauche, bouton 🔍 en haut (Seelen UI ou équivalent) |
| **Lanceur** | `Win+F` : tolère les fautes, ignore les accents, frécence (Flow Launcher / PowerToys, ou `zsearch`) |
| **Roue** | [Kando](https://kando.menu) natif + AutoHotkey v2 (clic molette maintenu ~180 ms) |
| **Terminal** | Windows Terminal — thème *Zecross Violet* |
| **Prompt** | deux lignes `╭─ user • chemin ⎇ branche` / `╰─❯` (Oh My Posh ou Starship) |
| **Curseur** | Bibata Modern Classic |
| **Fond d'écran** | généré par `linux/setup/wallpaper.py` |

### 🎨 Palette

Identique à Linux : îlots `rgba(0,0,0,.86)`, contour + halo blancs, texte `#b98cff`,
accent `#8b5cf6`, terminal `#0d0a14` / `#ece4ff`. Coins : 15 px (barre), 22 px (dock), 20 px (fenêtres).

---

## ✨ Composants

| | Linux | Windows |
|---|---|---|
| Barre en îlots (média, horloge, Claude, système) | extension GNOME | YASB / Zebar |
| Widget Spotify (pochette, ⏮ ⏯ ⏭, volume de Spotify seul) | MPRIS | API média Windows |
| Îlot Discord (vocaux des amis, ☆, 📌, Rejoindre) | `zdiscord` | **`zdiscord` tel quel** (named pipe) |
| Widget Claude (5 h · hebdo) | lit `~/.claude/.credentials.json` | lit `%USERPROFILE%\.claude\.credentials.json` |
| Dock à gauche + 🔍 | Ubuntu Dock | Seelen UI ou équivalent |
| Recherche d'applis | `zsearch` | `Win+F` |
| Sélecteur de terminaux | `Super+Espace` | `Win+Espace` (AutoHotkey v2) |
| Roue Kando + bouton Git (GitHub / GitLab) + JetBrains + Spotify | `zwheel` | AutoHotkey v2 + IPC Kando |
| Coins arrondis, espace autour des fenêtres | shader GNOME | natif Windows 11 |

---

## ⌨️ Raccourcis (cible)

| Touche | Action |
|---|---|
| `Win` + `F` | recherche d'applis |
| `Win` + `Espace` | sélecteur de terminaux |
| clic molette maintenu | roue Kando |

---

## 📦 Installation

La config Windows est construite par Claude Code à partir du prompt fourni :

1. Ouvre [`PROMPT-windows.md`](PROMPT-windows.md).
2. Lance Claude Code dans PowerShell, dans un dossier vide (ex. `C:\Users\<toi>\zecross-rice-win`).
3. Colle le prompt (à partir de « Tu es… ») et clone ce dépôt à côté pour qu'il s'en inspire.

Il produit un dépôt avec `install.ps1` (rejouable), `restaurer.ps1` (point de restauration + sauvegarde
du registre) et toutes les configs.

### Discord sous Windows

`zdiscord` (`linux/home/bin/.local/bin/zdiscord`) est un script Python sans dépendance qui marche tel quel :
`python zdiscord setup`, puis `python zdiscord login`. Config et jetons dans `%APPDATA%\zdiscord\`,
avatars en cache dans `%LOCALAPPDATA%\zdiscord\avatars`.

<div align="center">

[⬅ retour](../README.md) · [🐧 version Linux](../linux/README.md)

</div>
