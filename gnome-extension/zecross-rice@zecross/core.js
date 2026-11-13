// Zecross Rice — barre flottante, widget d'utilisation Claude, recherche d'applis dans le dock.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const DOCK_UUID = 'ubuntu-dock@ubuntu.com';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_SECONDS = 300;
const BAR_WIDTH = 260; // largeur logique des jauges du menu Claude
const MINI_WIDTH = 34; // largeur logique de la mini-jauge dans la barre

const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

function severityClass(pct) {
    if (pct >= 80)
        return 'zr-high';
    if (pct >= 50)
        return 'zr-mid';
    return 'zr-low';
}

function formatRelative(iso) {
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    if (!dt)
        return '';
    const secs = Math.max(0, dt.to_unix() - GLib.DateTime.new_now_utc().to_unix());
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `réinitialisation dans ${h} h ${String(m).padStart(2, '0')}` : `réinitialisation dans ${m} min`;
}

function formatAbsolute(iso) {
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? `réinitialisation ${dt.to_local().format('%a %d %b à %H:%M')}` : '';
}


function openOnPrimary(dialog) {
    const ok = dialog.open();
    if (dialog._monitorConstraint)
        dialog._monitorConstraint.index = Main.layoutManager.primaryIndex;
    return ok;
}

// --------------------------------------------------------------- Claude usage

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false, can_focus: false, style_class: 'zr-usage-row'});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'zr-usage-box'});

        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({text: title, style_class: 'zr-usage-title', x_expand: true}));
        this._pct = new St.Label({text: '—', style_class: 'zr-usage-pct'});
        head.add_child(this._pct);

        this._track = new St.Widget({style_class: 'zr-track'}); // FixedLayout : remplissage collé à gauche
        this._fill = new St.Widget({style_class: 'zr-fill zr-low', x: 0, y: 0});
        this._track.add_child(this._fill);

        this._sub = new St.Label({text: '', style_class: 'zr-usage-sub'});

        box.add_child(head);
        box.add_child(this._track);
        box.add_child(this._sub);
        this.add_child(box);
    }

    update(pct, sub) {
        const p = Math.max(0, Math.min(100, pct));
        this._pct.text = `${Math.round(p)} %`;
        this._fill.width = Math.round((BAR_WIDTH * p) / 100 * scale());
        this._fill.visible = p > 0;
        this._fill.style_class = `zr-fill ${severityClass(p)}`;
        this._sub.text = sub;
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Claude Usage');
        this.add_style_class_name('zr-claude-button');

        const box = new St.BoxLayout({style_class: 'zr-claude-box', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Label({text: '✳', style_class: 'zr-claude-glyph', y_align: Clutter.ActorAlign.CENTER}));
        this._miniTrack = new St.Widget({
            style_class: 'zr-mini-track',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._miniFill = new St.Widget({style_class: 'zr-mini-fill zr-low', x: 0, y: 0});
        this._miniTrack.add_child(this._miniFill);
        box.add_child(this._miniTrack);
        this._label = new St.Label({text: '…', style_class: 'zr-claude-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('zr-claude-menu');
        const header = new PopupMenu.PopupMenuItem('Utilisation Claude', {reactive: false, can_focus: false});
        header.add_style_class_name('zr-usage-header');
        this.menu.addMenuItem(header);
        this._sessionRow = new UsageRow('Session · 5 heures');
        this._weeklyRow = new UsageRow('Hebdomadaire · 7 jours');
        this.menu.addMenuItem(this._sessionRow);
        this.menu.addMenuItem(this._weeklyRow);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.add_style_class_name('zr-usage-status');
        this.menu.addMenuItem(this._status);
        this.menu.addAction('Actualiser', () => this.refresh());

        this._http = new Soup.Session({timeout: 15, user_agent: 'zecross-rice-gnome'});
        this._cancellable = new Gio.Cancellable();
        this._lastOk = 0;

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open && Date.now() - this._lastOk > 60_000)
                this.refresh();
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.refresh();
    }

    _setStatus(text) {
        this._status.label.text = text;
    }

    _readToken() {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
        const [, bytes] = GLib.file_get_contents(path);
        const creds = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
        if (!creds?.accessToken)
            throw new Error('pas de jeton');
        return creds;
    }

    async refresh() {
        let creds;
        try {
            creds = this._readToken();
        } catch (_e) {
            this._label.text = '?';
            this._setStatus('Non connecté — lance « claude » une fois');
            return;
        }
        if (creds.expiresAt && creds.expiresAt < Date.now()) {
            this._label.text = '?';
            this._setStatus('Jeton expiré — lance « claude » pour le rafraîchir');
            return;
        }
        try {
            const msg = Soup.Message.new('GET', USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${creds.accessToken}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            msg.request_headers.append('Accept', 'application/json');
            const bytes = await this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (msg.get_status() !== 200)
                throw new Error(`HTTP ${msg.get_status()}`);
            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            this._apply(data);
            this._lastOk = Date.now();
            this._setStatus(`Mis à jour à ${GLib.DateTime.new_now_local().format('%H:%M')}`);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setStatus(`Erreur : ${e.message}`);
        }
    }

    _apply(data) {
        const five = data.five_hour ?? {};
        const week = data.seven_day ?? {};
        const p5 = five.utilization ?? 0;
        const p7 = week.utilization ?? 0;
        this._sessionRow.update(p5, five.resets_at ? formatRelative(five.resets_at) : '');
        this._weeklyRow.update(p7, week.resets_at ? formatAbsolute(week.resets_at) : '');
        this._label.text = `${Math.round(p5)}% · ${Math.round(p7)}%`;
        this._miniFill.width = Math.round((MINI_WIDTH * Math.min(100, p5)) / 100 * scale());
        this._miniFill.visible = p5 > 0;
        this._miniFill.style_class = `zr-mini-fill ${severityClass(p5)}`;
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancellable.cancel();
        this._http.abort();
        super.destroy();
    }
});

// --------------------------------------------------------------- App launcher

const Launcher = GObject.registerClass(
class Launcher extends ModalDialog.ModalDialog {
    _init(bin) {
        super._init({styleClass: 'zr-launcher', destroyOnClose: true});
        this._bin = bin;
        this._seq = 0;
        this._items = [];
        this._sel = 0;
        this._debounce = 0;

        this._entry = new St.Entry({
            style_class: 'zr-launcher-entry',
            hint_text: 'Rechercher une application…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'zr-launcher-entry-icon'}));
        this._results = new St.BoxLayout({vertical: true, style_class: 'zr-launcher-results'});
        this._hint = new St.Label({style_class: 'zr-launcher-hint', text: ''});

        this.contentLayout.add_child(this._entry);
        this.contentLayout.add_child(this._results);
        this.contentLayout.add_child(this._hint);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._schedule());
        text.connect('activate', () => this._launch(this._items[this._sel]));
        text.connect('key-press-event', (_a, ev) => this._onKey(ev));
        this.connect('button-press-event', (_a, ev) => this._onClickOutside(ev));

        this.connect('destroy', () => this._cleanup());
        this.setInitialKeyFocus(this._entry);
        this._search('');
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab) {
            this._select(this._sel + 1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_ISO_Left_Tab) {
            this._select(this._sel - 1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onClickOutside(ev) {
        const [x, y] = ev.get_coords();
        const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (!this.dialogLayout.contains(target)) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _schedule() {
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            this._debounce = 0;
            this._search(this._entry.text);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _search(query) {
        const seq = ++this._seq;
        let items = [];
        try {
            const proc = Gio.Subprocess.new([this._bin, 'query', query, '--limit', '8'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [out] = await proc.communicate_utf8_async(null, null);
            items = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
        } catch (e) {
            if (seq === this._seq)
                this._hint.text = `zsearch introuvable (${this._bin})`;
            return;
        }
        if (seq !== this._seq || !this._results)
            return;
        this._render(items, query);
    }

    _render(items, query) {
        this._results.destroy_all_children();
        this._items = items;
        this._buttons = [];
        const appSys = Shell.AppSystem.get_default();
        items.forEach((item, i) => {
            const app = appSys.lookup_app(item.id);
            const btn = new St.Button({style_class: 'zr-result', can_focus: false, track_hover: true, x_expand: true});
            const row = new St.BoxLayout({style_class: 'zr-result-row', x_expand: true});
            const icon = app
                ? app.create_icon_texture(36)
                : new St.Icon({icon_name: item.icon || 'application-x-executable', icon_size: 36});
            row.add_child(icon);
            const texts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            texts.add_child(new St.Label({text: item.name, style_class: 'zr-result-name'}));
            if (item.comment)
                texts.add_child(new St.Label({text: item.comment, style_class: 'zr-result-comment'}));
            row.add_child(texts);
            btn.set_child(row);
            btn.connect('notify::hover', () => btn.hover && this._select(i));
            btn.connect('clicked', () => this._launch(item));
            this._results.add_child(btn);
            this._buttons.push(btn);
        });
        if (items.length === 0)
            this._hint.text = query.trim() ? 'Aucune application trouvée' : 'Tape le nom d\'une appli…  (↑↓ pour naviguer, Entrée pour lancer)';
        else
            this._hint.text = '';
        this._hint.visible = this._hint.text !== '';
        this._select(0);
    }

    _select(i) {
        if (!this._buttons?.length)
            return;
        const n = this._buttons.length;
        this._sel = ((i % n) + n) % n;
        this._buttons.forEach((b, j) => {
            if (j === this._sel)
                b.add_style_pseudo_class('selected');
            else
                b.remove_style_pseudo_class('selected');
        });
    }

    _launch(item) {
        if (!item)
            return;
        const app = Shell.AppSystem.get_default().lookup_app(item.id);
        try {
            if (app) {
                app.activate();
            } else {
                Gio.DesktopAppInfo.new_from_filename(item.path)
                    ?.launch([], global.create_app_launch_context(0, -1));
            }
            Gio.Subprocess.new([this._bin, 'record', item.id], Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'zecross-rice: lancement impossible');
        }
        this.close();
    }

    _cleanup() {
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._debounce = 0;
        this._results = null;
    }
});


// ------------------------------------------------------ Sélecteur de terminaux

const TERMINAL_HINTS = ['terminal', 'kitty', 'alacritty', 'wezterm', 'foot', 'tilix', 'terminator',
    'xterm', 'konsole', 'ptyxis', 'ghostty', 'warp', 'urxvt', 'blackbox', 'console'];

function isTerminal(win) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    const cats = app?.get_app_info?.()?.get_categories?.() ?? '';
    if (cats.split(';').includes('TerminalEmulator'))
        return true;
    const ids = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id(), app?.get_id()]
        .filter(Boolean).map(x => x.toLowerCase());
    return ids.some(id => TERMINAL_HINTS.some(h => id.includes(h)));
}

function terminalWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .filter(w => !w.skip_taskbar && isTerminal(w));
}


function openNewTerminal() {
    const appSys = Shell.AppSystem.get_default();
    for (const id of ['org.gnome.Terminal.desktop', 'org.gnome.Ptyxis.desktop', 'kitty.desktop',
        'Alacritty.desktop', 'org.wezfurlong.wezterm.desktop', 'com.mitchellh.ghostty.desktop']) {
        const app = appSys.lookup_app(id);
        if (app) {
            app.open_new_window(-1);
            return;
        }
    }
    try {
        GLib.spawn_command_line_async('x-terminal-emulator');
    } catch (e) {
        logError(e, 'zecross-rice: aucun terminal trouvé');
    }
}

const THUMB_W = 220;
const THUMB_H = 130;

const TerminalSwitcher = GObject.registerClass(
class TerminalSwitcher extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'zr-launcher zr-switcher', destroyOnClose: true});
        this._all = terminalWindows();
        this._sel = 0;

        const head = new St.BoxLayout({style_class: 'zr-switcher-head'});
        head.add_child(new St.Icon({icon_name: 'utilities-terminal-symbolic', style_class: 'zr-switcher-head-icon'}));
        head.add_child(new St.Label({text: `Terminaux actifs (${this._all.length})`, style_class: 'zr-switcher-title', y_align: Clutter.ActorAlign.CENTER}));
        this.contentLayout.add_child(head);

        this._entry = new St.Entry({
            style_class: 'zr-launcher-entry',
            hint_text: 'Filtrer…  (↑↓ / Super+Espace, Entrée, 1-9, Ctrl+Entrée = nouveau)',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'zr-launcher-entry-icon'}));
        this.contentLayout.add_child(this._entry);

        const scroll = new St.ScrollView({style_class: 'zr-switcher-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        this._list = new St.BoxLayout({vertical: true, style_class: 'zr-launcher-results'});
        if (scroll.add_actor)
            scroll.add_actor(this._list);
        else
            scroll.set_child(this._list);
        this._scroll = scroll;
        this.contentLayout.add_child(scroll);

        this._hint = new St.Label({style_class: 'zr-launcher-hint', text: ''});
        this.contentLayout.add_child(this._hint);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._render());
        text.connect('activate', () => this._activate(this._shown[this._sel]));
        text.connect('key-press-event', (_a, ev) => this._onKey(ev));
        this.connect('button-press-event', (_a, ev) => {
            const [x, y] = ev.get_coords();
            if (!this.dialogLayout.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y))) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => this._onClosed());
        this.setInitialKeyFocus(this._entry);
        this._render();
        // la fenêtre active est en tête : présélectionner la précédente, comme Alt+Tab
        if (this._shown.length > 1 && this._shown[0] !== 'NEW' && this._shown[0].has_focus())
            this._select(1);
    }

    cycle() {
        this._select(this._sel + 1);
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        const sup = (ev.get_state() & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)) !== 0;
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const ctrl = (ev.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter)) {
            this._activate('NEW');
            return Clutter.EVENT_STOP;
        }
        if (sup && sym === Clutter.KEY_space) {
            this.cycle();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab) {
            this._select(this._sel + 1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_ISO_Left_Tab) {
            this._select(this._sel - 1);
            return Clutter.EVENT_STOP;
        }
        if (this._entry.text === '' && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            this._activate(this._shown[sym - Clutter.KEY_1]);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _render() {
        const q = this._entry.text.trim().toLowerCase();
        this._shown = this._all.filter(w => !w.is_override_redirect() && (w.get_title() ?? '').toLowerCase().includes(q));
        this._list.destroy_all_children();
        this._rows = [];
        const wsMgr = global.workspace_manager;
        this._shown.forEach((win, i) => {
            const btn = new St.Button({style_class: 'zr-result zr-term', can_focus: false, track_hover: true, x_expand: true});
            const row = new St.BoxLayout({style_class: 'zr-result-row', x_expand: true});

            const thumb = new St.Widget({style_class: 'zr-term-thumb', width: THUMB_W, height: THUMB_H,
                layout_manager: new Clutter.BinLayout()});
            const actor = win.get_compositor_private();
            if (actor) {
                const f = win.get_frame_rect();
                const k = Math.min(THUMB_W / f.width, THUMB_H / f.height);
                const clone = new Clutter.Clone({source: actor, x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER});
                const holder = new St.Widget({width: Math.round(f.width * k), height: Math.round(f.height * k),
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, clip_to_allocation: true});
                // décale le clone pour ignorer les ombres client (buffer > frame)
                const b = win.get_buffer_rect();
                clone.set_scale(k, k);
                clone.set_position(Math.round((b.x - f.x) * k), Math.round((b.y - f.y) * k));
                holder.add_child(clone);
                thumb.add_child(holder);
            }
            row.add_child(thumb);

            const texts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true, style_class: 'zr-term-texts'});
            const num = i < 9 ? `${i + 1}  ` : '';
            texts.add_child(new St.Label({text: `${num}${win.get_title() ?? 'Terminal'}`, style_class: 'zr-result-name'}));
            const ws = win.get_workspace();
            const parts = [];
            if (ws && wsMgr.n_workspaces > 1)
                parts.push(`Bureau ${ws.index() + 1}`);
            if (win.minimized)
                parts.push('réduit');
            if (win.has_focus())
                parts.push('actif');
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app)
                parts.unshift(app.get_name());
            texts.add_child(new St.Label({text: parts.join(' · '), style_class: 'zr-result-comment'}));
            row.add_child(texts);

            btn.set_child(row);
            btn.connect('notify::hover', () => btn.hover && this._select(i));
            btn.connect('clicked', () => this._activate(win));
            this._list.add_child(btn);
            this._rows.push(btn);
        });
        const noMatch = this._shown.length === 0;
        const newBtn = new St.Button({style_class: 'zr-result zr-term zr-term-new', can_focus: false, track_hover: true, x_expand: true});
        const newRow = new St.BoxLayout({style_class: 'zr-result-row', x_expand: true});
        const plus = new St.Widget({style_class: 'zr-term-thumb zr-term-plus', width: THUMB_W, height: 56,
            layout_manager: new Clutter.BinLayout()});
        plus.add_child(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'zr-term-plus-icon',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        newRow.add_child(plus);
        const newTexts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true, style_class: 'zr-term-texts'});
        newTexts.add_child(new St.Label({text: 'Nouveau terminal', style_class: 'zr-result-name'}));
        newTexts.add_child(new St.Label({text: 'Ctrl+Entrée', style_class: 'zr-result-comment'}));
        newRow.add_child(newTexts);
        newBtn.set_child(newRow);
        const newIdx = this._rows.length;
        newBtn.connect('notify::hover', () => newBtn.hover && this._select(newIdx));
        newBtn.connect('clicked', () => this._activate('NEW'));
        this._list.add_child(newBtn);
        this._rows.push(newBtn);
        this._shown.push('NEW');

        this._hint.text = this._all.length === 0 ? 'Aucun terminal ouvert'
            : noMatch ? 'Aucun terminal ne correspond' : '';
        this._hint.visible = this._hint.text !== '';
        this._select(0);
    }

    _select(i) {
        if (!this._rows?.length)
            return;
        const n = this._rows.length;
        this._sel = ((i % n) + n) % n;
        this._rows.forEach((b, j) => {
            if (j === this._sel)
                b.add_style_pseudo_class('selected');
            else
                b.remove_style_pseudo_class('selected');
        });
        const sel = this._rows[this._sel];
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.()?.get_adjustment();
        if (adj && sel.allocation) {
            const {y1, y2} = sel.allocation;
            if (y1 < adj.value)
                adj.value = y1;
            else if (y2 > adj.value + adj.page_size)
                adj.value = y2 - adj.page_size;
        }
    }

    _activate(win) {
        if (!win || this._chosen)
            return;
        // On agit APRÈS la fermeture complète : en se fermant, la boîte de dialogue
        // rend le focus à l'ancienne fenêtre, ce qui annulerait notre choix.
        this._chosen = win;
        this.close();
    }

    _onClosed() {
        const win = this._chosen;
        if (!win)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (win === 'NEW') {
                openNewTerminal();
            } else if (win.get_compositor_private()) {
                const ws = win.get_workspace();
                if (ws && ws !== global.workspace_manager.get_active_workspace())
                    ws.activate_with_focus(win, global.get_current_time());
                else
                    Main.activateWindow(win, global.get_current_time());
            }
            return GLib.SOURCE_REMOVE;
        });
    }
});

