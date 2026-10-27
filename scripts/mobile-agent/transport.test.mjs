import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pooledRequest, decodeJson } from './http.mjs';
import { measuredRequest, summarizeMetrics } from './metrics.mjs';

test('model transport reuses connections, preserves JSON, and retries only what is safe to repeat', async (t) => {
  let connections = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ path: req.url, body });
    if (req.url === '/slow') return;
    if (req.url === '/busy') {
      // Busy once, then fine: the retry is what makes a free endpoint usable.
      if (requests.filter((entry) => entry.path === '/busy').length === 1) {
        res.writeHead(503);
        res.end('{"error":{"code":"overloaded"}}');
        return;
      }
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/error') {
      res.writeHead(401);
      res.end('never print this credential');
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('connection', () => {
    connections++;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = {
    url: base,
    apiKey: 'test-only',
    method: 'POST',
    body: { text: '日本語\n"quoted"' },
  };
  const first = await pooledRequest(input),
    second = await pooledRequest(input);
  assert.equal(connections, 1);
  assert.equal(first.timing.reusedConnection, false);
  assert.equal(second.timing.reusedConnection, true);
  assert.deepEqual(decodeJson(second), { ok: true });
  assert.deepEqual(JSON.parse(requests[0].body), input.body);
  assert.ok(second.timing.wallMs >= 0);
  assert.equal(second.timing.tlsMs, 0);
  // A refusal is our own mistake: repeating it would only repeat the bug.
  await assert.rejects(
    pooledRequest({ ...input, url: base + '/error' }),
    (e) => /401/.test(e.message) && !e.message.includes('credential'),
  );
  assert.equal(requests.filter((r) => r.path === '/error').length, 1);
  // A busy service is not: nothing was decided, so the request is repeated and then succeeds.
  const retried = await pooledRequest({ ...input, url: base + '/busy' });
  assert.deepEqual(decodeJson(retried), { ok: true });
  assert.equal(retried.timing.attempts, 2);
  // A dead connection is repeated a bounded number of times, then reported.
  await assert.rejects(
    pooledRequest({ ...input, url: base + '/slow', timeoutMs: 30 }),
    /transport failed/,
  );
  assert.equal(requests.filter((r) => r.path === '/slow').length, 3);
});

test('metrics aggregate by endpoint, include failures, and exclude payloads and credentials', async () => {
  const metrics = [];
  const request = measuredRequest({
    service: 'test',
    metrics,
    request: async (input) => {
      if (input.method === 'POST') throw new Error('failed');
      return Buffer.alloc(0);
    },
  });
  await request({
    url: 'https://example.test/devices/private-id/ui-state',
    apiKey: 'secret',
    body: { private: 'text' },
  });
  await assert.rejects(
    request({ url: 'https://example.test/devices/private-id/ui-state', method: 'POST' }),
  );
  const serialized = JSON.stringify(metrics);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('private'), false);
  assert.equal(summarizeMetrics(metrics).find((g) => g.endpoint.includes('POST')).failures, 1);
});
