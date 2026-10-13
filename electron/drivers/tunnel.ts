import net from 'node:net';
import tls from 'node:tls';
import type { DriverConfig, TlsMaterial } from './common';

/**
 * TLS ab dem ersten Byte: für Proxys (nginx stream, HAProxy, stunnel …), die das Client-Zertifikat
 * prüfen und danach das unveränderte Datenbank-Protokoll weiterreichen.
 */
export function tunnelOptions(host: string, port: number, t: TlsMaterial | undefined, servername?: string): tls.ConnectionOptions {
  return {
    host,
    port,
    // SNI: eigener Name (z. B. wenn der Proxy per IP erreicht wird), sonst der Host – aber keine IP-Adresse
    servername: servername?.trim() || (net.isIP(host) ? undefined : host),
    ca: t?.ca,
    cert: t?.cert,
    key: t?.key,
    passphrase: t?.passphrase,
    rejectUnauthorized: !!t?.verifyServer,
    ...(t?.verifyHostname ? {} : { checkServerIdentity: () => undefined }),
  };
}

function dbTunnel(cfg: DriverConfig): tls.ConnectionOptions {
  return tunnelOptions(cfg.host, cfg.port, cfg.tls, cfg.servername);
}

/** Socket sofort zurückgeben; Schreibvorgänge puffert TLS bis zum Ende des Handshakes (mysql2, pg). */
export function openTunnel(cfg: DriverConfig): tls.TLSSocket {
  const s = tls.connect(dbTunnel(cfg));
  // wie bei der direkten Verbindung: still verworfene Verbindungen nach einer halben Minute Leerlauf bemerken
  s.setKeepAlive(true, 30_000);
  return s;
}

/** Für pg: es ruft selbst noch connect(port, host) auf – der Tunnel ist dann schon unterwegs. */
export function openTunnelForPg(cfg: DriverConfig): tls.TLSSocket {
  const s = openTunnel(cfg);
  (s as unknown as { connect: () => tls.TLSSocket }).connect = () => s;
  return s;
}

/** Für tedious (options.connector): erst nach erfolgreichem Handshake zurückgeben. */
export function connectTunnel(cfg: DriverConfig, signal?: AbortSignal, timeoutMs = 0): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect(dbTunnel(cfg));
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (e: Error) => {
      cleanup();
      s.destroy();
      reject(e);
    };
    // Abbruch von außen (tedious: connectionTimeout) und eigene Frist: ein hängender Handshake blockierte sonst für immer
    const onAbort = () => fail(new Error('Verbindungsaufbau abgebrochen.'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => fail(new Error(`TLS-Handshake nach ${timeoutMs / 1000} s nicht abgeschlossen.`)), timeoutMs);
    s.once('error', fail);
    s.once('secureConnect', () => {
      cleanup();
      s.off('error', fail);
      resolve(s);
    });
  });
}
