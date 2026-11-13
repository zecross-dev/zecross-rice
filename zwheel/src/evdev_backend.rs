//! Mode Wayland : lecture directe des souris (evdev) + souris virtuelle (uinput).
//!
//! Pour chaque souris (bouton molette + axes relatifs, pas de pavé tactile) :
//!   - on crée une souris virtuelle qui a les mêmes boutons / axes ;
//!   - on prend la vraie en exclusivité (EVIOCGRAB) ;
//!   - on recopie chaque paquet d'événements, sauf le clic molette :
//!       relâché avant HOLD_MS -> on rejoue appui + relâchement (clic normal),
//!       toujours enfoncé après -> on ouvre le menu et on avale le relâchement.
//! Les souris branchées plus tard sont prises en compte (scan toutes les 2 s).

use std::collections::HashSet;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use evdev::raw_stream::RawDevice;
use evdev::uinput::VirtualDevice;
use evdev::{EventType, InputEvent, KeyCode, RelativeAxisCode, SynchronizationCode};

use crate::{trigger, KandoIpc};

const VIRTUAL_PREFIX: &str = "zwheel ";

fn is_mouse(d: &RawDevice) -> bool {
    let name = d.name().unwrap_or("");
    !name.starts_with(VIRTUAL_PREFIX)
        && d.supported_keys().is_some_and(|k| k.contains(KeyCode::BTN_MIDDLE))
        && d.supported_relative_axes().is_some_and(|r| r.contains(RelativeAxisCode::REL_X))
        && d.supported_absolute_axes().is_none()
}

fn key(code: KeyCode, value: i32) -> InputEvent {
    InputEvent::new(EventType::KEY.0, code.code(), value)
}

/// Attend que la donnée arrive (ou le délai). Some(true) = données, Some(false) = délai écoulé.
fn wait_readable(fd: i32, timeout: Option<Duration>) -> std::io::Result<bool> {
    let ms = timeout.map_or(-1, |t| t.as_millis().min(i32::MAX as u128) as i32);
    let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    loop {
        let r = unsafe { libc::poll(&mut pfd, 1, ms) };
        if r < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if r == 0 {
            return Ok(false);
        }
        if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(std::io::Error::other("souris débranchée"));
        }
        return Ok(true);
    }
}

fn serve(path: &PathBuf, hold: Duration, kando: &Mutex<Option<KandoIpc>>, cmd: &[String]) -> std::io::Result<()> {
    let mut dev = RawDevice::open(path)?;
    let name = dev.name().unwrap_or("souris").to_string();

    // souris virtuelle identique (créée AVANT le grab : en cas d'échec la vraie reste libre)
    let vname = format!("{VIRTUAL_PREFIX}{name}");
    let mut b = VirtualDevice::builder()?.name(&vname).input_id(dev.input_id());
    if let Some(k) = dev.supported_keys() {
        b = b.with_keys(k)?;
    }
    if let Some(r) = dev.supported_relative_axes() {
        b = b.with_relative_axes(r)?;
    }
    if let Some(m) = dev.misc_properties() {
        b = b.with_msc(m)?;
    }
    b = b.with_properties(dev.properties())?;
    let mut virt = b.build()?;

    // ne pas prendre la souris pendant qu'un bouton est enfoncé (il resterait « collé »)
    for _ in 0..200 {
        if dev.get_key_state().map(|s| s.iter().next().is_none()).unwrap_or(true) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    dev.grab()?;
    eprintln!("zwheel: {name} ({}) prise en charge", path.display());

    let fd = dev.as_raw_fd();
    let mut batch: Vec<InputEvent> = Vec::new();
    let mut pressed_at: Option<Instant> = None; // molette enfoncée, décision en attente
    let mut swallow_release = false;

    loop {
        if let Some(t) = pressed_at {
            if t.elapsed() >= hold {
                pressed_at = None;
                swallow_release = true;
                trigger(&mut kando.lock().unwrap(), cmd);
            }
        }
        let timeout = pressed_at.map(|t| hold.saturating_sub(t.elapsed()));
        if !wait_readable(fd, timeout)? {
            continue; // délai écoulé : traité en haut de boucle
        }
        let events: Vec<InputEvent> = dev.fetch_events()?.collect();
        for e in events {
            let ty = e.event_type();
            if ty == EventType::SYNCHRONIZATION {
                if e.code() == SynchronizationCode::SYN_REPORT.0 && !batch.is_empty() {
                    virt.emit(&batch)?;
                    batch.clear();
                }
                continue;
            }
            if ty == EventType::KEY && e.code() == KeyCode::BTN_MIDDLE.code() {
                match e.value() {
                    1 => pressed_at = Some(Instant::now()),
                    0 => {
                        if pressed_at.take().is_some() {
                            // clic court : on le rejoue tel quel
                            if !batch.is_empty() {
                                virt.emit(&batch)?;
                                batch.clear();
                            }
                            virt.emit(&[key(KeyCode::BTN_MIDDLE, 1)])?;
                            virt.emit(&[key(KeyCode::BTN_MIDDLE, 0)])?;
                        } else if swallow_release {
                            swallow_release = false;
                        } else {
                            batch.push(e);
                        }
                    }
                    _ => {}
                }
                continue;
            }
            batch.push(e);
        }
    }
}

pub fn run(hold_ms: u64, kando: Option<KandoIpc>, cmd: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let hold = Duration::from_millis(hold_ms);
    let kando = Arc::new(Mutex::new(kando));
    let cmd = Arc::new(cmd);
    let active: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut warned = false;
    eprintln!("zwheel: mode evdev (maintien {hold_ms} ms)");

    loop {
        let mut denied = false;
        if let Ok(entries) = std::fs::read_dir("/dev/input") {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("event")) {
                    continue;
                }
                if active.lock().unwrap().contains(&path) {
                    continue;
                }
                let dev = match RawDevice::open(&path) {
                    Ok(d) => d,
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            denied = true;
                        }
                        continue;
                    }
                };
                if !is_mouse(&dev) {
                    continue;
                }
                drop(dev);
                active.lock().unwrap().insert(path.clone());
                let (kando, cmd, active) = (kando.clone(), cmd.clone(), active.clone());
                std::thread::spawn(move || {
                    if let Err(e) = serve(&path, hold, &kando, &cmd) {
                        eprintln!("zwheel: {} : {e}", path.display());
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            // pas de droit sur /dev/uinput : on réessaiera au prochain scan
                            std::thread::sleep(Duration::from_secs(10));
                        }
                    }
                    active.lock().unwrap().remove(&path);
                });
            }
        }
        if denied && !warned && active.lock().unwrap().is_empty() {
            eprintln!("zwheel: accès refusé à /dev/input — installe la règle udev (voir install.sh)");
            warned = true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
