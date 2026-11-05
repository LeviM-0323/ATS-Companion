import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import QRCode from 'qrcode';

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, { error: { code, message } });
}

function hasValidToken(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

async function readJsonBody(request, response) {
  let serialized = '';
  for await (const chunk of request) {
    serialized += chunk;
    if (serialized.length > 4096) {
      sendError(response, 413, 'payload_too_large', 'Pairing request is too large.');
      return null;
    }
  }
  try {
    return JSON.parse(serialized);
  } catch {
    sendError(response, 400, 'invalid_json', 'Pairing request must be valid JSON.');
    return null;
  }
}

function createSetupPage({ pairing, bridgeUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>ATS Companion Bridge</title>
  <style>
    :root{color-scheme:dark;font:16px system-ui,sans-serif;background:#0b1015;color:#f3f5f6}
    body{max-width:680px;margin:0 auto;padding:32px 20px}
    main{background:#151d25;border:1px solid #25313b;border-radius:20px;padding:24px}
    h1{font-size:25px;margin:0 0 8px}p{color:#bdc6cc;line-height:1.55}
    code{color:#f3a444;overflow-wrap:anywhere}
    img{display:block;width:min(78vw,320px);height:auto;margin:24px auto;background:#fff;padding:12px;border-radius:12px}
    button{min-height:48px;width:100%;border:0;border-radius:12px;background:#f3a444;color:#17120b;font-weight:800;font-size:15px}
    .code{font:800 27px ui-monospace,monospace;text-align:center;letter-spacing:5px;color:#f3a444}
    .muted{font-size:13px;color:#9ba8b2}.warning{font-size:12px;color:#f3c887;margin-top:24px}
  </style>
</head>
<body>
  <main>
    <h1>ATS Companion Bridge</h1>
    <p>Scan this code in ATS Companion while your phone is on the same trusted Wi-Fi network.</p>
    <p>Bridge address: <code>${escapeHtml(bridgeUrl)}</code></p>
    <img id="qr" src="${pairing.qr}" alt="One-time pairing QR code">
    <p class="code" id="code">${pairing.code}</p>
    <p class="muted" id="expires">This one-time code expires in 5 minutes.</p>
    <button id="refresh" type="button">Generate a new pairing code</button>
    <p class="warning">The QR contains a one-time pairing code, not a permanent device credential. Keep this page private and do not expose the bridge port to the internet.</p>
  </main>
  <script>
    const qr = document.getElementById('qr');
    const code = document.getElementById('code');
    const refresh = document.getElementById('refresh');
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const response = await fetch('/api/v1/pairing/code', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not generate a pairing code.');
        const pairing = await response.json();
        qr.src = pairing.qr;
        code.textContent = pairing.code;
      } catch {
        document.getElementById('expires').textContent = 'Could not refresh the code. Reload this page and try again.';
      } finally {
        refresh.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export function createBridgeServer({
  token,
  deviceRegistry,
  snapshotProvider,
  bridgeUrl,
  pairingRateLimit = 10,
  pairingWindowMs = 60_000,
  now = Date.now,
} = {}) {
  if (!deviceRegistry && !token) throw new Error('A device registry or pairing token is required.');
  const attempts = new Map();

  const authorizedDevice = (request) =>
    deviceRegistry
      ? deviceRegistry.authenticate(request.headers.authorization)
      : hasValidToken(request, token);
  const allowedMethods = new Map([
    ['/health', ['GET']],
    ['/setup', ['GET']],
    ['/api/v1/pairing/code', ['GET']],
    ['/api/v1/pair', ['POST']],
    ['/api/v1/pairing', ['DELETE']],
    ['/api/v1/snapshot', ['GET']],
  ]);

  const issuePairing = async (request, response) => {
    if (!deviceRegistry) {
      sendError(response, 503, 'pairing_unavailable', 'Device pairing is not configured.');
      return;
    }
    if (!isLoopback(request.socket.remoteAddress)) {
      sendError(response, 403, 'local_setup_only', 'Generate pairing codes from the bridge PC.');
      return;
    }
    if (!bridgeUrl) {
      sendError(response, 503, 'bridge_address_unavailable', 'No local bridge address is available.');
      return;
    }
    const code = deviceRegistry.issueCode();
    const pairingPayload = JSON.stringify({ version: 1, bridgeUrl, code: code.code });
    const qr = await QRCode.toDataURL(pairingPayload, { errorCorrectionLevel: 'M', margin: 2 });
    sendJson(response, 200, { ...code, bridgeUrl, qr });
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const allowed = allowedMethods.get(url.pathname);
    if (!allowed) {
      sendError(response, 404, 'not_found', 'Route not found.');
      return;
    }
    if (!allowed.includes(request.method)) {
      response.setHeader('Allow', allowed.join(', '));
      sendError(response, 405, 'method_not_allowed', 'The requested method is not allowed.');
      return;
    }
    if (url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/setup') {
      if (!isLoopback(request.socket.remoteAddress)) {
        sendError(response, 403, 'local_setup_only', 'Open the setup page on the bridge PC.');
        return;
      }
      if (!deviceRegistry || !bridgeUrl) {
        sendError(response, 503, 'pairing_unavailable', 'Device pairing is not configured.');
        return;
      }
      try {
        const pairing = deviceRegistry.issueCode();
        pairing.qr = await QRCode.toDataURL(
          JSON.stringify({ version: 1, bridgeUrl, code: pairing.code }),
          { errorCorrectionLevel: 'M', margin: 2 },
        );
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(createSetupPage({ pairing, bridgeUrl }));
      } catch (error) {
        console.error('Could not create the pairing page:', error);
        sendError(response, 500, 'pairing_page_failed', 'The pairing page could not be created.');
      }
      return;
    }

    if (url.pathname === '/api/v1/pairing/code') {
      try {
        await issuePairing(request, response);
      } catch (error) {
        console.error('Could not issue a pairing code:', error);
        sendError(response, 500, 'pairing_code_failed', 'A pairing code could not be generated.');
      }
      return;
    }

    if (url.pathname === '/api/v1/pair') {
      const source = request.socket.remoteAddress ?? 'unknown';
      const attemptsForSource = attempts.get(source) ?? [];
      const recentAttempts = attemptsForSource.filter((time) => now() - time < pairingWindowMs);
      if (recentAttempts.length >= pairingRateLimit) {
        attempts.set(source, recentAttempts);
        sendError(response, 429, 'pairing_rate_limited', 'Too many pairing attempts. Wait a minute and try again.');
        return;
      }
      recentAttempts.push(now());
      attempts.set(source, recentAttempts);

      const body = await readJsonBody(request, response);
      if (!body) return;
      if (typeof body.code !== 'string' || body.code.length > 32) {
        sendError(response, 400, 'invalid_pairing_code', 'Enter the one-time pairing code.');
        return;
      }
      try {
        const pairedDevice = await deviceRegistry?.pair(body.code, body.name);
        if (!pairedDevice) {
          sendError(response, 400, 'invalid_pairing_code', 'The pairing code is invalid or expired.');
          return;
        }
        sendJson(response, 201, pairedDevice);
      } catch (error) {
        console.error('Could not save paired device:', error);
        sendError(response, 500, 'pairing_failed', 'The device could not be paired.');
      }
      return;
    }

    if (url.pathname === '/api/v1/pairing') {
      if (!deviceRegistry) {
        sendError(response, 503, 'pairing_unavailable', 'Device pairing is not configured.');
        return;
      }
      try {
        if (!(await deviceRegistry.revoke(request.headers.authorization))) {
          sendError(response, 401, 'unauthorized', 'This device is not paired.');
          return;
        }
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
      } catch (error) {
        console.error('Could not revoke paired device:', error);
        sendError(response, 500, 'revocation_failed', 'The device could not be disconnected.');
      }
      return;
    }

    if (url.pathname === '/api/v1/snapshot') {
      if (!authorizedDevice(request)) {
        sendError(response, 401, 'unauthorized', 'Pair this device with the bridge to read telemetry.');
        return;
      }
      if (!snapshotProvider) {
        sendError(response, 503, 'telemetry_unavailable', 'No ATS telemetry source is connected.');
        return;
      }
      try {
        const snapshot = await snapshotProvider();
        if (!snapshot) {
          sendError(response, 503, 'telemetry_unavailable', 'Waiting for a fresh ATS telemetry snapshot.');
          return;
        }
        sendJson(response, 200, snapshot);
      } catch (error) {
        console.error('Telemetry provider failed:', error);
        sendError(response, 502, 'telemetry_read_failed', 'The telemetry source could not be read.');
      }
      return;
    }

  });
}
