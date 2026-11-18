# Prompt — refaire ma config « zecross-rice » sur Windows 11

> Copie tout ce qui suit (à partir de « Tu es… ») dans Claude Code lancé sur ta machine Windows
> (PowerShell, dans un dossier vide, par ex. `C:\Users\<toi>\zecross-rice-win`).
> Clone aussi le repo Linux à côté pour qu'il puisse s'en inspirer :
> `git clone https://github.com/zecross-dev/zecross-rice.git`

---

Tu es mon assistant de personnalisation Windows 11. J'ai une config Linux (GNOME) que j'adore,
dans le repo `zecross-rice` (clone à côté, lis son `README.md`, `linux/README.md`,
`linux/home/gnome-shell/…/stylesheet.css` et `linux/setup/kando/menus.template.json` pour les détails). Je veux le **même look et les mêmes usages sur Windows**,
avec les meilleurs outils Windows, pas une copie forcée. Réponds-moi en français.

## Règles

- **Avant tout** : crée un point de restauration système et sauvegarde les réglages que tu modifies
  (registre exporté, configs) dans `backup/`. Écris un `restaurer.ps1`.
- Installe via **winget** quand c'est possible. Pas de droits admin sauf nécessité, et dis-moi quand.
- Mets toute la config (fichiers de conf, scripts, styles) dans **un repo git** à part, avec un `install.ps1`
  rejouable, pour que je puisse la réinstaller ailleurs.
