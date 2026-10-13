# OwlynDB – TODO

Vorschläge aus dem Vergleich mit dbForge Studio (06.10.2026), gemessen am Hauptzweck: Tabellen ansehen und Abfragen schreiben.
Vorgeschlagene Reihenfolge: 2 → 4 → 3 → 1 → 6 → 7, danach 8 – alle erledigt (07.10.2026), ebenso 5 und 9 bis 15 – die Liste ist abgearbeitet.

## Passt zum Hauptzweck

1. [x] **Daten im Grid bearbeiten** – Zelle ändern, Zeile einfügen/löschen. Vor dem Speichern die erzeugten UPDATE/INSERT/DELETE
       zeigen, alles in einer Transaktion. Gesperrt bei „Nur lesen“ und bei Tabellen ohne Primärschlüssel. (2–3 Tage)
2. [x] **Fremdschlüsseln folgen** (Master-Detail) – Klick auf z. B. `kunde_id` öffnet den Kunden; umgekehrt „Bestellungen dieses
       Kunden“. (½–1 Tag)
3. [x] **Abfrage-Verlauf und gespeicherte Abfragen** – alles Ausgeführte je Verbindung durchsuchbar; häufige Abfragen als
       Snippets. (1 Tag)
4. [x] **SQL formatieren** (Umschalt+Alt+F) – fertige Bibliothek für alle drei SQL-Varianten. (½ Tag)
5. [x] **Ausführungsplan** – EXPLAIN / Plan lesbar als Baum, teure Schritte markiert. (1–2 Tage)
6. [x] **Prozeduren, Funktionen, Trigger im Baum** – ansehen, DDL öffnen, im Editor bearbeiten. (1 Tag)
7. [x] **Objektsuche** über alle Datenbanken einer Verbindung – Tabellen, Spalten, Prozeduren nach Namen; der Baum-Filter
       findet nur bereits Geladenes. (½–1 Tag)

## Für die Arbeit mit Prod und Test

8. [x] **Schema-Vergleich** zweier Datenbanken mit Abgleich-Skript (nur anzeigen, nicht automatisch ausführen). (2–3 Tage)
9. [x] **Datenbank direkt kopieren** – Dump und Einspielen in einem Schritt, ohne Datei. (½ Tag)
10. [x] **Laufende Abfragen/Sitzungen** des Servers anzeigen, mit Abbrechen (bei „Nur lesen“ nur Anzeige). (1 Tag)
11. [x] **ER-Diagramm** zum Ansehen – Tabellen und Fremdschlüssel automatisch angeordnet. (1–2 Tage)
12. [x] **Datenvergleich** zweier Tabellen – neue, fehlende, geänderte Zeilen. (2 Tage)
13. [x] **Test-Datenbank aus Prod** (Wunsch 07.10.2026) – Teil-Dump bzw. Teil-Kopie: je Tabelle nur ein Ausschnitt (z. B. die letzten
        N Zeilen nach Schlüssel oder Datum, oder eine WHERE-Bedingung), samt den Zeilen, auf die sie per Fremdschlüssel verweisen –
        sonst passt die Test-DB nicht zusammen. Baut auf Dump/Kopieren (9) auf. (1–2 Tage)
        Ausbaustufe **Anonymisierung**: je Spalte eine Regel (Name, E-Mail, Telefon, IBAN, Adresse, Freitext leeren …), Vorschlag
        anhand der Spaltennamen; Ersatzwerte gleichbleibend (gleicher Wert → gleicher Ersatz, damit Verknüpfungen und Suchen
        weiter passen). Wichtig für Personendaten aus Prod (Datenschutz). (1–2 Tage)
14. [x] **Einstellungen exportieren/importieren** (Wunsch 07.10.2026) – Verbindungen (mit Farben, TLS-/SSH-Einstellungen),
        gespeicherte Abfragen, wahlweise Verlauf, als eine Datei. Passwörter sind über Windows (DPAPI) an Benutzer und Rechner
        gebunden und gehen so nicht mit: entweder weglassen (beim Import neu eingeben) oder mit einem Export-Passwort
        verschlüsselt mitnehmen; Zertifikats- und Schlüsseldateien nur als Pfad. Import zusammenführen statt überschreiben
        (gleiche Verbindung erkennen, nachfragen). (½–1 Tag)
