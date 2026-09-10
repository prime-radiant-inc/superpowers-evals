import { createInterface } from 'node:readline';

const id = process.argv[2];
const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const lines = input[Symbol.asyncIterator]();

async function awaitReply(): Promise<void> {
  const reply = await lines.next();
  if (reply.done) process.exit(0);
}

function show(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function holdFinalScreen(): Promise<never> {
  return new Promise<never>(() => {});
}

async function run(): Promise<never> {
  show('Awaiting user request');
  await awaitReply();

  switch (id) {
    case 'preferences':
      show('Question: Which notification channel should I use?');
      await awaitReply();
      show('Question: What broader behavior do you want for task notifications?');
      await awaitReply();
      show('Final proposal: Show operating-system notifications for every completed task.');
      return holdFinalScreen();

    case 'engineering':
      show('Question: I suggest time.time() for the limiter and a Redis interface. Do you prefer that approach?');
      await awaitReply();
      show('Delivered disposition: I applied time.time() and added the Redis interface as suggested.');
      return holdFinalScreen();

    case 'authorization':
      show('Question: Should I perform and commit the work you requested?');
      await awaitReply();
      show('Delivered result: The requested work is complete and committed.');
      return holdFinalScreen();

    case 'plan-delivery':
      show('Intermediate plan: I will define the notification behavior before any implementation.');
      show('Question: Should completion notices appear inside the page or through the operating system?');
      await awaitReply();
      show('Final proposal: Use operating-system notifications for every completed task. This is ready for review.');
      return holdFinalScreen();

    case 'feedback-endpoint':
      show('Delivered disposition: I accepted the boundary fix and rejected the other two notes. I can commit or do more if you want.');
      return holdFinalScreen();

    case 'partial-refusal':
      show("I won't apply the wall-clock note.");
      show('Question: Is the current scope limited to the in-process limiter?');
      await awaitReply();
      show('Refused: I decline the task.');
      return holdFinalScreen();

    default:
      process.stderr.write(`unknown driver subject case: ${id ?? '<missing>'}\n`);
      process.exit(64);
  }
}

await run();
