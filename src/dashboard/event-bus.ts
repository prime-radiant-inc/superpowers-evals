import type { SseMessage } from './contracts.ts';

// Bounded SSE fan-out. The dashboard's scheduler events are published to every
// connected SSE client; each client reads through its own BoundedQueue. There
// are NO threads and NO async here — Bun runs one event loop, the scheduler's
// onEvent fires synchronously, and publish walks the subscriber set in that same
// turn. Single-loop Bun makes the per-subscriber bound the only backpressure
// mechanism the bus needs.

// The default per-subscriber capacity. Dropping the oldest message is safe
// because every cell partial the bus carries is an idempotent full-state swap:
// a slow client that misses intermediate frames still converges to the newest
// state once it drains, and the next scan/publish re-asserts the truth.
export const DEFAULT_QUEUE_CAPACITY = 256;

// An array-backed FIFO with a hard capacity. push past capacity drops the
// OLDEST element (shift) so the newest frames always win. drain empties the
// queue and returns its contents oldest..newest.
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_QUEUE_CAPACITY) {
    this.capacity = capacity;
  }

  // Append x. If already at capacity, drop the oldest first (drop-oldest).
  push(x: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(x);
  }

  // Empty the queue and return everything it held, oldest..newest.
  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  // The number of buffered items.
  get size(): number {
    return this.items.length;
  }
}

// The SSE publish/subscribe hub. A subscriber is its own BoundedQueue, held in
// a Set; publish pushes the message onto every subscriber's queue. The server
// (Task 13) subscribes a queue per SSE connection, drains it on its read loop,
// and unsubscribes on disconnect.
export class EventBus {
  private readonly subscribers = new Set<BoundedQueue<SseMessage>>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_QUEUE_CAPACITY) {
    this.capacity = capacity;
  }

  // Register a new subscriber and hand back its queue.
  subscribe(): BoundedQueue<SseMessage> {
    const q = new BoundedQueue<SseMessage>(this.capacity);
    this.subscribers.add(q);
    return q;
  }

  // Drop a subscriber so publish no longer reaches it.
  unsubscribe(q: BoundedQueue<SseMessage>): void {
    this.subscribers.delete(q);
  }

  // Push msg onto every subscriber's queue. With no subscribers the message is
  // dropped silently — there is nowhere to deliver it and the next publish
  // re-asserts state.
  publish(msg: SseMessage): void {
    for (const q of this.subscribers) {
      q.push(msg);
    }
  }

  // How many subscribers are currently connected.
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
