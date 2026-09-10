import { createConnection } from 'node:net';
import { DeferredResponses } from '../assessment-wire-fixture.ts';

const guard = setTimeout(() => {
  process.stderr.write(
    'Pending handler did not drain within the probe bound\n',
  );
  process.exit(2);
}, 2000);
const pending = new DeferredResponses();
const entered = Promise.withResolvers<void>();
// Strong references stay alive through the native stop await; no forced GC.
const held: Promise<Response>[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const response = (async () => {
      await request.json();
      entered.resolve();
      return await pending.response();
    })();
    held.push(response);
    return response;
  },
});
const client = createConnection({ host: '127.0.0.1', port: server.port! });
client.on('error', () => {});
await new Promise<void>((resolve) => client.once('connect', resolve));
client.write(
  'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}',
);
await entered.promise;
const closed = new Promise<void>((resolve) => client.once('close', resolve));
client.destroy();
await closed;
let stopped = false;
const nativeStop = server.stop(true).then(() => {
  stopped = true;
});
await Bun.sleep(25);
const blockedBeforeRelease = !stopped && server.pendingRequests === 1;
await pending.stop(server);
await nativeStop;
const responses = await Promise.all(held);
clearTimeout(guard);
process.stdout.write(
  `${JSON.stringify({
    blockedBeforeRelease,
    retainedHandlers: held.length,
    explicitlySettled: responses.every((response) => response.status === 503),
    nativeStopCompleted: stopped,
    pendingRequests: server.pendingRequests,
  })}\n`,
);
