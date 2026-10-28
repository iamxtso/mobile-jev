import https from 'node:https';
import http from 'node:http';

const modelAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const loopbackAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

// A model request has no side effect: it only reads a decision, and nothing has touched the device
// yet. So it is safe to repeat, unlike a device mutation. A refusal (4xx) is our own bug and is not
// repeated; a busy service (429, 5xx) or a broken connection is, briefly.
const RETRYABLE = (status) => status === 429 || status >= 500;
const ATTEMPTS = 3;

function retryable(error) {
  error.retryable = true;
  return error;
}

// Keep the TypeSafe TLS connection warm across decisions (ADB-only backend).
export async function pooledRequest(options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(options, attempt);
    } catch (error) {
      if (!error.retryable || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
}

function requestOnce({ url, apiKey, method = 'GET', body, timeoutMs = 30_000 }, attempt) {
  const target = new URL(url);
  const loopback = target.protocol === 'http:' && target.hostname === '127.0.0.1';
  if ((target.protocol !== 'https:' && !loopback) || target.username || target.password)
    throw new Error('Model API requires HTTPS.');
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('A valid API key is required.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let dns = 0,
      connected = 0,
      secure = 0,
      ready = 0;
    const elapsed = () => performance.now() - started;
    const req = (loopback ? http : https).request(
      target,
      {
        agent: loopback ? loopbackAgent : modelAgent,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Images are off by default and the API refuses a request that carries one without this
          // acknowledgement. Only a request that really sends an image opts in.
          ...(body?.assets ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const firstByte = elapsed();
        const chunks = [];
        let length = 0;
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > 20 * 1024 * 1024) req.destroy(new Error('Response too large'));
          else chunks.push(chunk);
        });
        res.on('error', () => {
          clearTimeout(timer);
          reject(retryable(new Error('Model response interrupted; no action executed.')));
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Name the refusal without repeating the body: it can echo the credential. Structured
            // codes and the failing question name are what a 400 or 422 needs to be debuggable.
            let detail = '';
            try {
              const { error } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const fields = [
                error?.code,
                error?.reason,
                error?.question && `question=${error.question}`,
              ];
              detail = fields.filter((field) => typeof field === 'string' && field).join(' ');
            } catch {
              // Not JSON: say nothing about the body.
            }
            const failure = new Error(
              `Model API returned HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}`,
            );
            reject(RETRYABLE(res.statusCode) ? retryable(failure) : failure);
            return;
          }
          const wall = elapsed(),
            round = (n) => Math.round(n * 10) / 10;
          const bytes = Buffer.concat(chunks);
          Object.defineProperty(bytes, 'timing', {
            value: {
              wallMs: round(wall),
              dnsMs: round(dns),
              tcpMs: round(connected - dns),
              tlsMs: round(secure - connected),
              responseWaitMs: round(Math.max(0, firstByte - ready)),
              downloadMs: round(wall - firstByte),
              totalMs: round(wall),
              reusedConnection: req.reusedSocket,
              httpVersion: res.httpVersion,
              status: res.statusCode,
              attempts: attempt,
            },
          });
          resolve(bytes);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('socket', (socket) => {
      if (!socket.connecting) {
        ready = elapsed();
        return;
      }
      socket.once('lookup', () => {
        dns = elapsed();
      });
      socket.once('connect', () => {
        connected = elapsed();
        if (loopback) {
          secure = connected;
          ready = connected;
        }
      });
      socket.once('secureConnect', () => {
        secure = elapsed();
        ready = secure;
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      reject(retryable(new Error('Model API transport failed; no action executed.')));
    });
    req.end(payload);
  });
}

export function decodeJson(bytes) {
  if (!bytes.length) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('API returned invalid JSON.');
  }
}