// -------------------------------------------------------------- Dock button

class DockSearch {
    constructor(openLauncher) {
        this._open = openLauncher;
        this._buttons = new Set();
        this._unclipped = new Set();
        this._dm = null;
        this._dmSignal = 0;
        this._extSignal = Main.extensionManager.connect('extension-state-changed', (_m, ext) => {
            if (ext.uuid === DOCK_UUID)
                this._hook().catch(logError);
        });
        this._hook().catch(logError);
    }

    async _hook() {
        const ext = Main.extensionManager.lookup(DOCK_UUID);
        if (!ext || ext.state !== 1 /* ACTIVE */)
            return;
        // Même URI que celle chargée par GNOME Shell => même instance de module.
        const mod = await import(`${ext.dir.get_uri()}/extension.js`);
        const dm = mod.dockManager;
        if (!dm || this._destroyed)
            return;
        if (dm !== this._dm) {
            if (this._dm && this._dmSignal)
                this._dm.disconnect(this._dmSignal);
            this._dm = dm;
            this._dmSignal = dm.connect('docks-ready', () => this._addButtons());
        }
        this._addButtons();
    }

    _unclip(dock) {
        const box = dock._box;
        if (!box || box._zrUnclipped)
            return;
        box._zrUnclipped = true;
        box.set_clip = () => {}; // le dock est fixe : pas besoin de découpe, le halo peut déborder
        box.remove_clip();
        this._unclipped.add(box);
    }

