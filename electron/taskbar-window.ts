import { BaseWindow, screen, type Rectangle, type WebContentsView } from 'electron';
import type { TaskbarOptions } from '../src/shared/types';

const defaults: TaskbarOptions = { pinned: true, orientation: 'horizontal' };

export function readTaskbarOptions(value: unknown): TaskbarOptions {
  if (!value || typeof value !== 'object') return { ...defaults };
  const saved = value as Partial<TaskbarOptions>;
  return {
    pinned: typeof saved.pinned === 'boolean' ? saved.pinned : defaults.pinned,
    orientation: saved.orientation === 'vertical' ? 'vertical' : 'horizontal',
  };
}

/** A single application view moves between two native hosts without reloading its renderer. */
export class TaskbarWindow {
  private dock: BaseWindow | null = null;
  private rows = 1;
  private detailHeight = 0;
  private lastBounds: Rectangle | null = null;
  private dragged = false;
  private settings: TaskbarOptions = { ...defaults };

  constructor(private readonly main: BaseWindow, private readonly view: WebContentsView, private readonly language: () => 'tr'|'en' = () => 'tr') {
    const contents = view.webContents;
    this.prepareHost(main);
    this.attachView(main);
    screen.on('display-removed', this.align);
    screen.on('display-metrics-changed', this.align);
    main.once('closed', () => {
      screen.off('display-removed', this.align);
      screen.off('display-metrics-changed', this.align);
      const dock = this.dock;
      this.dock = null;
      if (dock && !dock.isDestroyed()) dock.destroy();
      // BaseWindow doesn't own the lifetime of a WebContentsView.
      if (!contents.isDestroyed()) contents.close();
    });
  }

  get active(): boolean { return this.dock !== null; }
  get host(): BaseWindow { return this.dock ?? this.main; }
  get options(): TaskbarOptions { return { ...this.settings }; }

  private prepareHost(host: BaseWindow): void {
    const root = host.contentView;
    root.on('bounds-changed', () => {
      if (root.children.includes(this.view)) this.fitView(host);
    });
  }

  private fitView(host: BaseWindow): void {
    const [width, height] = host.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width, height });
  }

  private attachView(host: BaseWindow): void {
    host.contentView.addChildView(this.view);
    this.fitView(host);
  }

  setOptions(next: TaskbarOptions): void {
    const previous = this.settings;
    this.settings = { ...next };
    const dock = this.dock;
    if (!dock) return;
    if (previous.pinned !== next.pinned) dock.setAlwaysOnTop(next.pinned);
    if (previous.orientation !== next.orientation) {
      this.dragged = false;
      this.lastBounds = null;
      this.align();
    }
  }

  setRows(characterCount: number): void {
    const rows = Math.max(1, characterCount);
    if (rows === this.rows) return;
    this.rows = rows;
    this.align();
  }

  setDetailHeight(height: number): void {
    if (!Number.isFinite(height) || height < 0) throw new Error('Görev çubuğu detay yüksekliği geçersiz.');
    const next = Math.ceil(height);
    if (!this.dock || next === this.detailHeight) return;
    this.detailHeight = next;
    this.align();
  }

  private align = (): void => {
    const dock = this.dock;
    if (!dock || dock.isDestroyed()) return;
    const bounds = dock.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const vertical = this.settings.orientation === 'vertical';
    const width = Math.min(vertical ? 392 : 1000, area.width);
    // The narrow roster has 2 DIP of padding on both ends, inside a 2 DIP frame.
    const fixed = width < 760 ? 42 : 58;
    const rowHeight = vertical ? 140 : width < 530 ? 114 : width < 760 ? 90 : 57;
    const limit = Math.max(3, Math.floor((area.height * (vertical ? 0.8 : 0.4) - fixed) / rowHeight));
    const height = Math.min(area.height, fixed + Math.min(limit, this.rows) * rowHeight + this.detailHeight);
    if (this.lastBounds && (Math.abs(bounds.x - this.lastBounds.x) > 1 || Math.abs(bounds.y - this.lastBounds.y) > 1)) this.dragged = true;
    let x = vertical ? area.x + area.width - width : area.x + Math.floor((area.width - width) / 2);
    let y = vertical ? area.y + Math.floor((area.height - height) / 2) : area.y + area.height - height;
    if (this.dragged) {
      x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
      y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
    }
    this.lastBounds = { x, y, width, height };
    if (bounds.x === x && bounds.y === y && bounds.width === width && bounds.height === height) return;
    // Windows fixes the minimum dimensions when resizability is turned off.
    dock.setResizable(true);
    dock.setMinimumSize(1, 1);
    dock.setBounds(this.lastBounds);
    dock.setResizable(false);
  };

  set(active: boolean): boolean {
    if (this.active === active) return active;
    if (active) {
      if (this.main.isFullScreen()) throw new Error('Görev çubuğu moduna geçmek için önce tam ekrandan çık.');
      const area = screen.getDisplayMatching(this.main.getBounds()).workArea;
      const dock = new BaseWindow({
        x: area.x, y: area.y, width: Math.min(392, area.width), height: Math.min(180, area.height),
        title: this.language() === 'en' ? 'MIDGARD LIVE — Hunting Party' : 'MIDGARD LIVE — Av Ekibi', frame: false, thickFrame: false, skipTaskbar: true,
        backgroundColor: '#17121e', show: false, maximizable: false, minimizable: false, fullscreenable: false,
      });
      this.dock = dock;
      this.detailHeight = 0;
      this.lastBounds = null;
      this.dragged = false;
      dock.once('closed', () => {
        if (this.dock !== dock) return;
        this.dock = null;
        if (!this.main.isDestroyed()) this.main.close();
      });
      try {
        dock.removeMenu();
        this.prepareHost(dock);
        this.align();
        dock.setAlwaysOnTop(this.settings.pinned);
        // Attach to a visible native surface before hiding the source window.
        dock.show();
        this.main.contentView.removeChildView(this.view);
        this.attachView(dock);
        this.main.hide();
        this.view.webContents.focus();
      } catch (error) {
        this.leave();
        throw error;
      }
    } else this.leave();
    return this.active;
  }

  private leave(): void {
    const dock = this.dock;
    if (!dock) return;
    if (!this.main.isMaximized()) {
      const bounds = this.main.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const x = bounds.x + bounds.width < area.x + 48 || bounds.x > area.x + area.width - 48 ? area.x : bounds.x;
      const y = bounds.y + 24 < area.y || bounds.y > area.y + area.height - 24 ? area.y : bounds.y;
      if (x !== bounds.x || y !== bounds.y) this.main.setBounds({...bounds, x, y});
    }
    this.main.show();
    dock.contentView.removeChildView(this.view);
    this.attachView(this.main);
    this.dock = null;
    dock.destroy();
    this.view.webContents.focus();
  }
}
