-- Testdaten für OwlynDB (SQL Server); wird von npm run test:drivers eingespielt
IF DB_ID('shop') IS NOT NULL
BEGIN
  ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE shop;
END
GO
CREATE DATABASE shop;
GO
USE shop;
GO
CREATE SCHEMA verkauf;
GO
CREATE TABLE dbo.kunden (
  id int IDENTITY(1,1) NOT NULL CONSTRAINT pk_kunden PRIMARY KEY,
  name nvarchar(100) NOT NULL CONSTRAINT uq_kunden_name UNIQUE,
  ort nvarchar(60) NULL,
  erstellt datetime2(0) NOT NULL CONSTRAINT df_kunden_erstellt DEFAULT SYSDATETIME(),
  aktiv bit NOT NULL CONSTRAINT df_kunden_aktiv DEFAULT 1,
  guthaben decimal(10,2) NULL,
  notiz nvarchar(max) NULL,
  avatar varbinary(16) NULL,
  geburtstag date NULL
);
CREATE INDEX ix_kunden_ort ON dbo.kunden (ort);

CREATE TABLE dbo.bestellungen (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_bestellungen PRIMARY KEY,
  kunde_id int NOT NULL CONSTRAINT fk_best_kunde REFERENCES dbo.kunden (id),
  datum date NOT NULL,
  betrag decimal(12,2) NOT NULL CONSTRAINT ck_betrag CHECK (betrag >= 0),
  status varchar(20) NOT NULL CONSTRAINT df_best_status DEFAULT 'offen'
);

WITH n AS (SELECT TOP (2500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
             FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.kunden (name, ort, erstellt, aktiv, guthaben, notiz, avatar, geburtstag)
SELECT N'Kunde ' + RIGHT('0000' + CAST(i AS varchar(4)), 4),
       CHOOSE(1 + i % 5, N'Zürich', N'Bern', N'Basel', N'Luzern', NULL),
       DATEADD(hour, i, '2024-01-01T08:00:00'),
       CASE WHEN i % 7 = 0 THEN 0 ELSE 1 END,
       CASE WHEN i % 11 = 0 THEN NULL ELSE ROUND(i * 1.37, 2) END,
       CASE WHEN i = 42 THEN N'Sonderfall: 100% Rabatt_test' END,
       CASE WHEN i % 100 = 0 THEN 0xDEADBEEF END,
       DATEADD(day, i, '1970-01-01')
  FROM n;

WITH n AS (SELECT TOP (6000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
             FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.bestellungen (kunde_id, datum, betrag, status)
SELECT 1 + i % 2500, DATEADD(day, i % 365, '2025-01-01'), ROUND(10 + (i % 97) * 3.5, 2),
       CHOOSE(1 + i % 3, 'offen', 'bezahlt', 'storniert')
  FROM n;

CREATE TABLE verkauf.regionen (code char(2) NOT NULL PRIMARY KEY, name nvarchar(50) NOT NULL);
INSERT INTO verkauf.regionen VALUES ('ZH', N'Zürich'), ('BE', N'Bern');
GO
CREATE VIEW dbo.v_umsatz AS
SELECT k.ort, COUNT(*) AS bestellungen, SUM(b.betrag) AS summe
  FROM dbo.bestellungen b JOIN dbo.kunden k ON k.id = b.kunde_id
 GROUP BY k.ort;
GO
CREATE PROCEDURE dbo.kunden_von @ort nvarchar(60) AS
BEGIN
  SET NOCOUNT ON;
  PRINT N'Suche Kunden in ' + @ort;
  SELECT TOP (5) id, name FROM dbo.kunden WHERE ort = @ort ORDER BY id;
  SELECT COUNT(*) AS anzahl FROM dbo.kunden WHERE ort = @ort;
END;
GO
