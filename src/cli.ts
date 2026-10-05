import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store.js';
import { CmsError } from './sketch.js';

const DATA_DIR = process.env.CMS_DATA_DIR ?? path.join(process.cwd(), 'data');

const USAGE = `cms <command> [args]
  create --width W --depth D [--seed S]
  list
  add <id> --key K --weight W
  add-batch <id> --file items.json
  query <id> --key K
  explain <id> --key K
  cells <id> --row R [--offset N] [--limit N]
  merge <idA> <idB>
  export <id> [--file out.json]
  import --file state.json
  history <id> [--limit N]
Environment: CMS_DATA_DIR (default ./data)`;

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[++i] ?? '';
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(USAGE);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  const store = new Store(DATA_DIR);
  try {
    switch (cmd) {
      case 'create':
        console.log(JSON.stringify(store.create({
          width: Number(flags.width),
          depth: Number(flags.depth),
          seed: flags.seed === undefined ? 0 : Number(flags.seed),
        }), null, 2));
        break;
      case 'list':
        console.log(JSON.stringify(store.list(), null, 2));
        break;
      case 'add':
        console.log(JSON.stringify(store.addBatch(Number(positional[0]), [
          { key: flags.key ?? '', weight: flags.weight },
        ]), null, 2));
        break;
      case 'add-batch': {
        const items = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
        console.log(JSON.stringify(store.addBatch(Number(positional[0]), items), null, 2));
        break;
      }
      case 'query':
        console.log(JSON.stringify(store.query(Number(positional[0]), flags.key ?? ''), null, 2));
        break;
      case 'explain':
        console.log(JSON.stringify(store.explain(Number(positional[0]), flags.key ?? ''), null, 2));
        break;
      case 'cells':
        console.log(JSON.stringify(store.cells(
          Number(positional[0]),
          Number(flags.row ?? 0),
          Number(flags.offset ?? 0),
          Number(flags.limit ?? 64),
        ), null, 2));
        break;
      case 'merge':
        console.log(JSON.stringify(store.merge(Number(positional[0]), Number(positional[1])), null, 2));
        break;
      case 'export': {
        const state = store.exportState(Number(positional[0]));
        const text = JSON.stringify(state, null, 2);
        if (flags.file) fs.writeFileSync(flags.file, text);
        else console.log(text);
        break;
      }
      case 'import': {
        const state = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
        console.log(JSON.stringify(store.importState(state), null, 2));
        break;
      }
      case 'history':
        console.log(JSON.stringify(store.history(Number(positional[0]), Number(flags.limit ?? 50)), null, 2));
        break;
      default:
        console.error(`unknown command: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof CmsError) {
      console.error(JSON.stringify({ error: { code: err.code, message: err.message } }));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    store.close();
  }
}

main();
