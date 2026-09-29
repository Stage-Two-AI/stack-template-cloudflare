# Doorsteek Cloudflare-proef: draaiboek en uitkomst

Dit is het draaiboek én het rapport van de live doorsteek (U7 en U8 in het plan
`docs/plans/2026-09-27-1712-feat-cloudflare-stack-proef-plan.md` in `Stage-Two-AI/Stack`).
De uitkomsten vul je in terwijl je de stappen doorloopt.

## Stand op 27-09-2026

**De live doorsteek is nog niet gedraaid.** De code staat klaar en is getest tegen een
nagebootste Cloudflare, Supabase en GitHub (`pnpm beheer:test`), maar de voorwaarden
P1 tot en met P4 uit `beheer/README.md` ontbreken nog:

| Voorwaarde | Stand 27-09 |
|---|---|
| P1 Zero Trust aan, one-time PIN toegevoegd | open: de huidige sleutel kan de Zero Trust-organisatie niet lezen |
| P2 proefsleutel en twee uitrolsleutels | open: `~/.cloudflare-proef.env` bestaat niet |
| P3 ruimte voor een Supabase-project | lijkt in orde: organisatie "Stage Two" heeft finance actief en "Main" gepauzeerd |
| P4 Supabase- en GitHub-sleutels in `proef-beheer` | open |

Dus: **nog geen ja of nee op de keten Cloudflare naar Supabase.** Dat blijft de
belangrijkste open vraag van de proef.

## Stand op 29-09-2026

- Voorwaarden P1 tot en met P4 zijn rond, op het nieuwe Cloudflare-account van Stage Two
  (teamnaam `stagetwo`, workers.dev-subdomein `stagetwotemp`). Sleutels met de nieuwe
  Workers-rechten (Editor, alle Workers) werken.
- Droogloop en inrichting zijn geslaagd. Supabase aanvaardt Access for SaaS als
  `custom:cloudflare`. Het pooler-adres komt automatisch uit de Management API.
