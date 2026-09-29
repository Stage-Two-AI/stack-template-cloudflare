# beheer/: inrichting van de Cloudflare-proef

Deze map hoort alleen bij de proef. Hij gaat niet mee naar afgeleide apps
(`nietMeenemen` in `.claude/stack-manifest.json`) en verhuist in U9 naar `stack-beheer`.

Wat erin zit:

| Bestand | Wat het doet |
|---|---|
| `inrichten-cloudflare.mjs` | het script: inrichten, tweede doorgang, vangnet, toegang bijwerken, opruimen |
| `lib/cloudflare.mjs` | Access-policies, Access-apps, workers.dev-subdomein |
| `lib/supabase.mjs` | project, sleutels, auth-config, custom provider `custom:cloudflare` |
| `lib/toegang.mjs` | `toegang.json` controleren, vertalen naar policies, intrekken, vangnet-SQL |
| `toegang.json` | wie bij welke app mag |
| `*.test.mjs`, `nep-wolk.mjs` | tests tegen een nagebootste API (`pnpm beheer:test`) |

Alles wat het script aanmaakt heeft een naam die begint met `cf-proef-`. Wat al bestaat
met dat voorvoegsel wordt hergebruikt. Bestaat er iets met dezelfde naam zónder
voorvoegsel, of staat er al een andere Access-app op de hostname, dan stopt het script
voordat het iets wijzigt.

## Voorwaarden (door Christijn)

- **P1.** Zero Trust aan op het Cloudflare-account (gratis plan, teamnaam kiezen). Onder
  Integrations > Identity providers de inlogmethode one-time PIN toevoegen.
- **P2.** Een Cloudflare-API-sleutel met: Workers Scripts bewerken, Workers Routes en DNS
  bewerken op de zone `stagetwo.nl`, Access: Apps and Policies bewerken, Access:
  Organizations, Identity Providers and Groups lezen. Bewaren als `CLOUDFLARE_PROEF_TOKEN`
  in `~/.cloudflare-proef.env` en als secret in de GitHub-omgeving `proef-beheer`.
  Daarnaast twee smalle sleutels met alleen Workers Scripts bewerken: één als
  `CLOUDFLARE_API_TOKEN` in omgeving `production`, één in omgeving `preview`.
- **P3.** Bevestigen dat er in de Supabase-organisatie "Stage Two" ruimte is voor één
  actief project naast finance.
- **P4.** In omgeving `proef-beheer` de secrets `SUPABASE_ACCESS_TOKEN` (Management API),
  `SUPABASE_ORG_SLUG` en `BEHEER_GH_TOKEN`: een fijnmazige sleutel (of GitHub App) met
  schrijfrechten op secrets, variabelen en omgevingen van deze repo. De gewone
  `GITHUB_TOKEN` mag geen secrets of variabelen zetten.

Verder in omgeving `proef-beheer`, als variabelen (geen secrets):

| Variabele | Waarde |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | het account-id |
| `CLOUDFLARE_TEAM_DOMAIN` | de teamnaam uit P1, bijvoorbeeld `stagetwo` of `stagetwo.cloudflareaccess.com` |
| `CLOUDFLARE_IDP_IDS` | optioneel: id's van de toegestane inlogmethoden, met komma's. Leeg = alleen one-time PIN |
| `CLOUDFLARE_GROEPEN_IDP` | optioneel: `azureAD:<id>` als een groep `idp_groepen` gebruikt |

Beperk de omgevingen `proef-beheer`, `production` en `preview` tot de tak `main`
(Settings > Environments > Deployment branches). Dat kan ook voor `preview`, omdat de
preview in twee delen gaat: de PR-job in `uitrollen.yml` bouwt zonder omgeving en
zonder sleutels, en `preview-uitrollen.yml` uploadt het resultaat vanaf `main`. De
omgevingen `production` en `preview` moeten bestaan voordat de inrichting draait; het
script maakt ze niet aan.

De PR-job leest de openbare waarden van de test als repo-variabelen (geen secrets, ze
staan toch in de bundel): `PREVIEW_VITE_SUPABASE_URL`, `PREVIEW_VITE_SUPABASE_ANON_KEY`,
`PREVIEW_VITE_INLOGDIENST` en optioneel `PREVIEW_VITE_SUPABASE_SCHEMA` en
`PREVIEW_VITE_SENTRY_DSN`. Ontbreekt `PREVIEW_VITE_SUPABASE_URL` bij een app met
database, dan meldt de PR-job dat en komt er geen preview.

