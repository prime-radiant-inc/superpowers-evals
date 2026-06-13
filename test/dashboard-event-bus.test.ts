import { expect, test } from 'bun:test';
import type { SseMessage } from '../src/dashboard/contracts.ts';
import { BoundedQueue, EventBus } from '../src/dashboard/event-bus.ts';

test('BoundedQueue drops the oldest past capacity', () => {
  const q = new BoundedQueue<number>(2);
  q.push(1);
  q.push(2);
  q.push(3);
  expect(q.drain()).toEqual([2, 3]);
});

test('BoundedQueue size tracks pushes and drops, drain resets to zero', () => {
  const q = new BoundedQueue<number>(2);
  expect(q.size).toBe(0);
  q.push(1);
  expect(q.size).toBe(1);
  q.push(2);
  q.push(3);
  // at capacity 2, third push drops the oldest — size stays 2.
  expect(q.size).toBe(2);
  expect(q.drain()).toEqual([2, 3]);
  expect(q.size).toBe(0);
  // a second drain on the emptied queue returns [].
  expect(q.drain()).toEqual([]);
});

test('BoundedQueue default capacity is 256', () => {
  const q = new BoundedQueue<number>();
  for (let i = 0; i < 300; i++) {
    q.push(i);
  }
  const drained = q.drain();
  expect(drained.length).toBe(256);
  // oldest 44 (0..43) dropped; window is 44..299.
  expect(drained[0]).toBe(44);
  expect(drained[drained.length - 1]).toBe(299);
});

const msg = (event: string, data: string): SseMessage => ({ event, data });

test('EventBus fans a message to every subscriber', () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  const b = bus.subscribe();
  expect(bus.subscriberCount).toBe(2);
  bus.publish(msg('strip', '<x/>'));
  expect(a.drain().length).toBe(1);
  expect(b.drain().length).toBe(1);
});

test('EventBus publish reaches each subscriber with the same payload', () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  const b = bus.subscribe();
  const m = msg('cell-foo-claude', '<div/>');
  bus.publish(m);
  expect(a.drain()).toEqual([m]);
  expect(b.drain()).toEqual([m]);
});

test('EventBus unsubscribe stops delivery to the removed queue', () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  const b = bus.subscribe();
  bus.unsubscribe(a);
  expect(bus.subscriberCount).toBe(1);
  bus.publish(msg('strip', '<y/>'));
  expect(a.drain().length).toBe(0);
  expect(b.drain().length).toBe(1);
});

test('EventBus with no subscribers drops the message silently', () => {
  const bus = new EventBus();
  expect(bus.subscriberCount).toBe(0);
  // No throw, nothing to deliver to.
  bus.publish(msg('strip', '<z/>'));
  expect(bus.subscriberCount).toBe(0);
});

test('EventBus drops the oldest per-subscriber past the default cap (256)', () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  for (let i = 0; i < 300; i++) {
    bus.publish(msg('strip', String(i)));
  }
  const drained = a.drain();
  expect(drained.length).toBe(256);
  expect(drained[0]?.data).toBe('44');
  expect(drained[drained.length - 1]?.data).toBe('299');
});
