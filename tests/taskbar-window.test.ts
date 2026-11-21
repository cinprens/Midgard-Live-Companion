import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseWindowConstructorOptions, Rectangle, WebContentsView } from 'electron';
import { TaskbarWindow, readTaskbarOptions } from '../electron/taskbar-window';

const display = vi.hoisted(() => ({workArea: {x: 0, y: 0, width: 1920, height: 1040}}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class RootView extends EventEmitter {
    children: object[] = [];
    addChildView(child: object) {
      this.removeChildView(child);
      this.children.push(child);
    }
    removeChildView(child: object) { this.children = this.children.filter(view => view !== child); }
  }
  return {
    BaseWindow: class extends EventEmitter {
      contentView = new RootView();
      bounds: Rectangle;
      visible = true;
      dead = false;
      onTop = false;
      maximized = false;
      fullScreen = false;
      constructor(readonly creation: BaseWindowConstructorOptions) {
        super();
        this.bounds = {x: 0, y: 0, width: 1200, height: 800, ...creation} as Rectangle;
        this.visible = creation.show !== false;
      }
      getBounds() {return {...this.bounds};}
      getContentSize() {return [this.bounds.width, this.bounds.height];}
      setBounds(value:Rectangle) {this.bounds = {...value}; this.contentView.emit('bounds-changed');}
      isFullScreen() {return this.fullScreen;}
      isMaximized() {return this.maximized;}
      setAlwaysOnTop(value:boolean) {this.onTop = value;}
      hide() {this.visible = false;} show() {this.visible = true;}
      destroy() {if (!this.dead) {this.dead = true; this.emit('closed');}}
      close() {this.destroy();} isDestroyed() {return this.dead;}
      removeMenu() {} setResizable() {} setMinimumSize() {}
    },
    screen: {on: vi.fn(), off: vi.fn(), getDisplayMatching: () => display},
  };
});

interface Probe extends EventEmitter {
  creation: BaseWindowConstructorOptions;
  contentView: {children: object[]};
  visible: boolean;
  onTop: boolean;
  dead: boolean;
  fullScreen:boolean;
  setBounds(value:Rectangle):void;
  getBounds():Rectangle;
  close():void;
}

async function setup() {
  const electron = await import('electron');
  const normal = new electron.BaseWindow({x:120,y:90,width:1200,height:800});
  const contents = {focus: vi.fn(), close: vi.fn(), isDestroyed: () => false};
  const view = {webContents: contents, setBounds: vi.fn()};
  const mode = new TaskbarWindow(normal,view as unknown as WebContentsView);
  return {normal:normal as unknown as Probe, mode, contents, view, host:()=>mode.host as unknown as Probe};
}

describe('native party taskbar host', () => {
  beforeEach(() => {display.workArea = {x: 0, y: 0, width: 1920, height: 1040};});

  it('moves the same view into one visible frameless taskbar-free host and restores the main native window', async () => {
    const {normal,mode,contents,view,host}=await setup();
    const original=normal.getBounds();
    const normalRoot=normal.contentView;
    expect(normalRoot.children).toEqual([view]);
    mode.setRows(3); mode.set(true);
    const dock=host();
    expect(dock.creation).toMatchObject({frame:false,thickFrame:false,skipTaskbar:true,show:false});
    expect(dock.visible).toBe(true); expect(normal.visible).toBe(false);
    expect(dock.contentView.children).toEqual([view]); expect(normalRoot.children).toEqual([]);
    expect(dock.getBounds()).toEqual({x:460,y:811,width:1000,height:229});
    expect(view.setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:1000,height:229});
    normal.setBounds(original);
    expect(view.setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:1000,height:229});
    expect(dock.onTop).toBe(true);
    mode.setDetailHeight(83.3);
    expect(dock.getBounds()).toEqual({x:460,y:727,width:1000,height:313});
    expect(view.setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:1000,height:313});
    mode.setDetailHeight(0);
    mode.setRows(200);
    expect(dock.getBounds().height).toBeLessThanOrEqual(416);
    mode.set(false);
    expect(normal.visible).toBe(true); expect(normal.contentView).toBe(normalRoot); expect(normalRoot.children).toEqual([view]);
    expect(dock.contentView.children).toEqual([]); expect(dock.dead).toBe(true);
    expect(view.setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:original.width,height:original.height});
    expect(normal.getBounds()).toEqual(original); expect(contents.close).not.toHaveBeenCalled();
  });

  it('keeps pin and orientation independent and retains them when reentering', async () => {
    const {mode,host}=await setup();
    mode.setRows(3);mode.set(true);
    mode.setOptions({pinned:false,orientation:'vertical'});
    expect(host().onTop).toBe(false);
    expect(host().getBounds()).toEqual({x:1528,y:289,width:392,height:462});
    const upright=host().getBounds();
    mode.setOptions({pinned:true,orientation:'vertical'});
    expect(host().getBounds()).toEqual(upright);
    mode.set(false);mode.set(true);
    expect(host().onTop).toBe(true);expect(host().getBounds()).toEqual(upright);
    mode.setOptions({pinned:true,orientation:'horizontal'});
    expect(host().getBounds().width).toBe(1000);
    expect(readTaskbarOptions(null)).toEqual({pinned:true,orientation:'horizontal'});
    expect(readTaskbarOptions({pinned:false,orientation:'other'})).toEqual({pinned:false,orientation:'horizontal'});
  });

  it('preserves a dragged position during expansion and clamps to a reduced work area',async()=>{
    const {mode,host}=await setup();mode.setRows(3);mode.set(true);
    host().setBounds({...host().getBounds(),x:300,y:250});
    mode.setDetailHeight(40);
    expect(host().getBounds()).toMatchObject({x:300,y:250,height:269});
    display.workArea={x:-320,y:55,width:320,height:290};
    mode.setDetailHeight(1900);
    expect(host().getBounds()).toEqual(display.workArea);
    expect(()=>mode.setDetailHeight(NaN)).toThrow();
  });

  it('takes the normal close route for native dock close and releases its only WebContents once',async()=>{
    const {mode,normal,host,contents}=await setup();mode.set(true);
    host().close();expect(normal.dead).toBe(true);expect(contents.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a fullscreen main window visible if dock entry is unavailable',async()=>{
    const {mode,normal}=await setup();normal.fullScreen=true;
    expect(()=>mode.set(true)).toThrow(/tam ekran/);expect(normal.visible).toBe(true);expect(mode.active).toBe(false);
  });
});
