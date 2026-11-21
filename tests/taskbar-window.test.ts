import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Rectangle } from 'electron';
import { TaskbarWindow } from '../electron/taskbar-window';

const display = vi.hoisted(() => ({workArea: {x: 0, y: 0, width: 1920, height: 1040}}));
vi.mock('electron', () => ({screen: {on: vi.fn(), off: vi.fn(), getDisplayMatching: () => display}}));

function setup() {
  let bounds = {x: 120, y: 90, width: 1200, height: 800};
  const win = {
    once: vi.fn(), isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false,
    isMaximizable: () => true, isResizable: () => true, isAlwaysOnTop: () => false, getMinimumSize: () => [650, 400],
    getBounds: () => ({...bounds}), getNormalBounds: () => ({...bounds}),
    getContentBounds: () => ({...bounds, width: bounds.width - 16, height: bounds.height - 39}),
    setBounds: vi.fn((next: Rectangle) => {bounds = {...next};}),
    setResizable: vi.fn(), setMinimumSize: vi.fn(), setMaximizable: vi.fn(), setAlwaysOnTop: vi.fn(),
  };
  return {win, mode: new TaskbarWindow(win as unknown as BrowserWindow)};
}

describe('native party taskbar geometry', () => {
  beforeEach(() => {display.workArea = {x: 0, y: 0, width: 1920, height: 1040};});

  it('grows for additional characters, caps the list by available space and restores the main window', () => {
    const {win, mode} = setup(), normal = win.getBounds();
    mode.setRows(1);
    mode.set(true);
    const one = win.getBounds();
    mode.setRows(3);
    const three = win.getBounds();
    mode.setRows(4);
    const four = win.getBounds();
    expect(one.height).toBeLessThan(three.height);
    expect(three.height).toBeLessThan(four.height);
    mode.setRows(100);
    const many = win.getBounds();
    expect(many.height).toBeGreaterThanOrEqual(four.height);
    expect(many.height).toBeLessThanOrEqual(display.workArea.height * 0.4);
    for (const box of [one, three, four, many]) expect(box.y + box.height).toBe(display.workArea.height);
    mode.set(false);
    mode.setRows(2);
    expect(win.getBounds()).toEqual(normal);
  });

  it('fits a narrow secondary display, preserves the work-area offset and allows a short display', () => {
    display.workArea = {x: -320, y: 55, width: 320, height: 290};
    const {win, mode} = setup();
    mode.setRows(3);
    mode.set(true);
    expect(win.getBounds()).toEqual(display.workArea);
  });
});
