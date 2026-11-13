//! zsearch — moteur de recherche d'applications pour le dock perso.
//!
//! Usage :
//!   zsearch query "<texte>" [--limit N]   -> une ligne JSON par résultat
//!   zsearch record <desktop-id>           -> mémorise un lancement (frécence)
//!
//! Algorithme de score (par champ, puis pondéré) :
//!   exact > préfixe du nom > début de mot > sous-chaîne > sous-séquence floue
//!   (style fzf : bonus consécutifs / début de mot, pénalité de trous)
//!   > tolérance aux fautes (Damerau-Levenshtein sur les préfixes de mots).
//! Chaque mot de la requête doit matcher (ET logique). Les applis souvent
//! lancées récemment remontent (frécence avec demi-vie de 14 jours).

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
struct App {
    id: String,
    path: PathBuf,
    name: String,
    generic: String,
    keywords: String,
    comment: String,
    exec: String,
    icon: String,
}

// ---------------------------------------------------------------- utilitaires

fn normalize(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' | 'ì' => 'i',
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            'ÿ' => 'y',
            _ => c,
        })
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn home() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| "/".into()))
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

// ------------------------------------------------------- lecture des .desktop

fn data_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut dirs = vec![env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| h.join(".local/share"))];
    let sys = env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(sys.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    dirs.push(h.join(".local/share/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop"));
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, base, out);
        } else if p.extension().is_some_and(|x| x == "desktop") {
            if let Ok(rel) = p.strip_prefix(base) {
                let id = rel.to_string_lossy().replace('/', "-");
                out.push((id, p));
            }
        }
    }
}

fn locale_candidates() -> Vec<String> {
    let raw = env::var("LC_MESSAGES")
        .or_else(|_| env::var("LC_ALL"))
        .or_else(|_| env::var("LANG"))
        .unwrap_or_default();
    let base = raw.split(['.', '@']).next().unwrap_or("").to_string();
    let mut v = Vec::new();
    if !base.is_empty() && base != "C" && base != "POSIX" {
        v.push(base.clone());
        if let Some(lang) = base.split('_').next() {
            if lang != base {
                v.push(lang.to_string());
            }
        }
    }
    v
}

fn current_desktops() -> Vec<String> {
    env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_desktop(id: String, path: PathBuf, locales: &[String], desktops: &[String], tr: &mut Translator) -> Option<App> {
    let text = fs::read_to_string(&path).ok()?;
    let mut in_entry = false;
    let mut kv: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            kv.entry(k.trim().to_string()).or_insert_with(|| v.trim().to_string());
        }
    }
    let get = |k: &str| kv.get(k).cloned().unwrap_or_default();
    let domain = kv
        .get("X-GNOME-Gettext-Domain")
        .or_else(|| kv.get("X-Ubuntu-Gettext-Domain"))
        .cloned()
        .unwrap_or_default();
    let mut localized = |k: &str| {
        for l in locales {
            if let Some(v) = kv.get(&format!("{k}[{l}]")) {
                return v.clone();
            }
        }
        let raw = get(k);
        tr.tr(&domain, &raw).unwrap_or(raw)
    };

    if get("Type") != "Application" || get("NoDisplay") == "true" || get("Hidden") == "true" {
        return None;
    }
    let only = get("OnlyShowIn");
    if !only.is_empty() && !only.split(';').any(|d| desktops.iter().any(|c| c == d)) {
        return None;
    }
    let not = get("NotShowIn");
    if not.split(';').any(|d| !d.is_empty() && desktops.iter().any(|c| c == d)) {
        return None;
    }
    let name = localized("Name");
    if name.is_empty() {
        return None;
    }
    let generic = localized("GenericName");
    let keywords = format!("{};{}", localized("Keywords"), get("Keywords")).replace(';', " ");
    let comment = localized("Comment");
    let exec_bin = get("Exec")
        .split_whitespace()
        .find(|t| !t.contains('='))
        .map(|t| t.rsplit('/').next().unwrap_or(t).to_string())
        .unwrap_or_default();

    Some(App {
        id,
        path,
        generic,
        keywords,
        comment,
        exec: exec_bin,
        icon: get("Icon"),
        name,
    })
}