    _addButtons() {
        for (const dock of this._dm?._allDocks ?? [])
            this._unclip(dock);
        for (const dock of this._dm?._allDocks ?? []) {
            const dash = dock.dash;
            if (!dash?._dashContainer || dash._zrSearch)
                continue;
            const icon = new St.Icon({icon_name: 'system-search-symbolic', style_class: 'zr-dock-search-icon'});
            const btn = new St.Button({
                style_class: 'zr-dock-search',
                can_focus: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: icon,
            });
            const resize = () => {
                icon.icon_size = Math.round((dash.iconSize ?? 48) * 0.55);
            };
            resize();
            const sizeId = dash.connect('icon-size-changed', resize);
            btn.connect('clicked', () => this._open());
            btn.connect('destroy', () => {
                this._buttons.delete(btn);
                if (dash._zrSearch === btn) {
                    delete dash._zrSearch;
                    try {
                        dash.disconnect(sizeId);
                    } catch (_e) {}
                }
            });
            dash._dashContainer.insert_child_at_index(btn, 0);
            dash._zrSearch = btn;
            this._buttons.add(btn);
        }
    }

    destroy() {
        this._destroyed = true;
        Main.extensionManager.disconnect(this._extSignal);
        if (this._dm && this._dmSignal)
            this._dm.disconnect(this._dmSignal);
        for (const b of [...this._buttons])
            b.destroy();
        this._buttons.clear();
        for (const box of this._unclipped) {
            try {
                delete box.set_clip;
                delete box._zrUnclipped;
                box.queue_relayout();
            } catch (e) {
                // boîte du dock déjà détruite (dock recréé entre-temps)
            }
        }
        this._unclipped.clear();
        this._dm = null;
    }
}


// ------------------------------------------------- Coins arrondis fenêtres

