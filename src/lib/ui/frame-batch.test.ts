import { expect, test } from "bun:test";
import { createFrameBatch, type FrameScheduler } from "./frame-batch.ts";

function manualFrames() {
  const queue: Array<() => void> = [];
  const scheduler: FrameScheduler = {
    request: (callback) => {
      queue.push(callback);
      return () => void queue.splice(queue.indexOf(callback), 1);
    },
  };
  return { scheduler, queue, frame: () => queue.splice(0).forEach((callback) => callback()) };
}

test("delivers everything that arrived within a frame together, in order, with one frame requested", () => {
  const f = manualFrames();
  const delivered: number[][] = [];
  const batch = createFrameBatch<number>((items) => delivered.push([...items]), f.scheduler);
  batch.add(1);
  batch.add(2);
  batch.add(3);
  expect(f.queue.length).toBe(1);
  expect(delivered).toEqual([]);
  f.frame();
  expect(delivered).toEqual([[1, 2, 3]]);
  batch.add(4);
  f.frame();
  expect(delivered).toEqual([[1, 2, 3], [4]]);
});

test("a cleared batch delivers nothing, and a stopped one leaves no frame behind", () => {
  const f = manualFrames();
  const delivered: number[][] = [];
  const batch = createFrameBatch<number>((items) => delivered.push([...items]), f.scheduler);
  batch.add(1);
  batch.clear();
  f.frame();
  expect(delivered).toEqual([]);
  batch.add(2);
  batch.stop();
  expect(f.queue.length).toBe(0);
  f.frame();
  expect(delivered).toEqual([]);
  batch.add(3);
  f.frame();
  expect(delivered).toEqual([[3]]);
});