fn load_apps() -> Vec<App> {
    let locales = locale_candidates();
    let desktops = current_desktops();
    let mut tr = Translator::new(locales.clone());
    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for d in data_dirs() {
        let base = d.join("applications");
        let mut files = Vec::new();
        walk(&base, &base, &mut files);
        for (id, path) in files {
            // Le premier dossier XDG gagne (surcharge utilisateur > système).
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(app) = parse_desktop(id, path, &locales, &desktops, &mut tr) {
                apps.push(app);
            }
        }
    }
    apps
}


// ------------------------------------------------- traductions gettext (.mo)

/// Charge un catalogue .mo (format GNU gettext) en table msgid -> msgstr.
fn load_mo(path: &Path) -> Option<HashMap<String, String>> {
    let b = fs::read(path).ok()?;
    if b.len() < 20 {
        return None;
    }
    let le = match u32::from_le_bytes(b[0..4].try_into().ok()?) {
        0x950412de => true,
        0xde120495 => false,
        _ => return None,
    };
    let rd = |o: usize| -> Option<usize> {
        let a: [u8; 4] = b.get(o..o + 4)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) } as usize)
    };
    let (n, orig, trans) = (rd(8)?, rd(12)?, rd(16)?);
    let mut map = HashMap::with_capacity(n);
    for i in 0..n {
        let (ol, oo) = (rd(orig + i * 8)?, rd(orig + i * 8 + 4)?);
        let (tl, to) = (rd(trans + i * 8)?, rd(trans + i * 8 + 4)?);
        let k = String::from_utf8_lossy(b.get(oo..oo + ol)?).into_owned();
        let v = String::from_utf8_lossy(b.get(to..to + tl)?).into_owned();
        // les pluriels sont séparés par \0 : on garde la première forme
        let v = v.split('\0').next().unwrap_or("").to_string();
        if !k.is_empty() && !v.is_empty() {
            map.insert(k, v);
        }
    }
    Some(map)
}

struct Translator {
    locales: Vec<String>,
    cache: HashMap<String, Option<HashMap<String, String>>>,
}

impl Translator {
    fn new(locales: Vec<String>) -> Self {
        Self { locales, cache: HashMap::new() }
    }

    fn tr(&mut self, domain: &str, msgid: &str) -> Option<String> {
        if domain.is_empty() || msgid.is_empty() {
            return None;
        }
        let locales = self.locales.clone();
        let cat = self.cache.entry(domain.to_string()).or_insert_with(|| {
            for l in &locales {
                for root in ["/usr/share/locale-langpack", "/usr/share/locale"] {
                    let p = PathBuf::from(format!("{root}/{l}/LC_MESSAGES/{domain}.mo"));
                    if let Some(m) = load_mo(&p) {
                        return Some(m);
                    }
                }
            }
            None
        });
        cat.as_ref()?.get(msgid).cloned()
    }
}

// ------------------------------------------------------------ algorithme flou