const CORNER_RADIUS = 20;
const ROUND_DECL = `
uniform vec4 bounds;   // rectangle de la fenêtre (normalisé dans la texture)
uniform vec2 tex_size; // taille de la texture en pixels
uniform float radius;
`;
const ROUND_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * tex_size;
vec4 b = bounds * vec4(tex_size, tex_size);
if (p.x >= b.x && p.x <= b.z && p.y >= b.y && p.y <= b.w) {
    vec2 c = clamp(p, b.xy + radius, b.zw - radius);
    float d = distance(p, c);
    cogl_color_out *= 1.0 - smoothstep(radius - 0.8, radius + 0.8, d);
}
`;

const RoundedCornersEffect = GObject.registerClass(
class RoundedCornersEffect extends Shell.GLSLEffect {
    _init(win) {
        super._init();
        this._win = win;
        this._boundsLoc = this.get_uniform_location('bounds');
        this._sizeLoc = this.get_uniform_location('tex_size');
        this._radiusLoc = this.get_uniform_location('radius');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet((Shell.SnippetHook ?? Cogl.SnippetHook).FRAGMENT, ROUND_DECL, ROUND_CODE, false);
    }

    vfunc_paint_target(node, ctx) {
        const actor = this.get_actor();
        const [ok, pb] = actor ? actor.get_paint_box() : [false, null];
        if (ok) {
            // la texture de l'effet couvre la "paint box" de l'acteur (ombres incluses)
            const w = Math.max(1, pb.x2 - pb.x1);
            const h = Math.max(1, pb.y2 - pb.y1);
            const f = this._win.get_frame_rect();
            const ox = f.x - pb.x1;
            const oy = f.y - pb.y1;
            this.set_uniform_float(this._boundsLoc, 4, [ox / w, oy / h, (ox + f.width) / w, (oy + f.height) / h]);
            this.set_uniform_float(this._sizeLoc, 2, [w, h]);
            this.set_uniform_float(this._radiusLoc, 1, [CORNER_RADIUS * scale()]);
        }
        super.vfunc_paint_target(node, ctx);
    }
});

class WindowRounder {
    constructor() {
        this._windows = new Map(); // MetaWindow -> {effect, ids}
        this._createdId = global.display.connect('window-created', (_d, win) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._track(win);
                return GLib.SOURCE_REMOVE;
            });
        });
        // à chaque fenêtre affichée (couvre aussi le redémarrage du shell)
        this._mapId = global.window_manager.connect('map', (_wm, actor) => this._track(actor.meta_window));
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._scanId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
        this._scan();
    }

    _scan() {
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
    }

    _eligible(win) {
        const T = Meta.WindowType;
        if (![T.NORMAL, T.DIALOG, T.MODAL_DIALOG].includes(win.get_window_type()))
            return false;
        const wmClass = (win.get_wm_class() ?? '').toLowerCase();
        if (wmClass.includes('ding') || win.get_title?.() === 'Desktop Icons')
            return false;
        return true;
    }

    _track(win) {
        if (!win || this._windows.has(win) || !this._eligible(win))
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const effect = new RoundedCornersEffect(win);
        actor.add_effect_with_name('zr-rounded', effect);
        const update = () => {
            effect.enabled = !win.is_fullscreen();
        };
        update();
        const ids = [
            win.connect('notify::fullscreen', update),
            win.connect('unmanaged', () => this._untrack(win)),
        ];
        this._windows.set(win, {effect, actor, ids});
    }

    _untrack(win) {
        const data = this._windows.get(win);
        if (!data)
            return;
        data.ids.forEach(id => win.disconnect(id));
        try {
            data.actor.remove_effect(data.effect);
        } catch (_e) {}
        this._windows.delete(win);
    }

    destroy() {
        global.display.disconnect(this._createdId);
        global.window_manager.disconnect(this._mapId);
        if (this._scanId)
            GLib.source_remove(this._scanId);
        for (const win of [...this._windows.keys()])
            this._untrack(win);
    }
}

// --------------------------------------------- Espace bas pour maximisées

const BOTTOM_GAP = 8;
const RIGHT_GAP = 8;

// GNOME 50 a supprimé le paramètre affectsInputRegion (c'est `reactive` qui compte désormais)
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split('.')[0]);
function addGapChrome(actor) {
    const params = {affectsStruts: true, trackFullscreen: true};
    if (SHELL_MAJOR < 50)
        params.affectsInputRegion = false;
    Main.layoutManager.addChrome(actor, params);
}

class BottomGap {
    constructor() {
        this._actors = [];
        this._monId = Main.layoutManager.connect('monitors-changed', () => this._build());
        this._build();
    }

    _build() {
        this._clear();
        const m = Main.layoutManager.primaryMonitor;
        if (m) {
            const a = new St.Widget({
                reactive: false,
                x: m.x,
                y: m.y + m.height - BOTTOM_GAP,
                width: m.width,
                height: BOTTOM_GAP,
            });
            addGapChrome(a);
            this._actors.push(a);
            const r = new St.Widget({
                reactive: false,
                x: m.x + m.width - RIGHT_GAP,
                y: m.y,
                width: RIGHT_GAP,
                height: m.height,
            });
            addGapChrome(r);
            this._actors.push(r);
        }
    }

    _clear() {
        for (const a of this._actors) {
            Main.layoutManager.removeChrome(a);
            a.destroy();
        }
        this._actors = [];
    }

    destroy() {
        Main.layoutManager.disconnect(this._monId);
        this._clear();
    }
}


// ------------------------------------- Applis de la roue sur l'écran de la roue

const LAUNCH_WINDOW_MS = 20000; // délai max pour qu'une appli lancée ouvre sa fenêtre

class LaunchPlacer {
    constructor() {
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'zecross-launch']);
        GLib.mkdir_with_parents(dir, 0o700);
        this._file = Gio.File.new_for_path(`${dir}/launch.json`);
        this._pending = null;
        this._timeouts = new Set();
        this._dirMon = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._dirMonId = this._dirMon.connect('changed', (_m, file, other) => {
            if ((other ?? file)?.get_basename() === 'launch.json')
                this._readPending();
        });
        this._createdId = global.display.connect('window-created', (_d, win) => this._onNewWindow(win));
        this._focusId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (win && this._matches(win))
                this._place(win);
        });
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _readPending() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const d = JSON.parse(new TextDecoder().decode(bytes));
            if (d.x === null || d.y === null || Date.now() - d.t > 5000)
                return;
            const rect = new Mtk.Rectangle({x: d.x, y: d.y, width: 1, height: 1});
            this._pending = {
                id: d.id,
                monitor: global.display.get_monitor_index_for_rect(rect),
                since: Date.now(),
            };
            // appli déjà ouverte : sa fenêtre existante est activée, on la ramène
            this._later(400, () => {
                const win = global.display.focus_window;
                if (win && this._matches(win))
                    this._place(win);
            });
        } catch (_e) {}
    }

    _active() {
        if (this._pending && Date.now() - this._pending.since > LAUNCH_WINDOW_MS)
            this._pending = null;
        return this._pending;
    }

    _matches(win, allowUnknown = false) {
        const p = this._active();
        if (!p || win.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const id = app?.get_id() ?? '';
        if (id === p.id)
            return true;
        // appli mal reconnue par GNOME (AppImage…) : fenêtre neuve juste après le lancement
        return allowUnknown && (!id || id.startsWith('window:'));
    }

    _onNewWindow(win) {
        if (!this._active())
            return;
        // GNOME associe la fenêtre à son appli juste après sa création : on retente un peu
        let tries = 0;
        const check = () => {
            if (!this._active() || win.get_compositor_private() === null && tries > 0)
                return;
            if (this._matches(win, tries >= 3)) {
                this._place(win);
                return;
            }
            if (++tries < 6)
                this._later(150, check);
        };
        this._later(50, check);
    }

    _place(win) {
        const p = this._active();
        if (!p)
            return;
        if (p.monitor >= 0 && win.get_monitor() !== p.monitor)
            win.move_to_monitor(p.monitor);
        this._pending = null;
    }

    destroy() {
        global.display.disconnect(this._createdId);
        global.display.disconnect(this._focusId);
        this._dirMon.disconnect(this._dirMonId);
        this._dirMon.cancel();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }
}


// ------------------------------------------------------ Barre en îlots

// Chaque îlot est un fond « verre » posé derrière un groupe d'éléments de la barre,
// recalculé quand leur taille change (les zones GNOME, elles, font toute la largeur).
class PanelIslands {
    constructor() {
        this._islands = new Map();
        this._signals = [];
        this._childSignals = new Map();
        this._laterId = 0;
        const panel = Main.panel;
        this._boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        for (const name of ['left', 'discord', 'center', 'claude', 'system']) {
            const w = new St.Widget({style_class: `zr-island zr-island-${name}`, reactive: false, visible: false});
            Main.layoutManager.uiGroup.insert_child_below(w, Main.layoutManager.panelBox);
            this._islands.set(name, w);
        }
        const watch = (obj, sig) => this._signals.push([obj, obj.connect(sig, () => this._queue())]);
        watch(panel, 'notify::allocation');
        watch(Main.layoutManager.panelBox, 'notify::visible');
        watch(Main.layoutManager.panelBox, 'notify::allocation');
        watch(Main.overview, 'showing');
        watch(Main.overview, 'hidden');
        for (const box of this._boxes) {
            watch(box, 'notify::allocation');
            this._signals.push([box, box.connect('child-added', (_b, c) => this._watchChild(c))]);
            this._signals.push([box, box.connect('child-removed', (_b, c) => this._unwatchChild(c))]);
            box.get_children().forEach(c => this._watchChild(c));
        }
        this._queue();
    }

    _watchChild(c) {
        if (this._childSignals.has(c))
            return;
        this._childSignals.set(c, [
            c.connect('notify::allocation', () => this._queue()),
            c.connect('notify::visible', () => this._queue()),
        ]);
        this._queue();
    }

    _unwatchChild(c) {
        (this._childSignals.get(c) ?? []).forEach(id => c.disconnect(id));
        this._childSignals.delete(c);
        this._queue();
    }

    _queue() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _extents(children) {
        let x1 = Infinity, x2 = -Infinity;
        for (const c of children) {
            if (!c.visible || c.width === 0)
                continue;
            const r = c.get_transformed_extents();
            x1 = Math.min(x1, r.get_x());
            x2 = Math.max(x2, r.get_x() + r.get_width());
        }
        return x1 < x2 ? [x1, x2] : null;
    }

    _update() {
        const panel = Main.panel;
        const shown = Main.layoutManager.panelBox.visible && panel.visible;
        const claudeBtn = panel.statusArea['zr-claude'];
        const claude = claudeBtn?.container;
        const right = panel._rightBox.get_children();
        const discordBtn = panel.statusArea['zr-discord'];
        const groups = {
            left: panel._leftBox.get_children().filter(c => c !== discordBtn?.container),
            discord: discordBtn ? [discordBtn] : [],
            center: panel._centerBox.get_children(),
            // le bouton (sans sa marge) : la marge CSS crée l'espace entre les deux îlots de droite
            claude: claudeBtn ? [claudeBtn] : [],
            system: right.filter(c => c !== claude),
        };
        const pr = panel.get_transformed_extents();
        const pad = 4 * scale();
        for (const [name, w] of this._islands) {
            const ext = shown ? this._extents(groups[name]) : null;
            if (!ext) {
                w.hide();
                continue;
            }
            w.set_position(Math.round(ext[0] - pad), Math.round(pr.get_y()));
            w.set_size(Math.round(ext[1] - ext[0] + 2 * pad), Math.round(pr.get_height()));
            w.show();
        }
    }

    destroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._signals.forEach(([o, id]) => o.disconnect(id));
        for (const c of [...this._childSignals.keys()])
            this._unwatchChild(c);
        for (const w of this._islands.values())
            w.destroy();
        this._islands.clear();
    }
}

// --------------------------------------------------------- Widget Spotify

const SPOTIFY_BUS = 'org.mpris.MediaPlayer2.spotify';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';

const SpotifyIndicator = GObject.registerClass(
class SpotifyIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Spotify');
        this.add_style_class_name('zr-spotify-button');
        this.visible = false;

        const box = new St.BoxLayout({style_class: 'zr-spotify-box', y_align: Clutter.ActorAlign.CENTER});
        this._stateIcon = new St.Icon({icon_name: 'media-playback-start-symbolic', style_class: 'zr-spotify-state'});
        this._label = new St.Label({text: '', style_class: 'zr-spotify-label', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(new St.Icon({icon_name: 'spotify-client', style_class: 'zr-spotify-logo', fallback_icon_name: 'audio-x-generic-symbolic'}));
        box.add_child(this._stateIcon);
        box.add_child(this._label);
        this.add_child(box);

        // ---- menu
        this.menu.box.add_style_class_name('zr-spotify-menu');
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'zr-sp-col'});

        const top = new St.BoxLayout({style_class: 'zr-sp-top'});
        this._cover = new St.Icon({icon_size: 96, style_class: 'zr-sp-cover', icon_name: 'audio-x-generic-symbolic'});
        top.add_child(this._cover);
        const texts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true, style_class: 'zr-sp-texts'});
        this._title = new St.Label({style_class: 'zr-sp-title', text: ''});
        this._artist = new St.Label({style_class: 'zr-sp-artist', text: ''});
        this._context = new St.Label({style_class: 'zr-sp-context', text: ''});
        for (const l of [this._title, this._artist, this._context]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(l);
        }
        top.add_child(texts);
        col.add_child(top);

        const controls = new St.BoxLayout({style_class: 'zr-sp-controls', x_align: Clutter.ActorAlign.CENTER});
        const mk = (icon, method, cls = '') => {
            const b = new St.Button({style_class: `zr-sp-btn ${cls}`, can_focus: true,
                child: new St.Icon({icon_name: icon, style_class: 'zr-sp-btn-icon'})});
            b.connect('clicked', () => this._call(method));
            controls.add_child(b);
            return b;
        };
        mk('media-skip-backward-symbolic', 'Previous');
        this._playBtn = mk('media-playback-start-symbolic', 'PlayPause', 'zr-sp-play');
        mk('media-skip-forward-symbolic', 'Next');
        col.add_child(controls);

        const vol = new St.BoxLayout({style_class: 'zr-sp-volume'});
        this._volIcon = new St.Icon({icon_name: 'audio-volume-medium-symbolic', style_class: 'zr-sp-vol-icon'});
        this._slider = new Slider.Slider(0.5);
        this._slider.x_expand = true;
        this._slider.add_style_class_name('zr-sp-slider');
        this._volLabel = new St.Label({style_class: 'zr-sp-vol-label', text: '', y_align: Clutter.ActorAlign.CENTER});
        vol.add_child(this._volIcon);
        vol.add_child(this._slider);
        vol.add_child(this._volLabel);
        col.add_child(vol);

        item.add_child(col);
        this.menu.addMenuItem(item);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Ouvrir Spotify', () => this._raise());

        // ---- volume (flux audio de Spotify, sinon volume général)
        this._mixer = getMixerControl();
        this._sliderId = this._slider.connect('notify::value', () => this._setVolume());
        this._mixerIds = [
            this._mixer.connect('stream-added', () => this._syncVolume()),
            this._mixer.connect('stream-removed', () => this._syncVolume()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._syncVolume();
                this._update();
            }
        });

        // ---- MPRIS
        this._proxy = null;
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, SPOTIFY_BUS, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(), () => this._disconnect());
    }

    _connect() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            SPOTIFY_BUS, MPRIS_PATH, MPRIS_PLAYER, null, (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    return;
                }
                this._propsId = this._proxy.connect('g-properties-changed', () => this._update());
                this._update();
            });
    }

    _disconnect() {
        if (this._proxy && this._propsId)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
        this._propsId = 0;
        this.visible = false;
        this.menu.close();
    }

    _call(method) {
        this._proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _raise() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES, null,
            SPOTIFY_BUS, MPRIS_PATH, 'org.mpris.MediaPlayer2', null, (_o, res) => {
                try {
                    Gio.DBusProxy.new_for_bus_finish(res).call('Raise', null, Gio.DBusCallFlags.NONE, -1, null, null);
                } catch (_e) {}
            });
    }

    _readContext() {
        try {
            const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'zecross-launch', 'spotify-context.json']);
            const [, bytes] = GLib.file_get_contents(path);
            const c = JSON.parse(new TextDecoder().decode(bytes));
            if (Date.now() / 1000 - c.t < 12 * 3600)
                return c.name;
        } catch (_e) {}
        return null;
    }

    _update() {
        if (!this._proxy)
            return;
        const md = this._proxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const status = this._proxy.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';
        const title = md['xesam:title'] ?? '';
        const artist = (md['xesam:artist'] ?? []).join(', ');
        this.visible = title !== '';
        const playing = status === 'Playing';
        const icon = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._stateIcon.icon_name = playing ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._playBtn.child.icon_name = icon;
        this._label.text = artist ? `${title} — ${artist}` : title;
        this._title.text = title;
        this._artist.text = artist;
        const ctx = this._readContext();
        this._context.text = ctx ? `dans « ${ctx} »` : (md['xesam:album'] ? `album « ${md['xesam:album']} »` : '');
        const art = md['mpris:artUrl'];
        if (art && art !== this._artUrl) {
            this._artUrl = art;
            this._cover.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(art)});
        }
    }

    _spotifyStream() {
        return this._mixer.get_sink_inputs().find(s => {
            const ids = [s.get_application_id?.(), s.get_name?.(), s.get_description?.()];
            return ids.some(x => (x ?? '').toLowerCase().includes('spotify'));
        }) ?? null;
    }

    _syncVolume() {
        const stream = this._spotifyStream() ?? this._mixer.get_default_sink();
        this._stream = stream;
        if (!stream)
            return;
        const v = Math.min(1, stream.volume / this._mixer.get_vol_max_norm());
        this._slider.block_signal_handler(this._sliderId);
        this._slider.value = v;
        this._slider.unblock_signal_handler(this._sliderId);
        this._volLabel.text = `${Math.round(v * 100)} %`;
        this._volIcon.icon_name = v === 0 ? 'audio-volume-muted-symbolic'
            : v < 0.34 ? 'audio-volume-low-symbolic' : v < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
    }

    _setVolume() {
        const stream = this._stream ?? this._spotifyStream() ?? this._mixer.get_default_sink();
        if (!stream)
            return;
        const v = this._slider.value;
        stream.volume = v * this._mixer.get_vol_max_norm();
        if (stream.is_muted && v > 0)
            stream.change_is_muted(false);
        stream.push_volume();
        this._volLabel.text = `${Math.round(v * 100)} %`;
    }

    destroy() {
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._disconnect();
        super.destroy();
    }
});


// --------------------------------------------------------- Îlot Discord (vocaux)

// Le RPC Discord est géré par le script multiplateforme ~/.local/bin/zdiscord (mode « daemon ») :
// il écrit une ligne JSON par changement et lit nos commandes sur stdin.
const DiscordIndicator = GObject.registerClass(
class DiscordIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Discord');
        this.add_style_class_name('zr-discord-button');
        this._state = {ok: false, reason: 'offline'};

        const box = new St.BoxLayout({style_class: 'zr-discord-box', y_align: Clutter.ActorAlign.CENTER});
        this._logo = new St.Icon({icon_name: 'discord', fallback_icon_name: 'call-start-symbolic', style_class: 'zr-discord-logo'});
        this._me = new St.Bin({style_class: 'zr-dc-me', width: 22, height: 22, visible: false, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._logo);
        box.add_child(this._me);
        this._chanLabel = new St.Label({style_class: 'zr-discord-chan', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._chanLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._avatars = new St.BoxLayout({style_class: 'zr-discord-avatars', y_align: Clutter.ActorAlign.CENTER});
        this._selfIcons = new St.BoxLayout({style_class: 'zr-discord-self', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._chanLabel);
        box.add_child(this._avatars);
        box.add_child(this._selfIcons);
        this.add_child(box);

        // ---- menu
        this.menu.box.add_style_class_name('zr-discord-menu');
        this._header = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._header.add_style_class_name('zr-dc-header');
        this.menu.addMenuItem(this._header);
        this._membersSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._membersSection);

        const ctrlItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const ctrls = new St.BoxLayout({style_class: 'zr-dc-controls', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const mk = (icon, label, cmd, cls = '') => {
            const b = new St.Button({style_class: `zr-dc-btn ${cls}`, can_focus: true, toggle_mode: false});
            const inner = new St.BoxLayout({vertical: true, style_class: 'zr-dc-btn-box'});
            const ic = new St.Icon({icon_name: icon, style_class: 'zr-dc-btn-icon', x_align: Clutter.ActorAlign.CENTER});
            inner.add_child(ic);
            inner.add_child(new St.Label({text: label, style_class: 'zr-dc-btn-label', x_align: Clutter.ActorAlign.CENTER}));
            b.set_child(inner);
            b._icon = ic;
            b.connect('clicked', () => this._send({cmd}));
            ctrls.add_child(b);
            return b;
        };
        this._muteBtn = mk('microphone-sensitivity-high-symbolic', 'Micro', 'mute');
        this._deafBtn = mk('audio-headphones-symbolic', 'Casque', 'deaf');
        this._leaveBtn = mk('call-stop-symbolic', 'Quitter', 'disconnect', 'zr-dc-leave');
        ctrlItem.add_child(ctrls);
        this.menu.addMenuItem(ctrlItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._joinMenu = new PopupMenu.PopupSubMenuMenuItem('Vocaux des amis', true);
        this._expanded = new Set(); // salons dépliés (pseudos visibles)
        this._speakers = new Map(); // id -> [widgets à anneau]
        this._joinMenu.icon.icon_name = 'system-users-symbolic';
        this.menu.addMenuItem(this._joinMenu);
        this._joinMenu.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._loadChannels();
        });

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.add_style_class_name('zr-dc-status');
        this.menu.addMenuItem(this._status);

        this._bin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'zdiscord']);
        this._cancel = new Gio.Cancellable();
        this._spawn();
        this._render();
    }

    // ------------------------------------------------------------ démon
    _spawn() {
        if (this._destroyed)
            return;
        try {
            this._proc = Gio.Subprocess.new(['python3', this._bin, 'daemon'],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._state = {ok: false, reason: 'missing', message: `zdiscord introuvable (${this._bin})`};
            this._render();
            return;
        }
        this._stdin = this._proc.get_stdin_pipe();
        this._reader = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe()});
        this._readLine();
    }

    _readLine() {
        this._reader.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch (_e) {
                return; // annulé
            }
            if (line === null) {
                // démon arrêté : on relance dans 5 s
                this._respawnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    this._respawnId = 0;
                    this._spawn();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            try {
                this._onMessage(JSON.parse(line));
            } catch (e) {
                logError(e, 'zecross-rice: message zdiscord invalide');
            }
            this._readLine();
        });
    }

    _send(obj) {
        if (!this._stdin)
            return;
        const bytes = new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
        this._stdin.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null, (s, r) => {
            try {
                s.write_bytes_finish(r);
            } catch (_e) {}
        });
    }

    _onMessage(msg) {
        if (msg.type === 'state') {
            this._state = msg;
            this._render();
        } else if (msg.type === 'speaking') {
            this._setSpeaking(new Set(msg.ids ?? []));
        } else if (msg.type === 'channels') {
            this._fillChannels(msg);
        } else if (msg.type === 'error') {
            this._status.label.text = `Erreur : ${msg.message}`;
            this._status.visible = true;
        }
    }

    // ------------------------------------------------------------ rendu
    _avatar(m, size, cls) {
        const bin = new St.Bin({style_class: cls, width: size, height: size});
        if (m.avatar_file) {
            const uri = Gio.File.new_for_path(m.avatar_file).get_uri();
            bin.style = `background-image: url("${uri}"); background-size: cover;`;
        }
        if (m.speaking)
            bin.add_style_class_name('zr-speaking');
        if (m.id && cls !== 'zr-dc-face') {
            if (!this._speakers.has(m.id))
                this._speakers.set(m.id, []);
            this._speakers.get(m.id).push(bin);
        }
        return bin;
    }

    // seuls les anneaux changent quand quelqu'un parle : pas de reconstruction
    _setSpeaking(ids) {
        for (const [id, widgets] of this._speakers) {
            const on = ids.has(id);
            for (const w of widgets) {
                if (on)
                    w.add_style_class_name(w instanceof St.Label ? 'zr-speaking-text' : 'zr-speaking');
                else
                    w.remove_style_class_name(w instanceof St.Label ? 'zr-speaking-text' : 'zr-speaking');
            }
        }
    }

    _render() {
        const st = this._state;
        const inVoice = st.ok && st.in_voice;
        this._avatars.destroy_all_children();
        this._selfIcons.destroy_all_children();
        this._membersSection.removeAll();
        this._speakers.clear();
        this._status.visible = false;

        this._chanLabel.visible = inVoice;
        this._muteBtn.visible = this._deafBtn.visible = st.ok;
        this._leaveBtn.visible = inVoice;
        this._joinMenu.visible = st.ok;

        if (!st.ok) {
            this._me.visible = false;
            this._logo.visible = true;
            this._header.label.text = 'Discord';
            this._status.label.text = st.reason === 'setup'
                ? 'À configurer : « zdiscord setup » puis « zdiscord login »'
                : st.reason === 'missing' ? st.message : 'Discord n\'est pas lancé';
            this._status.visible = true;
            this.remove_style_class_name('zr-discord-live');
            return;
        }

        // ma photo de profil à la place du logo
        const me = st.me ?? {};
        if (me.avatar_file) {
            this._me.style = `background-image: url("${Gio.File.new_for_path(me.avatar_file).get_uri()}"); background-size: cover;`;
            this._me.visible = true;
            this._logo.visible = false;
        }
        const self = st.self ?? {};
        this._muteBtn._icon.icon_name = self.mute ? 'microphone-sensitivity-muted-symbolic' : 'microphone-sensitivity-high-symbolic';
        this._deafBtn._icon.icon_name = self.deaf ? 'audio-volume-muted-symbolic' : 'audio-headphones-symbolic';
        for (const [b, on] of [[this._muteBtn, self.mute], [this._deafBtn, self.deaf]]) {
            if (on)
                b.add_style_class_name('zr-dc-on');
            else
                b.remove_style_class_name('zr-dc-on');
        }
        if (self.mute)
            this._selfIcons.add_child(new St.Icon({icon_name: 'microphone-sensitivity-muted-symbolic', style_class: 'zr-discord-selficon'}));
        if (self.deaf)
            this._selfIcons.add_child(new St.Icon({icon_name: 'audio-volume-muted-symbolic', style_class: 'zr-discord-selficon'}));

        if (!inVoice) {
            this._header.label.text = 'Pas dans un vocal';
            this.remove_style_class_name('zr-discord-live');
            return;
        }
        this.add_style_class_name('zr-discord-live');
        const ch = st.channel;
        this._chanLabel.text = ch.name;
        this._header.label.text = ch.guild ? `🔊 ${ch.name} — ${ch.guild}` : `🔊 ${ch.name}`;

        const members = st.members ?? [];
        members.slice(0, 5).forEach(m => this._avatars.add_child(this._avatar(m, 20, 'zr-dc-avatar-sm')));
        if (members.length > 5)
            this._avatars.add_child(new St.Label({text: `+${members.length - 5}`, style_class: 'zr-discord-more', y_align: Clutter.ActorAlign.CENTER}));

        for (const m of members) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'zr-dc-member'});
            item.add_child(this._avatar(m, 28, 'zr-dc-avatar'));
            const name = new St.Label({text: m.name, style_class: 'zr-dc-name', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            if (m.speaking)
                name.add_style_class_name('zr-speaking-text');
            this._speakers.get(m.id)?.push(name);
            item.add_child(name);
            if (m.muted)
                item.add_child(new St.Icon({icon_name: 'microphone-sensitivity-muted-symbolic', style_class: 'zr-dc-state'}));
            if (m.deafened)
                item.add_child(new St.Icon({icon_name: 'audio-volume-muted-symbolic', style_class: 'zr-dc-state'}));
            this._membersSection.addMenuItem(item);
        }
    }

    _loadChannels() {
        // le démon renvoie aussitôt son dernier scan (pré-calculé), puis un scan frais
        if (this._joinMenu.menu.isEmpty()) {
            const loading = new PopupMenu.PopupMenuItem('Recherche…', {reactive: false});
            loading.add_style_class_name('zr-dc-status');
            this._joinMenu.menu.addMenuItem(loading);
        }
        this._send({cmd: 'channels'});
    }

    _fillChannels(msg) {
        this._joinMenu.menu.removeAll();
        const current = this._state.channel?.id;
        const list = (msg.items ?? []).filter(c => c.id !== current);
        const note = text => {
            const it = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            it.add_style_class_name('zr-dc-status');
            this._joinMenu.menu.addMenuItem(it);
        };
        if (list.length === 0)
            note(msg.friends_known === false ? 'Personne en vocal' : 'Aucun ami en vocal');
        for (const c of list)
            this._joinMenu.menu.addMenuItem(this._channelItem(c));
        if (msg.friends_known === false)
            note('Déplie un vocal et marque tes amis avec ☆');
    }

    _channelItem(c) {
        const friends = c.friends ?? [];
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'zr-dc-chan'});
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'zr-dc-chan-col'});

        // ligne repliée : pdp des amis + salon
        const head = new St.Button({style_class: 'zr-dc-chan-head', x_expand: true, can_focus: true, track_hover: true});
        const row = new St.BoxLayout({style_class: 'zr-dc-chan-row', x_expand: true});
        const faces = new St.BoxLayout({style_class: 'zr-dc-faces', y_align: Clutter.ActorAlign.CENTER});
        friends.slice(0, 6).forEach(f => faces.add_child(this._avatar(f, 26, 'zr-dc-face')));
        if (friends.length > 6)
            faces.add_child(new St.Label({text: `+${friends.length - 6}`, style_class: 'zr-discord-more', y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(faces);
        const txt = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'zr-dc-chan-txt'});
        const name = new St.Label({text: c.name, style_class: 'zr-dc-chan-name'});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        txt.add_child(name);
        const sub = new St.Label({text: c.others > 0 ? `${c.guild} · +${c.others}` : c.guild, style_class: 'zr-dc-chan-guild'});
        sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        txt.add_child(sub);
        row.add_child(txt);
        head.set_child(row);
        col.add_child(head);

        // dépliée : pdp + pseudo (amis d'abord) avec ☆ pour marquer un ami, puis « Rejoindre »
        const details = new St.BoxLayout({vertical: true, style_class: 'zr-dc-chan-details', visible: this._expanded.has(c.id)});
        for (const f of c.people ?? friends) {
            const line = new St.BoxLayout({style_class: 'zr-dc-friend'});
            line.add_child(this._avatar(f, 24, 'zr-dc-face'));
            const n = new St.Label({text: f.name, style_class: 'zr-dc-name', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            n.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            if (!f.friend && (c.people ?? []).some(p => p.friend))
                n.add_style_class_name('zr-dc-stranger');
            line.add_child(n);
            if (!f.me) {
                const star = new St.Button({style_class: 'zr-dc-star', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
                const paint = on => {
                    star.label = on ? '★' : '☆';
                    if (on)
                        star.add_style_class_name('zr-dc-star-on');
                    else
                        star.remove_style_class_name('zr-dc-star-on');
                };
                let on = !!f.friend;
                paint(on);
                star.connect('clicked', () => {
                    on = !on;
                    paint(on);
                    this._send({cmd: 'friend', id: f.id, name: f.name, on});
                });
                line.add_child(star);
            }
            details.add_child(line);
        }
        const join = new St.Button({label: 'Rejoindre', style_class: 'zr-dc-join-btn', can_focus: true, x_align: Clutter.ActorAlign.END});
        join.connect('clicked', () => {
            this._send({cmd: 'join', id: c.id});
            this.menu.close();
        });
        details.add_child(join);
        col.add_child(details);

        head.connect('clicked', () => {
            details.visible = !details.visible;
            if (details.visible)
                this._expanded.add(c.id);
            else
                this._expanded.delete(c.id);
        });
        item.add_child(col);
        return item;
    }

    destroy() {
        this._destroyed = true;
        this._cancel.cancel();
        if (this._respawnId)
            GLib.source_remove(this._respawnId);
        try {
            this._proc?.force_exit();
        } catch (_e) {}
        super.destroy();
    }
});

// ---------------------------------------------------------------- Extension

// Fenêtre active (hors Kando / bureau) écrite dans $XDG_RUNTIME_DIR/zecross-rice-focus.json
// pour zgithub : sous Wayland, xprop ne voit pas les fenêtres natives.
const FOCUS_IGNORED = new Set(['kando', 'gjs', 'gnome-shell', 'desktop icons', 'ding']);

class FocusTracker {
    constructor() {
        this._file = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'zecross-rice-focus.json']);
        this._win = null;
        this._titleId = 0;
        this._focusId = global.display.connect('notify::focus-window', () => this._onFocus());
        this._onFocus();
    }

    _onFocus() {
        const win = global.display.focus_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL || win.skip_taskbar)
            return;
        const ids = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()]
            .map(v => (v ?? '').toLowerCase());
        // la roue Kando (« menu.kando.Kando » sous Wayland) ne doit pas remplacer la vraie fenêtre
        if (ids.some(v => FOCUS_IGNORED.has(v) || v.includes('kando')))
            return;
        if (this._win !== win) {
            if (this._win && this._titleId)
                this._win.disconnect(this._titleId);
            this._win = win;
            this._titleId = win.connect('notify::title', () => this._write());
            win.connect('unmanaged', () => {
                if (this._win === win) {
                    this._win = null;
                    this._titleId = 0;
                }
            });
        }
        this._write();
    }

    _write() {
        const win = this._win;
        if (!win)
            return;
        const data = {
            wm_class: win.get_wm_class() ?? '',
            wm_class_instance: win.get_wm_class_instance() ?? '',
            app_id: win.get_gtk_application_id() ?? '',
            title: win.get_title() ?? '',
            pid: win.get_pid(),
            time: Date.now(),
        };
        try {
            GLib.file_set_contents(this._file, JSON.stringify(data));
        } catch (e) {
            console.warn(`zecross-rice: focus ${e}`);
        }
    }

    destroy() {
        global.display.disconnect(this._focusId);
        if (this._win && this._titleId)
            this._win.disconnect(this._titleId);
        this._win = null;
    }
}

// Demande de mise au premier plan ($XDG_RUNTIME_DIR/zecross-rice-raise.json, écrit par zgithub) :
// sous Wayland, un navigateur déjà ouvert ne peut pas se mettre devant tout seul.
class WindowRaiser {
    constructor() {
        this._path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'zecross-rice-raise.json']);
        this._mon = Gio.File.new_for_path(this._path).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monId = this._mon.connect('changed', () => this._onRequest());
        this._timer = 0;
        this._last = 0;
    }

    _onRequest() {
        let req;
        try {
            const [, bytes] = GLib.file_get_contents(this._path);
            req = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return;
        }
        const match = String(req.match ?? '').toLowerCase();
        if (!match || req.t === this._last || Date.now() - req.t > 5000)
            return;
        this._last = req.t;
        if (this._timer)
            GLib.source_remove(this._timer);
        let tries = 0;
        let done = 0;
        // on réessaie ~4 s (navigateur qui démarre), et on réactive une fois après l'ouverture de l'onglet
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            tries++;
            const win = this._find(match);
            if (win) {
                Main.activateWindow(win);
                done++;
            }
            if (done >= 2 || tries >= 16) {
                this._timer = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _find(match) {
        const wins = global.display.list_all_windows().filter(w => {
            if (w.get_window_type() !== Meta.WindowType.NORMAL)
                return false;
            return [w.get_wm_class(), w.get_wm_class_instance(), w.get_gtk_application_id()]
                .some(v => (v ?? '').toLowerCase().includes(match));
        });
        wins.sort((a, b) => b.get_user_time() - a.get_user_time());
        return wins[0] ?? null;
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._mon.disconnect(this._monId);
        this._mon.cancel();
    }
}

export default class ZecrossRiceCore {
    constructor(ext) {
        this._ext = ext;
    }

    enable() {
        this._bin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'zsearch']);
        this._settings = this._ext.getSettings();

        this._indicator = new ClaudeIndicator();
        Main.panel.addToStatusArea('zr-claude', this._indicator, 0, 'right');
        this._spotify = new SpotifyIndicator();
        Main.panel.addToStatusArea('zr-spotify', this._spotify, 1, 'left');
        this._discord = new DiscordIndicator();
        Main.panel.addToStatusArea('zr-discord', this._discord, 2, 'left');
        this._islands = new PanelIslands();

        this._dockSearch = new DockSearch(() => this.openLauncher());
        this._rounder = new WindowRounder();
        this._placer = new LaunchPlacer();
        this._bottomGap = new BottomGap();
        this._focus = new FocusTracker();
        this._raiser = new WindowRaiser();

        Main.wm.addKeybinding('open-launcher', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.openLauncher());
        Main.wm.addKeybinding('terminal-switcher', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.openSwitcher());
    }

    openLauncher() {
        if (this._launcher)
            return;
        if (Main.overview.visible)
            Main.overview.hide();
        this._launcher = new Launcher(this._bin);
        this._launcher.connect('destroy', () => {
            this._launcher = null;
        });
        openOnPrimary(this._launcher);
    }

    openSwitcher() {
        if (this._switcher) {
            this._switcher.cycle();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        this._switcher = new TerminalSwitcher();
        this._switcher.connect('destroy', () => {
            this._switcher = null;
        });
        openOnPrimary(this._switcher);
    }

    disable() {
        this._focus?.destroy();
        this._focus = null;
        this._raiser?.destroy();
        this._raiser = null;
        Main.wm.removeKeybinding('open-launcher');
        Main.wm.removeKeybinding('terminal-switcher');
        this._switcher?.close();
        this._switcher = null;
        this._launcher?.close();
        this._launcher = null;
        this._dockSearch?.destroy();
        this._dockSearch = null;
        this._rounder?.destroy();
        this._rounder = null;
        this._placer?.destroy();
        this._placer = null;
        this._bottomGap?.destroy();
        this._bottomGap = null;
        this._islands?.destroy();
        this._islands = null;
        this._spotify?.destroy();
        this._spotify = null;
        this._discord?.destroy();
        this._discord = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