15. [x] **Elasticsearch-Anbindung prüfen** (Wunsch 07.10.2026) – passt zum Ansehen und Abfragen: Indizes als „Tabellen“, Mapping
        als Spalten, Dokumente in der Tabellenansicht; Abfragen über die SQL-API (`POST _sql`, auch in der kostenlosen
        Basic-Lizenz) oder ES|QL, dazu Query-DSL als JSON. Kein SQL-Server im bisherigen Sinn – Dump, Schema-Vergleich, Bearbeiten
        und Plan fallen weg; eher ein eigener Treiber mit Schwerpunkt Lesen. Zuerst klären: Versionen und Lizenz der eigenen
        Instanzen, Anmeldung (API-Key, Benutzer, TLS), welche Abfragen gebraucht werden. (Prüfung ½ Tag, Grundfunktionen 2–3 Tage)
        Geklärt 07.10.2026: Ziel ist ein Elasticsearch-Dev-Cluster ohne Anmeldung hinter SSH; SQL und Kibana-Konsole,
        kein ES|QL; nur lesen; Version beim Verbinden erkennen (getestet 7.17, 8.10, 9.5); Anmeldung ohne, Benutzer, API-Key,
        HTTPS mit Zertifikaten.

## Kleinere offene Punkte

Erledigt 07.10.2026 (Details im README):

- [x] Streaming für sehr große Abfrage-Ergebnisse – Zeilen einzeln verarbeitet, über „max. Zeilen“ hinaus nur gezählt; MySQL/MariaDB
      hören per `sql_select_limit` von selbst auf, PostgreSQL per Cursor, SQL Server bricht eine einzelne lesende Abfrage ab
- [x] Export eines Abfrage-Ergebnisses über „max. Zeilen“ hinaus – die (nur lesende) Anweisung läuft im Tab noch einmal als Stream
- [x] SQL Server, Plan mit Laufzeit: das Ergebnis wird nur noch durchgereicht, nicht gesammelt (übertragen wird es weiterhin, wie in SSMS)
- [x] Binärwerte: bis 1 KB ganz angezeigt; längere vollständig über den Export mit erneuter Ausführung
- [x] Test-DB aus Prod: Regel „abhängige Zeilen“ (z. B. die Positionen der gewählten Bestellungen); Anonymisieren auch für Zahlenspalten
- [x] Datenvergleich: Skript als Datei ohne Obergrenze, danach im Ziel einspielen; ganzes Schema auf einmal (Übersicht, Skript in
      Fremdschlüssel-Reihenfolge), auch aus dem Schema-Vergleich heraus
- [x] Elasticsearch: Blättern über Treffer 10 000 hinaus (Point-in-Time und search_after, letzte Seiten von hinten)
- [x] Elasticsearch: Zahl im Baum ohne verschachtelte Dokumente (Aggregation nach `_index` über alle Indizes)
- [x] Grid: „Keine Zeilen“ statt „No Rows To Show“
- [x] Dump: Prozeduren, Funktionen, Trigger (gehört zu Punkt 6)
- [x] SQL Server: in Batches mit mehreren Anweisungen wird die letzte Ergebnismenge nach „max. Zeilen“ abgebrochen (lesender Batch,
      danach keine Anweisung mehr, keine Schleife/Cursor). Frühere Ergebnisse kommen weiter ganz: ein Abbruch beendete den ganzen
      Batch, und `SET ROWCOUNT` griffe auch in Funktionen (im Test zählte `COUNT(*)` über eine Tabellenwert-Funktion falsch)
- [x] Datenvergleich ganzes Schema: Schlüsselspalten je Tabelle in der Übersicht wählen (auch „alle Spalten“), gelten auch fürs Skript
- [x] Einspielen in MySQL: einzelne INSERT/UPDATE/DELETE gebündelt in Transaktionen (Testserver 0,9 statt 11 ms je Anweisung),
      solange die Datei keine eigene führt; bei einem Fehler bleibt wie bisher, was davor lief

Offen:

- [ ] .exe gegen eine echte Umgebung mit HAProxy und SSH-Tunnel testen (nur die Maintainerin)
- [ ] Einspielen bei MySQL/PostgreSQL: jede Anweisung ist ein eigener Round-Trip (lokal ~0,9 ms; ein Abgleich-Skript mit 20 000 Zeilen
      braucht so ~17 s, über eine entfernte Verbindung entsprechend länger) – mehrere Anweisungen je Round-Trip senden

## Bewusst weggelassen

Debugger, Unit-Tests, Testdaten-Generator, Berichtsdesigner, Pivot-Tabellen, Benutzer-/Rechteverwaltung, Index-Manager,
Backup-Planung, Event-Profiler, Versionsverwaltung, Kommandozeile/DevOps, Dokumentations-Generator, KI-Assistent –
viel Aufwand, kaum Nutzen fürs Ansehen und Abfragen, oder Admin-Aufgaben, die in einem Prod-Lesewerkzeug riskant sind.
