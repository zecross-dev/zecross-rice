//! zwheel — ouvre un menu (Kando) quand on MAINTIENT le clic molette.
//!
//! Un clic molette court garde son comportement normal (coller, nouvel onglet…).
//!
//! Principe (X11) :
//!   1. grab passif synchrone du bouton 2 sur la racine : à chaque appui, le
//!      serveur « gèle » la souris et nous donne l'événement ;
//!   2. SyncPointer : le serveur nous livre le relâchement dès qu'il arrive ;
//!   3. relâché avant HOLD_MS  -> on rend la souris et on REJOUE le clic via
//!      XTest (le clic rejoué est ignoré par nous et arrive tel quel à l'appli) ;
//!      toujours enfoncé après  -> on libère la souris et on lance la commande.
//!
//! Ouverture rapide : avec --kando-menu, zwheel garde une connexion WebSocket
//! ouverte vers le serveur IPC de Kando (port lu dans ~/.config/kando/ipc-info.json)
//! et envoie {"type":"show-menu"} : pas de nouveau processus Electron à lancer.
//! La commande n'est utilisée qu'en secours si Kando ne répond pas.
//!
//! Wayland (evdev) : pas de grab possible côté serveur graphique, donc on lit les
//! souris directement dans /dev/input, on les prend en exclusivité (EVIOCGRAB) et
//! on réémet tout via une souris virtuelle (uinput), sauf le maintien du clic
//! molette. Droits nécessaires : lecture des /dev/input/event* des souris et
//! écriture dans /dev/uinput (règle udev « uaccess », voir linux/install.sh).
//! Si zwheel s'arrête, le noyau rend aussitôt la souris (le grab meurt avec lui).
//!
//! Usage : zwheel [--hold MS] [--kando-menu NOM] [--backend x11|evdev] [--] <commande de secours> [args…]
//!   ex.   zwheel --hold 180 --kando-menu Applications -- kando --menu Applications

mod evdev_backend;

use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::xproto::{
    Allow, ButtonIndex, ConnectionExt as _, EventMask, GrabMode, ModMask, BUTTON_PRESS_EVENT,
    BUTTON_RELEASE_EVENT,
};
use x11rb::protocol::Event;

const MIDDLE: u32 = 2;

/// Client IPC Kando (WebSocket local, connexion persistante).
pub(crate) struct KandoIpc {
    menu: String,
    port: u16,
    sock: Option<tungstenite::WebSocket<TcpStream>>,
}

impl KandoIpc {
    fn read_port() -> Option<u16> {
        let home = std::env::var("HOME").ok()?;
        let text = std::fs::read_to_string(format!("{home}/.config/kando/ipc-info.json")).ok()?;
        let i = text.find("\"port\"")?;
        let rest = &text[i + 6..];
        let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }

    fn connect(&mut self, port: u16) -> bool {
        self.sock = None;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return false };
        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
        match tungstenite::client(format!("ws://127.0.0.1:{port}/"), stream) {
            Ok((ws, _)) => {
                self.sock = Some(ws);
                self.port = port;
                true
            }
            Err(_) => false,
        }
    }

    /// Demande à Kando d'afficher le menu. false si Kando est injoignable.
    fn show(&mut self) -> bool {
        let msg = format!("{{\"type\":\"show-menu\",\"name\":\"{}\"}}", self.menu.replace('\\', "\\\\").replace('"', "\\\""));
        for _ in 0..2 {
            let Some(port) = Self::read_port() else { return false };
            // Kando a redémarré (nouveau port) ou pas encore connecté : on (re)connecte
            if (self.sock.is_none() || port != self.port) && !self.connect(port) {
                return false;
            }
            if let Some(ws) = self.sock.as_mut() {
                if ws.send(tungstenite::Message::text(msg.clone())).is_ok() {
                    return true;
                }
            }
            self.sock = None; // connexion morte : on réessaie une fois
        }
        false
    }
}

struct Args {
    hold_ms: u64,
    kando_menu: Option<String>,
    backend: String,
    cmd: Vec<String>,
}

