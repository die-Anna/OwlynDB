-- Testdaten für OwlynDB (MySQL); wird von npm run test:drivers eingespielt
DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop CHARACTER SET utf8mb4;
USE shop;
SET SESSION cte_max_recursion_depth = 10000;

CREATE TABLE kunden (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  ort VARCHAR(60) NULL,
  erstellt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aktiv TINYINT(1) NOT NULL DEFAULT 1,
  guthaben DECIMAL(10,2) NULL COMMENT 'in CHF',
  notiz TEXT NULL,
  avatar VARBINARY(16) NULL,
  UNIQUE KEY uq_kunden_name (name),
  KEY ix_kunden_ort (ort)
);

CREATE TABLE bestellungen (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kunde_id INT NOT NULL,
  datum DATE NOT NULL,
  betrag DECIMAL(12,2) NOT NULL,
  status ENUM('offen','bezahlt','storniert') NOT NULL DEFAULT 'offen',
  CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id) REFERENCES kunden (id)
);

INSERT INTO kunden (name, ort, erstellt, aktiv, guthaben, notiz, avatar)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
SELECT CONCAT('Kunde ', LPAD(i, 4, '0')),
       ELT(1 + i % 5, 'Zürich', 'Bern', 'Basel', 'Luzern', NULL),
       TIMESTAMP('2024-01-01 08:00:00') + INTERVAL i HOUR,
       i % 7 <> 0,
       CASE WHEN i % 11 = 0 THEN NULL ELSE ROUND(i * 1.37, 2) END,
       CASE WHEN i = 42 THEN 'Sonderfall: 100% Rabatt_test' ELSE NULL END,
       CASE WHEN i % 100 = 0 THEN UNHEX('DEADBEEF') ELSE NULL END
  FROM n;

INSERT INTO bestellungen (kunde_id, datum, betrag, status)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
SELECT 1 + i % 2500, DATE('2025-01-01') + INTERVAL i % 365 DAY, ROUND(10 + (i % 97) * 3.5, 2),
       ELT(1 + i % 3, 'offen', 'bezahlt', 'storniert')
  FROM n;

CREATE VIEW v_umsatz AS
SELECT k.ort, COUNT(*) AS bestellungen, SUM(b.betrag) AS summe
  FROM bestellungen b JOIN kunden k ON k.id = b.kunde_id
 GROUP BY k.ort;

DELIMITER //
CREATE PROCEDURE kunden_von(IN p_ort VARCHAR(60))
BEGIN
  SELECT id, name FROM kunden WHERE ort = p_ort ORDER BY id LIMIT 5;
  SELECT COUNT(*) AS anzahl FROM kunden WHERE ort = p_ort;
END //
DELIMITER ;
