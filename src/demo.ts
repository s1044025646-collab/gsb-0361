import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';

// Demo: with width=1 every key collides into the single column, so every
// estimate equals the total weight. Widening the matrix reduces (but does
// not monotonically guarantee reduction of) the overestimation.
function run(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-demo-'));
  const events: [string, number][] = [
    ['apple', 5], ['banana', 3], ['apple', 2], ['cherry', 7],
    ['banana', 1], ['date', 4], ['apple', 1], ['elderberry', 2],
  ];
  const exact = new Map<string, bigint>();
  for (const [k, w] of events) exact.set(k, (exact.get(k) ?? 0n) + BigInt(w));
  const keys = [...exact.keys()];

  console.log('Events:', events.map(([k, w]) => `${k}+${w}`).join(' '));
  console.log('Exact :', keys.map((k) => `${k}=${exact.get(k)}`).join(' '));
  console.log('');

  for (const width of [1, 4, 64]) {
    const store = new Store(dir);
    const meta = store.create({ width, depth: 4, seed: 42 });
    store.addBatch(meta.id, events.map(([key, w]) => ({ key, weight: w })));
    const estimates = keys.map((k) => {
      const q = store.query(meta.id, k);
      const over = BigInt(q.estimate) - exact.get(k)!;
      return `${k}=${q.estimate}(+${over})`;
    });
    console.log(`width=${String(width).padStart(2)} depth=4 estimates: ${estimates.join(' ')}`);
    if (width === 1) {
      const exp = store.explain(meta.id, 'apple');
      console.log('  width=1 => all keys share column 0 in every row; estimate == total weight.');
      console.log('  explain(apple):', JSON.stringify(exp.rows));
    }
    store.close();
  }
  console.log('');
  console.log('Note: larger width usually lowers overestimation, but it is NOT guaranteed');
  console.log('to decrease monotonically for every key on every dataset.');
  fs.rmSync(dir, { recursive: true, force: true });
}

run();