Voor `deploy-db.yml` is ook het repo-secret `SUPABASE_ACCESS_TOKEN` nodig. Dat zet het
script niet; zet het zelf als de migraties mee moeten draaien.

## De workflows draaien

Beide workflows draaien alleen vanaf `main` en nooit op een pull request.

**Proef inrichten** (`proef-inrichten.yml`), onder Actions > Proef inrichten > Run
workflow, of vanaf de terminal:

```sh
# 1. eerst kijken wat er zou gebeuren (de standaard)
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=true

# 2. echt inrichten
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false

# 3. na de eerste uitrol vanaf main: Access op de Worker zelf
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f tweede_doorgang=true
```

Stap 3 zit ook in elke gewone run: zolang er nog niet is uitgerold meldt het script
"nog niet uitgerold" en slaat hij de stap over.

Het resultaat staat in het logboek als één regel die begint met `INRICHTING`. Geheimen
staan daar nooit leesbaar in.

**Vangnet** (als de keten Cloudflare naar Supabase niet werkt): e-mail-inlog weer aan,
met een hook die alleen de domeinen en adressen uit `toegang.json` toelaat, en
`VITE_INLOGDIENST=mailcode`. Daarna een nieuwe uitrol vanaf `main`.

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f vangnet=true
```

**Proef toegang bijwerken** (`proef-toegang.yml`) draait vanzelf als `toegang.json` op
`main` verandert. Hij zet de policies gelijk aan het bestand, hangt ze aan de
Access-apps en trekt de toegang in van wie er niet meer in staat: een ban en afmelden
van alle sessies in Supabase.

## toegang.json

```json
{
  "groepen": {
    "kantoor": { "domeinen": ["klant.nl"], "uitsluiten": ["oud@klant.nl"] },
    "it": { "adressen": ["it@klant.nl"], "idp_groepen": ["<groeps-id in Entra>"] }
  },
  "apps": { "cf-proef": ["kantoor", "it"] }
}
```

Een groep zonder domeinen, adressen of IdP-groepen, een app zonder groep en een app met
een onbekende groep worden geweigerd; de melding noemt groep en veld.

## Alleen IT mag toegang.json wijzigen (bij een klant)

`.github/CODEOWNERS` wijst `/beheer/toegang.json` aan een eigenaar toe. Op zichzelf
blokkeert dat niets. Zo maakt de klant de review verplicht:

1. Vervang in `.github/CODEOWNERS` `@StageTwoAI` op de regel van `toegang.json` door het
   IT-team van de klant, bijvoorbeeld `@klant-org/it`.
2. Settings > Rules > Rulesets > New branch ruleset, doel: de standaardtak (`main`).
3. Zet aan: "Require a pull request before merging" en daaronder "Require review from
   Code Owners".
4. Bypass-lijst leeg laten, ruleset op Active.

Vanaf dan kan een wijziging aan `toegang.json` alleen gemerged worden met een
goedkeuring van IT. Andere bestanden hebben geen eigenaar met verplichte review, dus
de rest van het werk loopt gewoon door.

## Opruimen

Verwijdert alles met het voorvoegsel `cf-proef-`, in omgekeerde volgorde: Access op de
Worker, de GitHub-variabelen en -secrets die het script zette, de Access-app op de
hostname, de custom provider, de SaaS-app, de policies en als laatste het
Supabase-project. Alles zonder voorvoegsel blijft staan. Eerst kijken:

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=true -f opruimen=true
```

Dan echt:

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f opruimen=true
```

De Worker `cf-proef` zelf en zijn eigen-domeinroute horen bij wrangler en blijven
staan; het script waarschuwt als hij nog uitgerold is. Verwijder hem daarna in het
Cloudflare-dashboard (Workers & Pages > cf-proef > Settings > Delete).

## Lokaal testen

```sh
pnpm beheer:test
```

De tests praten met een nagebootste Cloudflare, Supabase en GitHub; er gaat niets
over het netwerk.