fn parse_args() -> Args {
    let mut hold = 250u64;
    let mut kando_menu = None;
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland");
    let mut backend = if wayland { "evdev" } else { "x11" }.to_string();
    let mut cmd = Vec::new();
    let mut args = std::env::args().skip(1).peekable();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--hold" => hold = args.next().and_then(|v| v.parse().ok()).unwrap_or(hold),
            "--kando-menu" => kando_menu = args.next(),
            "--backend" => backend = args.next().unwrap_or(backend),
            "--" => {
                cmd.extend(args.by_ref());
                break;
            }
            _ => cmd.push(a),
        }
    }
    if cmd.is_empty() {
        cmd = vec!["kando".into(), "--menu".into(), "Applications".into()];
    }
    // « … kando --menu X » en commande de secours : on passe automatiquement par l'IPC
    if kando_menu.is_none() && cmd.len() >= 3 && cmd[0].ends_with("kando") && cmd[1] == "--menu" {
        kando_menu = Some(cmd[2].clone());
    }
    Args { hold_ms: hold, kando_menu, backend, cmd }
}

fn launch(cmd: &[String]) {
    let res = Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match res {
        // on récupère le processus en tâche de fond pour éviter les zombies
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => eprintln!("zwheel: impossible de lancer {:?}: {e}", cmd),
    }
}

/// Ouvre le menu : IPC Kando si possible, sinon la commande de secours.
pub(crate) fn trigger(kando: &mut Option<KandoIpc>, cmd: &[String]) {
    let via_ipc = kando.as_mut().is_some_and(|k| k.show());
    if !via_ipc {
        launch(cmd);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    let mut kando = args.kando_menu.clone().map(|menu| KandoIpc { menu, port: 0, sock: None });
    if let Some(k) = kando.as_mut() {
        if let Some(port) = KandoIpc::read_port() {
            k.connect(port); // connexion anticipée pour que le premier menu soit instantané
        }
    }
    match args.backend.as_str() {
        "evdev" => evdev_backend::run(args.hold_ms, kando, args.cmd),
        _ => run_x11(args.hold_ms, kando, args.cmd),
    }
}

fn run_x11(hold_ms: u64, mut kando: Option<KandoIpc>, cmd: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let hold = Duration::from_millis(hold_ms);

    let (conn, screen_num) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen_num].root;

    // grab passif synchrone du clic molette, toutes combinaisons de modificateurs
    conn.grab_button(
        false,
        root,
        EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE,
        GrabMode::SYNC,
        GrabMode::ASYNC,
        x11rb::NONE,
        x11rb::NONE,
        ButtonIndex::M2,
        ModMask::ANY,
    )?
    .check()
    .map_err(|e| format!("le clic molette est déjà pris par un autre programme: {e:?}"))?;
    conn.flush()?;
    eprintln!("zwheel: prêt (maintien {hold_ms} ms -> {:?})", cmd);

    let mut ignore_next = false;
    loop {
        let ev = conn.wait_for_event()?;
        let Event::ButtonPress(press) = ev else { continue };
        if u32::from(press.detail) != MIDDLE || ignore_next {
            // clic rejoué par nous-mêmes (ou autre bouton) : on le laisse passer tel quel
            ignore_next = false;
            conn.allow_events(Allow::REPLAY_POINTER, press.time)?;
            conn.flush()?;
            continue;
        }

        // la souris est gelée : on demande au serveur de nous livrer le prochain
        // appui/relâchement, puis on attend soit le relâchement, soit le délai
        conn.allow_events(Allow::SYNC_POINTER, press.time)?;
        conn.flush()?;
        let start = Instant::now();
        let mut released = false;
        while start.elapsed() < hold {
            match conn.poll_for_event()? {
                Some(Event::ButtonRelease(r)) if u32::from(r.detail) == MIDDLE => {
                    released = true;
                    break;
                }
                Some(Event::ButtonPress(_)) | Some(Event::ButtonRelease(_)) => {
                    conn.allow_events(Allow::SYNC_POINTER, x11rb::CURRENT_TIME)?;
                    conn.flush()?;
                }
                Some(_) => {}
                None => std::thread::sleep(Duration::from_millis(3)),
            }
        }

        // dans les deux cas on rend la souris
        conn.allow_events(Allow::ASYNC_POINTER, x11rb::CURRENT_TIME)?;
        conn.ungrab_pointer(x11rb::CURRENT_TIME)?;
        if released {
            // clic court : on le rejoue pour l'application sous le curseur
            ignore_next = true;
            conn.xtest_fake_input(BUTTON_PRESS_EVENT, MIDDLE as u8, 0, x11rb::NONE, 0, 0, 0)?;
            conn.xtest_fake_input(BUTTON_RELEASE_EVENT, MIDDLE as u8, 0, x11rb::NONE, 0, 0, 0)?;
            conn.flush()?;
        } else {
            conn.flush()?;
            trigger(&mut kando, &cmd);
        }
    }
}