/// Score de sous-séquence façon fzf : chaque caractère de `q` doit apparaître
/// dans l'ordre dans `t`. On cherche la fenêtre la plus serrée puis on note.
fn subsequence_score(q: &[char], t: &[char]) -> Option<i32> {
    if q.is_empty() || q.len() > t.len() {
        return None;
    }
    // Passe avant : trouver la fin du match le plus tôt.
    let mut qi = 0;
    let mut end = 0;
    for (i, &c) in t.iter().enumerate() {
        if c == q[qi] {
            qi += 1;
            if qi == q.len() {
                end = i;
                break;
            }
        }
    }
    if qi < q.len() {
        return None;
    }
    // Passe arrière : resserrer le début.
    let mut qi = q.len();
    let mut start = end;
    for i in (0..=end).rev() {
        if t[i] == q[qi - 1] {
            qi -= 1;
            if qi == 0 {
                start = i;
                break;
            }
        }
    }
    // Notation sur la fenêtre [start, end].
    let is_boundary = |i: usize| i == 0 || !t[i - 1].is_alphanumeric();
    let mut score = 0i32;
    let mut qi = 0;
    let mut prev: Option<usize> = None;
    for i in start..=end {
        if qi < q.len() && t[i] == q[qi] {
            score += 16;
            if is_boundary(i) {
                score += 24;
            }
            if let Some(p) = prev {
                if p + 1 == i {
                    score += 18; // caractères consécutifs
                } else {
                    score -= 3 + (i - p - 1).min(10) as i32; // trou
                }
            }
            if i == 0 && qi == 0 {
                score += 30;
            }
            prev = Some(i);
            qi += 1;
        }
    }
    score -= start.min(15) as i32;
    Some(score)
}

/// Distance de Damerau-Levenshtein (transpositions adjacentes incluses).
fn damerau(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

fn words(t: &str) -> impl Iterator<Item = &str> {
    t.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty())
}

/// Score d'un mot de requête contre un texte (déjà normalisés).
fn token_score(tok: &str, text: &str) -> Option<i32> {
    if text.is_empty() {
        return None;
    }
    if text == tok {
        return Some(1000);
    }
    if text.starts_with(tok) {
        return Some(900 - (text.len() as i32 - tok.len() as i32).min(100));
    }
    if words(text).any(|w| w.starts_with(tok)) {
        return Some(780);
    }
    if let Some(pos) = text.find(tok) {
        return Some(650 - (pos as i32).min(100));
    }
    let qc: Vec<char> = tok.chars().collect();
    let tc: Vec<char> = text.chars().collect();
    let mut best: Option<i32> = subsequence_score(&qc, &tc)
        .filter(|&s| s > (qc.len() as i32) * 8) // trop dispersé = non pertinent
        .map(|s| 300 + s.min(250));
    // Tolérance aux fautes de frappe.
    if qc.len() >= 3 {
        let max_d = if qc.len() >= 7 { 2 } else { 1 };
        for w in words(text) {
            let wc: Vec<char> = w.chars().collect();
            // compare au préfixe du mot de même longueur (frappe en cours) et au mot entier
            let pref: Vec<char> = wc.iter().take(qc.len()).copied().collect();
            let d = damerau(&qc, &pref).min(damerau(&qc, &wc));
            if d <= max_d {
                let s = 520 - 120 * d as i32;
                best = Some(best.map_or(s, |b| b.max(s)));
            }
        }
    }
    best
}

fn app_score(app: &App, tokens: &[String]) -> Option<i32> {
    let fields: [(String, f32); 5] = [
        (normalize(&app.name), 1.0),
        (normalize(&app.generic), 0.7),
        (normalize(&app.exec), 0.65),
        (normalize(&app.keywords), 0.6),
        (normalize(&app.comment), 0.3),
    ];
    let mut total = 0i32;
    for tok in tokens {
        let best = fields
            .iter()
            .filter_map(|(text, w)| token_score(tok, text).map(|s| (s as f32 * w) as i32))
            .max()?; // ET logique : chaque mot doit matcher
        total += best;
    }
    // Requête complète == nom complet : gros bonus.
    let full = tokens.join(" ");
    if fields[0].0 == full {
        total += 400;
    }
    Some(total)
}

// ------------------------------------------------------------------ frécence

fn history_path() -> PathBuf {
    env::var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".cache"))
        .join("zsearch/history")
}

fn load_history() -> HashMap<String, (u32, u64)> {
    let mut h = HashMap::new();
    if let Ok(t) = fs::read_to_string(history_path()) {
        for line in t.lines() {
            let mut it = line.split('\t');
            if let (Some(id), Some(c), Some(ts)) = (it.next(), it.next(), it.next()) {
                if let (Ok(c), Ok(ts)) = (c.parse(), ts.parse()) {
                    h.insert(id.to_string(), (c, ts));
                }
            }
        }
    }
    h
}

