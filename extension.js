import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const _ = text => text;
const SAMPLE_INTERVAL_MS = 1000;
const SPARKLINE_POINTS = 30;
const PROCESS_REFRESH_MS = 5000;

function readNetworkCounters() {
    let [ok, contents] = GLib.file_get_contents('/proc/net/dev');
    if (!ok)
        throw new Error('Unable to read /proc/net/dev');

    let text = new TextDecoder().decode(contents);
    let received = 0;
    let transmitted = 0;

    for (let line of text.split('\n')) {
        let separator = line.indexOf(':');
        if (separator < 0)
            continue;

        let interfaceName = line.slice(0, separator).trim();
        if (interfaceName === 'lo')
            continue;

        let fields = line.slice(separator + 1).trim().split(/\s+/);
        if (fields.length >= 9) {
            received += Number(fields[0]);
            transmitted += Number(fields[8]);
        }
    }

    return { received, transmitted };
}

function formatRate(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function parseNethogsLine(line) {
    // nethogs -t uses: program/pid/user upload download
    let match = line.trim().match(/^(.+?)\/(\d+)\/(.+?)\s+([\d.]+)\s+([\d.]+)/);
    if (!match)
        return null;

    return {
        name: match[1].split('/').pop(),
        pid: match[2],
        user: match[3],
        upload: Number(match[4]),
        download: Number(match[5]),
    };
}

var Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init() {
        super._init({ width: 76, height: 24, reactive: false });
        this._values = [];
        this.connect('repaint', () => this._paint());
    }

    setValues(values) {
        this._values = values.slice(-SPARKLINE_POINTS);
        this.queue_repaint();
    }

    _paint() {
        let cr = this.get_context();
        let [width, height] = this.get_surface_size();
        if (width <= 0 || height <= 0)
            return;

        cr.setLineWidth(1.5);
        cr.setSourceRGBA(0.35, 0.78, 0.98, 0.95);

        if (this._values.length < 2)
            return;

        let maximum = Math.max(...this._values, 1);
        let xStep = width / (this._values.length - 1);

        this._values.forEach((value, index) => {
            let x = index * xStep;
            let y = height - 2 - ((value / maximum) * (height - 4));
            if (index === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        });
        cr.stroke();
    }
});

var NetworkPulse = GObject.registerClass(
class NetworkPulse extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Network Traffic & Bandwidth Pulse'));

        this._history = [];
        this._lastCounters = null;
        this._processRefreshInProgress = false;

        this._box = new St.BoxLayout({ style_class: 'network-pulse-box' });
        this._sparkline = new Sparkline();
        this._downloadLabel = new St.Label({
            text: '↓ --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'network-pulse-download',
        });
        this._uploadLabel = new St.Label({
            text: '↑ --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'network-pulse-upload',
        });
        this._box.add_child(this._sparkline);
        this._box.add_child(this._downloadLabel);
        this._box.add_child(this._uploadLabel);
        this.add_child(this._box);

        this._statusItem = new PopupMenu.PopupMenuItem(_('Reading network counters...'));
        this._statusItem.reactive = false;
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._authorItem = new PopupMenu.PopupMenuItem(_('Created by Sudipto Paul'));
        this._authorItem.reactive = false;
        this.menu.addMenuItem(this._authorItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._processHeader = new PopupMenu.PopupMenuItem(_('Top bandwidth processes'));
        this._processHeader.reactive = false;
        this.menu.addMenuItem(this._processHeader);
        this._processItems = [];

        this._sample();
        this._sampleTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SAMPLE_INTERVAL_MS,
            () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._processTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PROCESS_REFRESH_MS,
            () => {
                this._refreshProcesses();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshProcesses();
        });
    }

    _sample() {
        try {
            let counters = readNetworkCounters();
            if (this._lastCounters) {
                let elapsedSeconds = SAMPLE_INTERVAL_MS / 1000;
                let download = Math.max(0, counters.received - this._lastCounters.received) / elapsedSeconds;
                let upload = Math.max(0, counters.transmitted - this._lastCounters.transmitted) / elapsedSeconds;
                let total = download + upload;
                this._history.push(total);
                this._history = this._history.slice(-SPARKLINE_POINTS);
                this._sparkline.setValues(this._history);
                this._downloadLabel.set_text(`↓ ${formatRate(download)}`);
                this._uploadLabel.set_text(`↑ ${formatRate(upload)}`);
                this._statusItem.label.text = `${_('Download')}: ${formatRate(download)}   ${_('Upload')}: ${formatRate(upload)}`;
            }
            this._lastCounters = counters;
        } catch (error) {
            logError(error, 'Network Pulse could not read /proc/net/dev');
            this._statusItem.label.text = _('Unable to read network counters');
        }
    }

    _clearProcessItems() {
        for (let item of this._processItems)
            item.destroy();
        this._processItems = [];
    }

    _refreshProcesses() {
        if (this._processRefreshInProgress)
            return;
        this._processRefreshInProgress = true;

        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(
                ['nethogs', '-t', '-c', '1'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._showProcessFallback(_('Install nethogs to show per-process traffic.'));
            this._processRefreshInProgress = false;
            return;
        }

        subprocess.communicate_utf8_async(null, null, (_process, result) => {
            try {
                let [, stdout] = subprocess.communicate_utf8_finish(result);
                let processes = stdout.split('\n')
                    .map(parseNethogsLine)
                    .filter(process => process !== null)
                    .sort((a, b) => (b.upload + b.download) - (a.upload + a.download))
                    .slice(0, 5);
                this._showProcesses(processes);
            } catch (error) {
                logError(error, 'Network Pulse could not read nethogs output');
                this._showProcessFallback(_('No process traffic data available.'));
            } finally {
                this._processRefreshInProgress = false;
            }
        });
    }

    _showProcesses(processes) {
        this._clearProcessItems();
        if (processes.length === 0) {
            this._showProcessFallback(_('No active bandwidth-heavy processes.'));
            return;
        }

        for (let process of processes) {
            let item = new PopupMenu.PopupMenuItem(
                `${process.name} (${process.pid})  ↓${formatRate(process.download)} ↑${formatRate(process.upload)}`
            );
            item.reactive = false;
            this.menu.addMenuItem(item);
            this._processItems.push(item);
        }
    }

    _showProcessFallback(message) {
        this._clearProcessItems();
        let item = new PopupMenu.PopupMenuItem(message);
        item.reactive = false;
        this.menu.addMenuItem(item);
        this._processItems.push(item);
    }

    destroy() {
        if (this._sampleTimer)
            GLib.source_remove(this._sampleTimer);
        if (this._processTimer)
            GLib.source_remove(this._processTimer);
        super.destroy();
    }
});

class NetworkPulseExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._theme = null;
        this._stylesheet = null;
    }

    enable() {
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheet);
        this._indicator = new NetworkPulse();
        Main.panel.addToStatusArea('network-pulse', this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator)
            this._indicator.destroy();
        this._indicator = null;
        if (this._theme && this._stylesheet)
            this._theme.unload_stylesheet(this._stylesheet);
        this._theme = null;
        this._stylesheet = null;
    }
}

export default function init(metadata) {
    return new NetworkPulseExtension(metadata);
}
