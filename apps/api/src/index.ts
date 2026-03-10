import { createBenchMemoServer } from './server.js';

const port = parsePort(process.env.PORT);
const host = process.env.HOST ?? '127.0.0.1';

const { server } = createBenchMemoServer();

server.listen(port, host, () => {
  console.log(`BenchMemo API listening on http://${host}:${port}`);
});

function parsePort(value: string | undefined) {
  if (!value) {
    return 3000;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return port;
}
