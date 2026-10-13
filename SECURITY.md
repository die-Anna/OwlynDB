# Sicherheit

## Schwachstellen melden

Sicherheitslücken bitte **nicht** als öffentliches Issue oder Pull Request melden. Der Weg ist die private Meldung über die
GitHub-„Security Advisories“ des Repositorys `die-Anna/OwlynDB`: Reiter *Security* → *Report a vulnerability*
(<https://github.com/die-Anna/OwlynDB/security/advisories/new>). Ist dieser Weg nicht verfügbar, bitte ein Issue ohne technische
Einzelheiten eröffnen und darin um einen privaten Kontakt bitten.

Hilfreich sind: betroffene Version bzw. Commit, Datenbanktyp und -version, Schritte zum Nachstellen und die Auswirkung. OwlynDB wird
von einer einzelnen Person betreut; eine Antwort kommt so bald wie möglich, eine feste Frist gibt es nicht.

## Unterstützte Versionen

Unterstützt wird nur der aktuelle Stand von `main`. Behoben wird dort; es gibt keine Pflege älterer Versionen.

## Was OwlynDB tut – und was nicht

- **Passwörter** (Datenbank, Schlüssel-Passphrase, SSH) liegen verschlüsselt im Profil (`%APPDATA%\OwlynDB\connections.json`),
  über Windows DPAPI (Electron `safeStorage`). Sie sind an Windows-Benutzer und PC gebunden. Das schützt nicht vor Schadsoftware
  oder anderen Programmen, die unter demselben Windows-Benutzer laufen.
- **Alles andere im Profil ist Klartext:** Verbindungsdaten (Host, Benutzer, Pfade zu Zertifikaten und Schlüsseln), gespeicherte
  Abfragen und der Abfrage-Verlauf (mit SQL samt Werten). Zertifikats- und Schlüsseldateien bleiben, wo sie sind; OwlynDB speichert nur den Pfad.
- **Einstellungs-Export:** Passwörter gehen nur mit einem Export-Passwort mit (scrypt + AES-256-GCM); ohne Export-Passwort bleiben sie draußen.
- **Der Nur-lesen-Modus und die Prüfungen vor `DELETE`/`DROP` sind kein Sicherheitsmerkmal gegen böswillige Nutzer.** Sie schützen
  vor Versehen: eine Prüfung vor dem Senden plus eine Transaktion, die immer zurückgerollt wird. Was ein Rollback nicht zurückholt
  (z. B. Sequenzen), fängt nur die erste Schicht ab. Dicht ist nur ein Datenbankbenutzer, der nur lesen darf – so sollte man
  ihn dort einsetzen, wo nur gelesen werden soll.
- Die Oberfläche läuft im Electron-Renderer mit `contextIsolation` und `sandbox`; Datenbankzugriffe, Dateien und Netzwerk liegen im Hauptprozess.
- Die `.exe`-Dateien sind nicht signiert (SmartScreen zeigt „Unbekannter Herausgeber“).

## English summary

Please report vulnerabilities privately through GitHub "Security Advisories" of the repository `die-Anna/OwlynDB`
(*Security* tab → *Report a vulnerability*), not as public issues or pull requests (if that is not available, open an issue without technical details and ask for a private
contact). Only the current `main` is supported.
Stored database, key-passphrase and SSH passwords are encrypted with Windows DPAPI and bound to the Windows user and machine; they do
not protect against malware running as the same user. Connection details, saved queries and the query history are stored as plain
text in the profile. The read-only mode and the confirmation prompts guard against mistakes, not against a malicious user – use a
database account that can only read wherever only reading is intended. This is a one-person project; replies come as time allows, without a fixed deadline.