- Vérifie chaque étape (capture d'écran ou état réel), dis-moi franchement ce qui marche ou pas.
- Pour chaque composant, si plusieurs outils existent, choisis-en un, explique en une phrase pourquoi,
  et passe à la suite (ne me fais pas un catalogue).

## Style à reproduire

- Palette : fond **noir** `rgba(0,0,0,0.86)`, contour **blanc** 1 px `rgba(255,255,255,0.9)`,
  **halo blanc** autour (`0 0 16px 2px rgba(255,255,255,0.6)`), texte/icônes **violet** `#b98cff`,
  survol `rgba(185,140,255,0.18)`, accent fort `#8b5cf6`. Coins arrondis 15 px (barre), 22 px (dock), 20 px (fenêtres).
- Mode sombre partout, couleur d'accent Windows violette, curseur **Bibata Modern Classic** (version Windows),
  fond d'écran : génère-le avec `linux/setup/wallpaper.py` du repo (Python + Pillow).

## Composants

1. **Barre du haut en îlots flottants** (remplace l'affichage barre des tâches en haut) :
   4 « pilules » séparées, avec un petit espace autour de l'écran :
   - gauche : bureaux virtuels + **lecteur média** (+ un îlot **Discord** juste à droite, voir 7) (titre — artiste ; au clic : pochette, playlist si dispo,
     ⏮ ⏯ ⏭ et **volume de Spotify seul**) ;
   - centre : date + heure ;
   - droite 1 : **utilisation Claude** (voir 4) ;
   - droite 2 : icônes système (réseau, son, batterie, notifications).
   Piste : YASB ou Zebar (CSS complet → border-radius, box-shadow). Masque la barre des tâches native si besoin.

2. **Dock vertical à gauche**, même style que la barre, applis épinglées, indicateur d'applis ouvertes,
   **bouton recherche en haut**. Piste : Seelen UI, ou mod Windhawk / dock tiers. Les fenêtres maximisées
   ne doivent pas passer dessous ni sous la barre (zone de travail réduite).

3. **Recherche d'applis** sur `Win+F` (ou le plus proche possible), fenêtre centrée sur l'écran principal,
   tolérante aux fautes de frappe, ignorant les accents, qui apprend les applis les plus lancées.
   Piste : Flow Launcher / PowerToys Command Palette stylés, ou recompiler `zsearch` (Rust) du repo
   pour qu'il indexe les raccourcis du menu Démarrer (`.lnk`) et brancher une petite UI dessus.

4. **Widget d'utilisation Claude** : lit le jeton dans `%USERPROFILE%\.claude\.credentials.json`
   (`claudeAiOauth.accessToken`, ne jamais le copier ailleurs), appelle
   `GET https://api.anthropic.com/api/oauth/usage` avec les en-têtes
   `Authorization: Bearer <token>` et `anthropic-beta: oauth-2025-04-20`,
   affiche `five_hour.utilization` et `seven_day.utilization` (mini-jauge + « 18% · 3% ») ;
   au clic : deux jauges dégradées violettes (rose/rouge au-delà de 50 / 80 %) avec l'heure de réinitialisation.
   Rafraîchi toutes les 5 min. Si le jeton est expiré : « lance claude ».

5. **Sélecteur de terminaux** sur `Win+Espace` (désactive le changement de disposition clavier si je n'en ai
   qu'une) : liste de toutes mes fenêtres de terminal (Windows Terminal, PowerShell, cmd, terminaux des IDE
   si possible), aperçu, la plus récente en premier, ↑↓ / Entrée / chiffres 1-9 / filtre par titre,
   `Ctrl+Entrée` = nouveau terminal, et **la fenêtre choisie doit vraiment prendre le focus**.
   Piste : AutoHotkey v2 (GUI stylée) ou PowerToys.

6. **Roue Kando** (Kando existe nativement sur Windows) : ouverture quand je **maintiens le clic molette
   ~180 ms** (un clic molette court doit garder son comportement normal : coller, nouvel onglet…).
   Piste : AutoHotkey v2 qui détecte le maintien et demande à Kando d'afficher le menu le plus vite possible
   (Kando a un serveur IPC WebSocket local : port dans `%APPDATA%\kando\ipc-info.json`,
   message `{"type":"show-menu","name":"Applications"}` ; sinon un raccourci clavier assigné au menu).
   Contenu, avec les vraies icônes des applis et le même thème noir/violet :
   - Terminal, Explorateur, Chrome, Opera, Discord, VS Code, IntelliJ, Minecraft (Prism Launcher) ;
   - **GitHub intelligent** : détecte le projet de la fenêtre active (titre VS Code / JetBrains / terminal →
     dossier → remote `origin`) ; ouvre la **PR ouverte** de la branche courante (`gh pr view`), sinon le repo,
     sinon github.com ; dépôt privé → passer par `https://github.com/login?return_to=…`.
     Ne jamais injecter le titre de fenêtre dans une commande shell.
   - **Sous-menu Spotify** : Ouvrir, Lecture/Pause, Suivant, Précédent, Titres likés (`spotify:collection:tracks`),
     Titre au hasard, et mes playlists (ma playlist « Salle » : `spotify:playlist:5uepSSDKwGT43EdIia1JFb`).
     Sur Windows, `start spotify:playlist:…` suffit pour lancer une playlist.
   - Les applis lancées depuis la roue s'ouvrent **sur l'écran où j'ai ouvert la roue**.

7. **Îlot Discord** (à droite du lecteur média dans la barre) : réutilise **`linux/home/bin/.local/bin/zdiscord`** du repo,
   un script Python sans dépendance qui marche tel quel sous Windows (RPC Discord via `\\.\pipe\discord-ipc-0`).
   - Configuration : je crée une app sur https://discord.com/developers/applications (OAuth2 → redirection
     `http://localhost`), puis `python zdiscord setup` (secret saisi au clavier) et `python zdiscord login`.
     Config/jetons dans `%APPDATA%\zdiscord\`, **jamais** dans le repo.
   - Barre : ma photo de profil ronde ; en vocal : nom du salon + avatars des membres (anneau violet quand
     quelqu'un parle, avatars en cache local dans `%LOCALAPPDATA%\zdiscord\avatars`), icônes micro/casque coupés.
   - Au clic : liste des membres, boutons **Micro**, **Casque**, **Quitter**, et sous-menu
     **Rejoindre un vocal** (salons occupés de mes serveurs, avec qui est dedans).
   - Interface du script : `python zdiscord daemon` écrit une ligne JSON par changement
     (`{"type":"state","in_voice":…,"channel":{…},"members":[{name,avatar_file,muted,deafened,speaking}],"self":{mute,deaf},"me":{…}}`)
     et lit des commandes JSON sur stdin (`{"cmd":"mute"}`, `"deaf"`, `"disconnect"`, `{"cmd":"join","id":"…"}`,
     `{"cmd":"channels"}` → `{"type":"channels","items":[…]}`). Commandes ponctuelles aussi :
     `zdiscord status | channels | mute | deaf | disconnect | join <id>`.

8. **Fenêtres** : coins arrondis (natif Windows 11), petit espace (~8 px) entre les fenêtres maximisées
   et la barre / le bas / la droite de l'écran principal si c'est faisable proprement.

9. **Terminal** : Windows Terminal avec un thème « Zecross Violet » (fond `#0d0a14` légèrement transparent,
   texte `#ece4ff`, curseur `#b98cff`, sélection `#8b5cf6`) et un prompt sur deux lignes :
   `╭─ utilisateur • chemin ⎇ branche` / `╰─❯` (flèche rose si la dernière commande a échoué).
   Piste : Oh My Posh avec un thème perso, ou Starship.

## Livrables

- Le repo avec `install.ps1`, `restaurer.ps1`, toutes les configs, et un `README.md` en français
  (ce que fait chaque composant, raccourcis, comment désinstaller).
- Un récapitulatif final : ce qui est en place, ce qui diffère de Linux et pourquoi, ce qui reste à faire.
