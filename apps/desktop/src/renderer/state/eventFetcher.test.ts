import { expect, test } from "vitest";
import type { RunEvent } from "@aolangai/core";
import { createEventFetcher } from "./eventFetcher.js";

const ev = (id: number, runId = 1): RunEvent => ({ id, runId, kind: "tool", text: `step ${id}`, createdAt: id });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("a tick while the previous fetch of the same run is in flight is skipped", async () => {
  const pending: ReturnType<typeof deferred<RunEvent[]>>[] = [];
  const applied: [number, number][] = [];
  const f = createEventFetcher((id) => { const d = deferred<RunEvent[]>(); pending.push(d); void id; return d.promise; }, (id, list) => applied.push([id, list.length]), () => {});
  f.fetch(1);
  f.fetch(1);
  f.fetch(1);
  expect(pending).toHaveLength(1);
  f.fetch(2); // another run is independent
  expect(pending).toHaveLength(2);
  pending[0]!.resolve([ev(1)]);
  await new Promise((r) => setTimeout(r, 0));
  f.fetch(1); // finished, so the next tick goes out
  expect(pending).toHaveLength(3);
  expect(applied).toEqual([[1, 1]]);
});

test("the in-flight slot is freed after an error too, and the error is reported with the run id", async () => {
  const errors: [number, unknown][] = [];
  let calls = 0;
  const f = createEventFetcher(() => (++calls === 1 ? Promise.reject(new Error("broken")) : Promise.resolve([ev(1)])), () => {}, (id, e) => errors.push([id, e]));
  f.fetch(7);
  await new Promise((r) => setTimeout(r, 0));
  expect(errors.map(([id, e]) => [id, (e as Error).message])).toEqual([[7, "broken"]]);
  f.fetch(7);
  expect(calls).toBe(2);
});

test("an older response can never overwrite a newer one: one request per run at a time, applied in order", async () => {
  const pending: ReturnType<typeof deferred<RunEvent[]>>[] = [];
  const applied: number[] = [];
  const f = createEventFetcher(() => { const d = deferred<RunEvent[]>(); pending.push(d); return d.promise; }, (_id, list) => applied.push(list.length), () => {});
  f.fetch(1);
  f.fetch(1); // skipped
  pending[0]!.resolve([ev(1)]);
  await new Promise((r) => setTimeout(r, 0));
  f.fetch(1);
  pending[1]!.resolve([ev(1), ev(2)]);
  await new Promise((r) => setTimeout(r, 0));
  expect(applied).toEqual([1, 2]);
});
