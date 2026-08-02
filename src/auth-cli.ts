#!/usr/bin/env node
import { GarminConnect } from 'garmin-connect';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TOKEN_PATH, saveTokens, encodeTokens } from './garmin';

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (hidden) {
    // Suppress echo so the password never lands in the scrollback.
    const mute = (rl as unknown as { output: NodeJS.WriteStream }).output;
    const write = mute.write.bind(mute);
    mute.write = ((chunk: string) =>
      write(chunk.includes('\n') ? chunk : '')) as typeof mute.write;
    const answer = await rl.question(question);
    mute.write = write;
    stdout.write('\n');
    rl.close();
    return answer.trim();
  }
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main() {
  const username = process.env.GARMIN_EMAIL || (await prompt('Garmin email: '));
  const password = process.env.GARMIN_PASSWORD || (await prompt('Password: ', true));

  const client = new GarminConnect({ username, password });
  await client.login();

  const name = (await client.getUserProfile()).displayName;
  const tokens = client.exportToken();
  saveTokens(tokens);

  console.log(`\n✓ Logged in as ${name}`);
  console.log(`✓ Tokens saved to ${TOKEN_PATH}`);
  console.log(`\nFor Vercel / env-based deploys, set:`);
  console.log(`GARMIN_TOKENS_BASE64=${encodeTokens(tokens)}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
