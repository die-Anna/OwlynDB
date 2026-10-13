CREATE USER certuser PASSWORD 'certpass';
CREATE TABLE public.geheim (id int PRIMARY KEY, text text);
INSERT INTO public.geheim VALUES (1, 'nur mit Zertifikat');
GRANT SELECT ON public.geheim TO certuser;
