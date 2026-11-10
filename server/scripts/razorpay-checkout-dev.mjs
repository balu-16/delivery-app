import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/checkout.js': ['checkout.js', 'text/javascript; charset=utf-8'],
};
const root = resolve('devtools/razorpay-checkout');
createServer(async (req, res) => {
  const entry = req.method === 'GET' && files[req.url];
  if (!entry) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(resolve(root, entry[0]));
    res
      .writeHead(200, {
        'content-type': entry[1],
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .end(body);
  } catch {
    res.writeHead(500).end();
  }
}).listen(5173, '127.0.0.1', () => console.log('Test checkout: http://localhost:5173'));
