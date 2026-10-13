# Mitmachen

Issues und Pull Requests sind willkommen – auf Deutsch oder Englisch. Code, Kommentare, Oberfläche und Dokumentation sind
Deutsch; Änderungen am Programm sollten dabei bleiben, die Beschreibung des Pull Requests darf Englisch sein.

## Issues

- Fehler: Version bzw. Commit, Datenbanktyp und -version, was du getan hast, was passiert ist und was du erwartet hast.
  Keine echten Zugangsdaten, Hostnamen oder Kundendaten in Meldungen, Logs oder Screenshots.
- Wünsche: kurz beschreiben, was du erreichen willst – OwlynDB soll beim Ansehen und Abfragen schlank bleiben.
  Was bewusst fehlt, steht am Ende von [TODO.md](TODO.md).
- **Sicherheitslücken nicht hier melden**, sondern privat, siehe [SECURITY.md](SECURITY.md).

## Bauen und testen

Voraussetzungen, Bauen und Tests stehen im [README](README.md), Abschnitte „Starten“ und „Entwicklung“. Kurz:

```bash
npm install
cd ui && npm install && cd ..
npm run test:unit        # reine Logik, ohne Datenbank und ohne Docker
npm run testdb:up        # Test-Datenbanken (Docker), danach: npm test
```

Bitte vor einem Pull Request `npm run test:unit` (und, wo es die Änderung betrifft, die passende Suite gegen die Test-Datenbanken)
laufen lassen. Neues Verhalten bekommt einen Test; ein behobener Fehler einen Test, der ohne die Korrektur scheitert.

## Pull Requests

- Eine Änderung je Commit, Beschreibung auf Deutsch: die erste Zeile sagt kurz, was sich ändert; darunter, warum.
- Kein Sammel-Commit aus Umbenennung, Formatierung und Fehlerbehebung – das lässt sich schlecht prüfen.
- Bestehenden Stil beibehalten (TypeScript, deutsche Kommentare, kurze Funktionen), keine neuen Abhängigkeiten ohne Grund.
- Bei Änderungen an Nur-lesen-Wächter, Schreibzugriffen (Bearbeiten, Einspielen, Sitzungen beenden) oder Zertifikatsprüfung:
  den Test dazu erweitern und im Pull Request kurz sagen, was geschützt bleibt.

## Lizenz

Es gibt kein CLA und kein DCO. Mit einem Beitrag stimmst du zu, dass er unter der [MIT-Lizenz](LICENSE) des Projekts steht.
Das Logo ist davon ausgenommen (siehe README, Abschnitt „Lizenz“).
