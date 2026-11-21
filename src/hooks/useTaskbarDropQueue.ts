import { useLayoutEffect, useState } from 'react';
import type { TaskbarScene } from '../domain/taskbar-scenes';
import { DEFAULT_SCENE_SECONDS } from '../shared/scene-durations';

interface QueuedDrop {
  event: TaskbarScene;
  seconds: number;
  play: () => void;
  visible: boolean;
}

export class TaskbarDropQueue {
  private pending: QueuedDrop[] = [];
  private audioOnly: QueuedDrop[] = [];
  private current?: QueuedDrop;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;

  constructor(private readonly show: (event: TaskbarScene | null) => void) {}

  setActive(active: boolean) {
    this.active = active;
    if (!active) {
      // Let sounds already in the queue finish in order when the player leaves the strip.
      for (const drop of this.pending) { drop.visible = false; this.audioOnly.push(drop); }
      this.pending = [];
      this.show(null);
      if (this.current) {
        this.current.visible = false;
        this.startCurrent();
      }
    }
  }

  enqueue = (event: TaskbarScene, play: () => void, seconds = DEFAULT_SCENE_SECONDS): boolean => {
    if (!this.active) return false;
    this.pending.push({ event, play, seconds, visible: true });
    if (!this.current?.visible) {
      // A sound from the previous strip session already started. Its timer must not hold a new scene.
      clearTimeout(this.timer);
      this.advance();
    }
    return true;
  };

  private advance() {
    this.timer = undefined;
    this.current = this.pending.shift() ?? this.audioOnly.shift();
    this.show(this.current?.visible ? this.current.event : null);
    if (!this.current?.visible) this.startCurrent();
  }

  presented(event: TaskbarScene) {
    if (this.current?.event === event && this.current.visible) this.startCurrent();
  }

  private startCurrent() {
    if (!this.current || this.timer !== undefined) return;
    this.timer = setTimeout(() => this.advance(), this.current.seconds * 1000);
    this.current.play();
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.current = undefined;
    this.pending = [];
    this.audioOnly = [];
    this.active = false;
  }
}

export function useTaskbarDropQueue(active: boolean) {
  const [current, setCurrent] = useState<TaskbarScene | null>(null);
  const [queue] = useState(() => new TaskbarDropQueue(setCurrent));
  useLayoutEffect(() => { queue.setActive(active); }, [active, queue]);
  useLayoutEffect(() => { if (active && current) queue.presented(current); }, [active, current, queue]);
  useLayoutEffect(() => () => queue.dispose(), [queue]);
  return { current, enqueue: queue.enqueue };
}
