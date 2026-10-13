CREATE DATABASE certdb;
CREATE TABLE certdb.geheim (id int PRIMARY KEY, text varchar(50));
INSERT INTO certdb.geheim VALUES (1, 'nur mit Zertifikat');
-- Anmeldung nur mit Client-Zertifikat, das die Server-CA ausgestellt hat
CREATE USER 'certuser'@'%' IDENTIFIED BY 'certpass' REQUIRE X509;
GRANT SELECT ON certdb.* TO 'certuser'@'%';
