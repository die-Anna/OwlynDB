import { execFileSync } from 'node:child_process';

/**
 * Die Tests löschen und verändern Daten (Seeds mit DROP DATABASE, UPDATE auf Testtabellen).
 * Sie laufen deshalb nur, wenn jeder Zielport zu einem Container des Compose-Projekts dbviewer-test gehört.
 */
export function assertTestContainers(targets: { name: string; host: string; port: number }[]): void {
  let ports = '';
  try {
    // mit Frist: hängt der Docker-Dienst, blieb der Test sonst ohne jede Meldung stehen
    ports = execFileSync('docker', ['ps', '--filter', 'label=com.docker.compose.project=dbviewer-test', '--format', '{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (e as { signal?: string }).signal ? 'docker ps antwortet nicht (Frist 20 s)' : 'docker ps nicht möglich';
    throw new Error(`${why} – Test abgebrochen, damit er keinen falschen Server trifft.`);
  }
  for (const t of targets) {
    if (!['127.0.0.1', 'localhost'].includes(t.host) || !ports.includes(`:${t.port}->`)) {
      throw new Error(`${t.name}: ${t.host}:${t.port} gehört nicht zu den Test-Containern (dbviewer-test) – Test abgebrochen.`);
    }
  }
}
