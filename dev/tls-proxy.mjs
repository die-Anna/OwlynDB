// TLS-Proxy wie nginx stream / HAProxy mit Client-Zertifikatspflicht (nur für Tests).
// Erwartet TLS ab dem ersten Byte, prüft das Client-Zertifikat gegen dev/certs/ca.crt
// und reicht danach den Datenstrom unverändert an die Datenbank weiter.
//
//   node dev/tls-proxy.mjs 15326=127.0.0.1:15306 15452=127.0.0.1:15432 15453=127.0.0.1:15433
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs');
const read = (f) => readFileSync(path.join(certs, f));

/** Startet einen Proxy; seen sammelt die CNs angenommener Clients. */
export function startProxy(listenPort, targetHost, targetPort, seen = []) {
  const server = tls.createServer(
    { cert: read('server.crt'), key: read('server.key'), ca: read('ca.crt'), requestCert: true, rejectUnauthorized: true },
    (client) => {
      const cn = client.getPeerCertificate()?.subject?.CN ?? '?';
      seen.push(cn);
      const db = net.connect(targetPort, targetHost);
      client.pipe(db).pipe(client);
      const close = () => {
        client.destroy();
        db.destroy();
      };
      client.on('error', close);
      db.on('error', close);
    },
  );
  server.on('tlsClientError', (e) => {
    if (process.env.PROXY_LOG) console.log(`[proxy ${listenPort}] abgelehnt: ${e.message}`);
  });
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.env.PROXY_LOG = '1';
  for (const arg of process.argv.slice(2)) {
    const [listen, target] = arg.split('=');
    const [host, port] = target.split(':');
    await startProxy(Number(listen), host, Number(port));
    console.log(`TLS-Proxy 127.0.0.1:${listen} -> ${target} (Client-Zertifikat Pflicht)`);
  }
}