fn frecency_bonus(entry: Option<&(u32, u64)>, now: u64) -> i32 {
    let Some(&(count, ts)) = entry else { return 0 };
    let age_days = now.saturating_sub(ts) as f64 / 86400.0;
    let decay = 0.5f64.powf(age_days / 14.0);
    ((count.min(60) as f64) * 8.0 * decay + 40.0 * decay) as i32
}

fn record(id: &str) -> std::io::Result<()> {
    let mut h = load_history();
    let e = h.entry(id.to_string()).or_insert((0, 0));
    e.0 += 1;
    e.1 = now_secs();
    let p = history_path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut out = String::new();
    for (id, (c, ts)) in &h {
        out.push_str(&format!("{id}\t{c}\t{ts}\n"));
    }
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, out)?;
    fs::rename(tmp, p)
}

// ---------------------------------------------------------------------- main

fn query(q: &str, limit: usize) {
    let apps = load_apps();
    let hist = load_history();
    let now = now_secs();
    let qn = normalize(q.trim());
    let tokens: Vec<String> = words(&qn).map(|s| s.to_string()).collect();

    let mut scored: Vec<(i32, &App)> = if tokens.is_empty() {
        // Requête vide : applis les plus utilisées.
        apps.iter()
            .map(|a| (frecency_bonus(hist.get(&a.id), now), a))
            .filter(|(s, _)| *s > 0)
            .collect()
    } else {
        apps.iter()
            .filter_map(|a| app_score(a, &tokens).map(|s| (s + frecency_bonus(hist.get(&a.id), now), a)))
            .collect()
    };
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));

    // Coupe le bruit : on ne garde que ce qui est à >= 45 % du meilleur score.
    let cutoff = if tokens.is_empty() { 0 } else { scored.first().map_or(0, |s| s.0 * 45 / 100) };
    let mut names = HashSet::new();
    for (score, a) in scored
        .into_iter()
        .filter(|(s, _)| *s >= cutoff)
        .filter(|(_, a)| names.insert(a.name.clone()))
        .take(limit)
    {
        println!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"comment\":\"{}\",\"icon\":\"{}\",\"path\":\"{}\",\"score\":{}}}",
            json_escape(&a.id),
            json_escape(&a.name),
            json_escape(&a.comment),
            json_escape(&a.icon),
            json_escape(&a.path.to_string_lossy()),
            score
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("query") => {
            let mut limit = 8;
            let mut text = String::new();
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--limit" {
                    limit = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(limit);
                    i += 2;
                } else {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(&args[i]);
                    i += 1;
                }
            }
            query(&text, limit);
        }
        Some("record") if args.len() > 1 => {
            if let Err(e) = record(&args[1]) {
                eprintln!("zsearch: impossible d'écrire l'historique: {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: zsearch query <texte> [--limit N] | zsearch record <desktop-id>");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_beats_prefix_beats_fuzzy() {
        let e = token_score("firefox", "firefox").unwrap();
        let p = token_score("fire", "firefox").unwrap();
        let f = token_score("ffx", "firefox").unwrap();
        assert!(e > p && p > f);
    }

    #[test]
    fn typo_tolerance() {
        assert!(token_score("fierfox", "firefox").is_some()); // transposition
        assert!(token_score("termnal", "terminal").is_some()); // lettre manquante
        assert!(token_score("xyzq", "terminal").is_none());
    }

    #[test]
    fn accents_ignored() {
        assert_eq!(normalize("Paramètres"), "parametres");
        assert!(token_score("parametre", &normalize("Paramètres")).is_some());
    }

    #[test]
    fn word_start() {
        assert!(token_score("code", "visual studio code").unwrap() >= 780);
    }
}
