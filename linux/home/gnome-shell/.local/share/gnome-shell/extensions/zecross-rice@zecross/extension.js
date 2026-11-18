// Chargeur : copie core.js sous un nom unique puis l'importe, pour que
// désactiver/réactiver l'extension recharge le code sans redémarrer GNOME.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ZecrossRice extends Extension {
    enable() {
        this._enabled = true;
        const gen = this._gen = (this._gen ?? 0) + 1;
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'zecross-rice']);
        GLib.mkdir_with_parents(dir, 0o700);
        // nettoie les anciennes copies
        const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
        let info;
        while ((info = enumerator.next_file(null)))
            enumerator.get_child(info).delete(null);
        const dst = Gio.File.new_for_path(`${dir}/core-${Date.now()}.js`);
        Gio.File.new_for_path(`${this.path}/core.js`).copy(dst, Gio.FileCopyFlags.OVERWRITE, null, null);
        import(dst.get_uri()).then(mod => {
            if (!this._enabled || gen !== this._gen)
                return;
            this._core = new mod.default(this);
            this._core.enable();
        }).catch(e => console.error('zecross-rice: chargement impossible', e));
    }

    disable() {
        this._enabled = false;
        this._gen = (this._gen ?? 0) + 1;
        this._core?.disable();
        this._core = null;
    }
}