- Gevonden: een net aangemaakte SaaS-app geeft een paar minuten 404 op het
  discovery-adres ("Application is not an OIDC application"). De inrichting wacht daar
  nu op (PR #5).
- Koppeltest voorbereid: wachtwoordgebruiker `info@stagetwo.nl` in project `jdglffjwhkjbpyrwecbm`.
- Eerste uitrol en tweede doorgang geslaagd (29-09). Uitrollen vroeg naast Workers
  (Editor) ook het legacy-recht Workers Scripts: Edit; zonder dat weigert Cloudflare het
  aanmaken van de Worker en de upload.
- Koppeltest geslaagd, maar pas na `mailer_autoconfirm: true` (PR #8): Cloudflare zet
  geen `email_verified`, en `attribute_mapping` mag dat veld niet zetten (PR #7 teruggedraaid).
- **Antwoord op de hoofdvraag: de keten Cloudflare naar Supabase werkt**, inclusief
  koppeling aan een bestaande gebruiker. Open: AE3/AE4 (toegang geven en intrekken) en
  de test met Google Workspace als inlogdienst (verwacht: één inlog in plaats van twee codes).

## Draaiboek

Doe het in deze volgorde. Na elke stap: uitkomst en bewijs in de tabel hieronder.

1. **Voorwaarden.** P1 tot en met P4 uit `beheer/README.md`. Maak daarbij de
   GitHub-omgevingen `proef-beheer`, `production` en `preview` aan, alle drie beperkt tot
   `main`. Voor `preview` kan dat, omdat alleen `preview-uitrollen.yml` (altijd de versie
   van `main`) die omgeving gebruikt; de PR-job bouwt zonder sleutels. Zet daarnaast de
   repo-variabelen `PREVIEW_VITE_*` uit `beheer/README.md`, anders komt er geen preview.
2. **Droogloop.** `gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=true`.
   Controleer in het logboek de geplande stappen, met name de redirect-lijst: daarin mag op
   de plek van het workers.dev-subdomein geen `*` staan.
3. **Inrichten.** Dezelfde workflow met `droogloop=false`. Bewaar de regel `INRICHTING`.
   Stopt het script op een veldnaam van de API, zoek dan de plek met `NAGAAN (U7)` in
   `beheer/lib/` en stel hem bij (zie "Open API-punten").
4. **Eerste uitrol.** Een lege commit of kleine wijziging via een PR naar `main` mergen.
   De workflow `Uitrollen` zet de app op `cf-proef.stagetwotemp.workers.dev` (tijdelijke stand; het domein stagetwo.nl staat in een ander Cloudflare-account).
5. **Tweede doorgang, alleen nodig in de standaardstand.** `... -f tweede_doorgang=true`:
   Access op de Worker zelf, zodat ook de versie- en preview-adressen dicht zitten. In de
   tijdelijke stand (zoals deze proef) zette stap 3 al een placeholder-Worker met de
   Access erop neer; de eerste uitrol overschrijft de placeholder en staat meteen
   achter de deur. Controleer wel dat de Access-app `cf-proef-cf-proef-worker` bestaat.
6. **Tabel zonder grant (voor AE8).** In de SQL-editor van het proefproject:
   `create table public.proef_zonder_grant (id int); revoke all on public.proef_zonder_grant from anon, authenticated;`
   Dit is bewust geen migratie: de template zelf eist RLS en grants op elke tabel.
7. **Koppeltest (R16, voor finance).** Maak in het proefproject een bevestigde
   wachtwoordgebruiker aan met `info@stagetwo.nl`, zoals in finance. Noteer zijn
   `id`. Log daarna in via `https://cf-proef.stagetwotemp.workers.dev` (AE1). Blijft het `id` van de
   ingelogde gebruiker gelijk en komt er geen tweede rij in `auth.users`, dan werkt de
   koppeling. Zo niet, dan is het antwoord voor finance "nee" tot dat is opgelost.
8. **Geautomatiseerde controles.** Vanaf claudecode:
   ```sh
   SUPABASE_ANON_KEY=<anon> node beheer/controle-doorsteek.mjs \
     --hostname cf-proef.stagetwotemp.workers.dev --project-ref <ref> \
     --workers-dev https://cf-proef.<subdomein>.workers.dev/ \
     --versie-url <versie-adres van de huidige productieversie> \
     --preview-url <previewlink uit een PR>
   ```
   Het script drukt een tabel af die je hieronder kunt plakken.
9. **Het id_token bekijken.** Log in en kijk in `auth.users.raw_user_meta_data` en
   `auth.identities` wat Cloudflare meestuurde: staat `email_verified` erin? Was de nonce
   een probleem? Noteer het bij "Open API-punten".
10. **Toegang geven en intrekken (AE3).** Voeg een tweede adres toe aan
    `beheer/toegang.json` via een PR, merge, en laat die persoon inloggen. Haal het adres
    daarna weer weg. Controleer dat zijn sessie niet meer ververst en dat de Data API met
    zijn oude token niets meer teruggeeft.
11. **Werkt de keten niet:** draai het vangnet (`-f vangnet=true`), en test AE1 en AE2
    opnieuw. Probeer daarbij rechtstreeks `/auth/v1/otp` (met aanmaken aan) en
    `/auth/v1/signup` met een adres dat niet in `toegang.json` staat: dat moet geen
    gebruiker en geen sessie opleveren.
12. **Meten.** Laadtijd van de startpagina en van de eerste regel gegevens, naast finance
    op Vercel. Maandkosten op basis van de gebruikte plannen.

## Uitkomst per acceptatievoorbeeld

| AE | Wat | Hoe | Uitkomst | Bewijs |
|---|---|---|---|---|
| AE1 | Piet logt één keer in en ziet alleen zijn rijen | stap 7, met de hand | geslaagd, met kanttekening | 29-09: inloggen met info@stagetwo.nl komt in de app. Met alleen One-time PIN vraagt Access twee codes (deur en inlogdienst); met een echte IdP naar verwachting één. |
| AE2 | Jan komt niet binnen, ook niet via de inlogroute van Supabase | stap 8, script | geslaagd | controle-doorsteek.mjs 29-09: app en /auth/v1/authorize sturen allebei naar de Access-login |
| AE3 | toegang via PR; bij KienIA alleen door IT te mergen | stap 10 | open | |
| AE4 | ander domein krijgt geen toegang | stap 10, met een adres buiten de groep | open | |
| AE5 | preview vraagt om inloggen en toont de testbalk | stap 8, script, en met de hand | geslaagd (inloggen) | PR #9: link pr-9-cf-proef.stagetwotemp.workers.dev kwam als reactie in de PR en stuurt naar de Access-login |
| AE5 | preview ziet andere gegevens dan productie | niet in deze proef: één Supabase-project (KTD9), volgt in U9 | niet aangetoond | |
| AE6 | geen omweg via workers.dev of versie-adressen | stap 8, script | geslaagd | workers.dev-adres en versie-adres 2bf5b77a-… sturen naar de Access-login |
| AE7 | Edge Functions en Hermes ongemoeid | geen Edge Functions in de proefapp; het script raakt ze niet (getest) | open | |
| AE8 | tabel zonder grant onbereikbaar | stap 6 en 8 | geslaagd | proef_zonder_grant via de Data API: 401 |
| AE9 | bestaande gebruiker houdt zijn gegevens | stap 7, koppeltest | geslaagd | wachtwoordgebruiker d8d4970d-… kreeg identiteit custom:cloudflare erbij; geen tweede rij in auth.users |

## Metingen

| Wat | Cloudflare-proef | finance op Vercel |
|---|---|---|
| Startpagina geladen | open | open |
| Eerste regel gegevens | open | open |
| Kosten per maand | Workers gratis tot 100.000 verzoeken per dag, anders $5; Access gratis tot 50 gebruikers | Vercel Pro $20 per gebruiker |

## Open API-punten

Deze veldnamen staan in de code met `NAGAAN (U7)`: ze komen uit één bron of zijn niet
nagekeken. De eerste echte run laat zien of ze kloppen.

- Cloudflare: `destinations` naast `domain` op een self-hosted app; `grant_types` van de
  SaaS-app (mogelijk `authorization_code_with_pkce`); `allow_pkce_without_client_secret`;
  de velden `client_id` en `client_secret` in het antwoord (het geheim komt alleen bij
  aanmaken terug); het issuer-formaat; of een bestemming `*-<worker>.<sub>.workers.dev`
  geaccepteerd wordt; de vorm van de policy-regels; policies als `{id, precedence}`.
- Supabase: `uri_allow_list` als één tekst met komma's; de namen van de hook-velden en de
  vorm `pg-functions://postgres/public/<fn>`; `organization_slug`; of de provider-naam
  met of zonder `custom:` moet; of het verwijderen uit `auth.sessions` ook de
  refresh-tokens ongeldig maakt.
- Bekende bugs in Supabase custom OIDC: supabase/auth #2519 ("missing provider id" na
  login) en #2623 (client secret URL-gecodeerd bij het token-endpoint).

## Opruimen

De doorsteek blijft staan tot Christijn dit rapport gelezen heeft. Daarna:

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f opruimen=true
```

Dat verwijdert alles met het voorvoegsel `cf-proef-`, in omgekeerde volgorde, en laat
alles zonder dat voorvoegsel staan. Staat de Worker nog live, dan waarschuwt het script:
zonder Access staat de site dan open, dus verwijder ook de Worker (`cf-proef`) of rol hem
terug.

## Wat dit betekent voor U9 en U10

- **U9 (template vastleggen)** begint pas als AE1, AE2, AE6 en AE9 zijn geslaagd.
- **U10 (finance)** hangt aan de koppeltest van stap 7. Werkt die niet, dan eerst
  uitzoeken hoe Supabase een Cloudflare-login aan een bestaande gebruiker koppelt,
  voordat finance ook maar iets verandert.
- Een echte testdatabase per app (AE5, tweede deel) hoort bij U9, of bij een betaald
  Supabase-plan.
- Restrisico, ook na de proef: de uitrolsleutel van de preview kan technisch ook
  productie overschrijven, want Cloudflare kent geen sleutel die alleen previews mag.
  Code uit een PR ziet hem niet meer: alleen `preview-uitrollen.yml` op `main` gebruikt
  hem, en die draait niets uit de PR. Wie op `main` mag schrijven, kan hem wel misbruiken.
