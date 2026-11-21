import { screen, type BrowserWindow, type Rectangle } from 'electron';

interface NormalWindow {
  bounds: Rectangle;
  minimum: number[];
  maximized: boolean;
  maximizable: boolean;
  resizable: boolean;
  alwaysOnTop: boolean;
}

/** The compact mode belongs to this window's lifetime, never to the saved profile. */
export class TaskbarWindow {
  private normal: NormalWindow | null = null;
  private rows = 1;

  constructor(private readonly window: BrowserWindow) {
    screen.on('display-removed', this.align);
    screen.on('display-metrics-changed', this.align);
    window.once('closed', () => {
      screen.off('display-removed', this.align);
      screen.off('display-metrics-changed', this.align);
    });
  }

  get active(): boolean { return this.normal !== null; }

  setRows(characterCount: number): void {
    const rows = Math.max(1, characterCount);
    if (rows === this.rows) return;
    this.rows = rows;
    if (this.active) this.align();
  }

  private align = (): void => {
    if (!this.normal || this.window.isDestroyed()) return;
    const area = screen.getDisplayMatching(this.window.getBounds()).workArea;
    const width = Math.min(1000, area.width);
    // A fixed-size Windows window also adopts its current dimensions as its minimum.
    this.window.setResizable(true);
    this.window.setMinimumSize(1, 1);
    const outer = this.window.getBounds(), content = this.window.getContentBounds();
    const narrow = width - (outer.width - content.width) <= 680;
    const frameHeight = Math.max(0, outer.height - content.height);
    const fixed = frameHeight + (narrow ? 38 : 58);
    const rowHeight = narrow ? 122 : 62;
    const fittingRows = Math.max(3, Math.floor((area.height * 0.4 - fixed) / rowHeight));
    const height = Math.min(area.height, fixed + Math.min(this.rows, fittingRows) * rowHeight);
    this.window.setBounds({
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + area.height - height,
      width, height,
    });
    this.window.setResizable(false);
  };

  private restore(normal: NormalWindow): void {
    const win = this.window;
    win.setResizable(normal.resizable);
    win.setMaximizable(normal.maximizable);
    win.setMinimumSize(normal.minimum[0], normal.minimum[1]);
    const area = screen.getDisplayMatching(normal.bounds).workArea;
    // Preserve partly off-screen positions as long as the title bar is still reachable.
    const bounds = { ...normal.bounds };
    if (bounds.x + bounds.width < area.x + 48 || bounds.x > area.x + area.width - 48) bounds.x = area.x;
    if (bounds.y + 24 < area.y || bounds.y > area.y + area.height - 24) bounds.y = area.y;
    win.setBounds(bounds);
    win.setAlwaysOnTop(normal.alwaysOnTop);
    if (normal.maximized) win.maximize();
  }

  set(active: boolean): boolean {
    if (this.active === active) return active;
    const win = this.window;
    if (active) {
      if (win.isFullScreen()) throw new Error('Görev çubuğu moduna geçmek için önce tam ekrandan çık.');
      const normal = {
        bounds: win.getNormalBounds(), minimum: win.getMinimumSize(), maximized: win.isMaximized(),
        alwaysOnTop: win.isAlwaysOnTop(), maximizable: win.isMaximizable(), resizable: win.isResizable(),
      };
      this.normal = normal;
      try {
        if (normal.maximized) win.unmaximize();
        win.setMaximizable(false);
        this.align();
        win.setAlwaysOnTop(true);
      } catch (error) {
        this.restore(normal);
        this.normal = null;
        throw error;
      }
    } else {
      this.restore(this.normal!);
      this.normal = null;
    }
    return this.active;
  }
}
