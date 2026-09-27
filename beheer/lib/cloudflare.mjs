/**
 * De Cloudflare-kant van de inrichting: herbruikbare Access-policies, de Access-apps
 * (deur, inlogdienst en de Worker zelf) en een paar gegevens van het account.
 *
 * Alles wat dit script maakt heeft een naam die begint met VOORVOEGSEL. Daaraan
 * herkent een volgende run wat van hem is (hergebruiken) en wat niet (afblijven), en
 * daaraan herkent --opruimen wat weg mag. Op dit account draaien ook KienIA-Workers en
 * de eigen apps van Stage Two; alles zonder voorvoegsel is van iemand anders.
 *
 * Veldnamen van de API: waar een naam uit maar één bron komt of nog niet tegen de
 * echte API is getest, staat `NAGAAN (U7)` erbij. De live doorsteek (U7) bevestigt ze.
 */
import { vraag } from "./vraag.mjs";

export const VOORVOEGSEL = "cf-proef-";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const PER_PAGINA = 100;

/** De namen van alles wat bij één app hoort. */
export function appNamen(app) {
  return {
    deur: `${VOORVOEGSEL}${app}`,
    inlog: `${VOORVOEGSEL}${app}-inlog`,
    worker: `${VOORVOEGSEL}${app}-worker`,
    project: `${VOORVOEGSEL}${app}`,
  };
}

/** "stagetwo", "stagetwo.cloudflareaccess.com" of een volledige URL: altijd de host. */
export function normaliseerTeamDomein(waarde) {
  const kaal = String(waarde ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!kaal) return null;
  const host = kaal.includes(".") ? kaal : `${kaal}.cloudflareaccess.com`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(host)) {
    throw new Error(`CLOUDFLARE_TEAM_DOMAIN "${waarde}" is geen <team>.cloudflareaccess.com`);
  }
  return host.toLowerCase();
}

/**
 * De issuer van een OIDC-SaaS-app. NAGAAN (U7): het formaat komt uit de documentatie
 * van Access for SaaS (OIDC); de API geeft hem mogelijk ook zelf terug in `saas_app`.
 */
export function issuerVoor(teamDomein, clientId) {
  return `https://${normaliseerTeamDomein(teamDomein)}/cdn-cgi/access/sso/oidc/${clientId}`;
}

function policyLijst(policyIds) {
  if (!Array.isArray(policyIds) || policyIds.length === 0 || policyIds.some((id) => !id)) {
    throw new Error("een Access-app zonder policies laat niemand toe; er ontbreekt een policy-id");
  }
  return policyIds.map((id, i) => ({ id, precedence: i + 1 }));
}

function inlogmethoden(idps) {
  if (!Array.isArray(idps) || idps.length === 0) {
    throw new Error(
      "de lijst toegestane inlogmethoden (allowed_idps) is leeg; zet er expliciet die van de klant in (proef: one-time PIN)",
    );
  }
  return {
    allowed_idps: [...idps],
    // Eén methode: meteen doorsturen in plaats van een keuzescherm met één knop.
    auto_redirect_to_identity: idps.length === 1,
  };
}

/** De deur: een self-hosted Access-app op het eigen domein van de app. */
export function deurApp({ naam, hostname, policyIds, idps }) {
  return {
    name: naam,
    type: "self_hosted",
    domain: hostname,
    // NAGAAN (U7): `destinations` naast `domain`; nieuwere API-versies gebruiken alleen destinations.
    destinations: [{ type: "public", uri: hostname }],
    app_launcher_visible: false,
    session_duration: "24h",
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
  };
}

/**
 * De inlogdienst: een SaaS-app van het type OIDC, met als enige redirect het
 * callback-adres van het Supabase-project.
 *
 * NAGAAN (U7): `grant_types: ["authorization_code"]` met PKCE van de kant van Supabase.
 * Cloudflare kent ook `authorization_code_with_pkce`; als de code-challenge van
 * Supabase geweigerd wordt, is dat de waarde. `allow_pkce_without_client_secret` blijft
 * uit: Supabase is een vertrouwelijke client met een eigen geheim.
 */
export function inlogApp({ naam, callback, policyIds, idps }) {
  return {
    name: naam,
    type: "saas",
    app_launcher_visible: false,
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
    saas_app: {
      auth_type: "oidc",
      redirect_uris: [callback],
      grant_types: ["authorization_code"],
      scopes: ["openid", "email", "profile", "groups"],
      allow_pkce_without_client_secret: false,
    },
  };
}

/**
 * Access op de Worker zelf: dekt het workers.dev-adres en alle versie- en
 * preview-adressen (`<alias>-<worker>.<subdomein>.workers.dev`). Dit is wat de knop
 * "Cloudflare Access" bij een Worker in het dashboard aanmaakt. NAGAAN (U7): of een
 * wildcard vooraan in het eerste label als destination wordt geaccepteerd.
 */
export function workerApp({ naam, worker, subdomein, policyIds, idps }) {
  if (!subdomein || subdomein.includes("*")) throw new Error("het workers.dev-subdomein ontbreekt");
  const basis = `${worker}.${subdomein}.workers.dev`;
  return {
    name: naam,
    type: "self_hosted",
    domain: basis,
    destinations: [
      { type: "public", uri: basis },
      { type: "public", uri: `*-${basis}` },
    ],
    app_launcher_visible: false,
    session_duration: "24h",
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
  };
}

/** Velden die de API zelf bijhoudt en die niet terug horen in een PUT. */
const ALLEEN_LEZEN = ["id", "uid", "aud", "created_at", "updated_at", "scim_config"];

/**
 * De body voor het bijwerken van een bestaande app met andere policies. NAGAAN (U7):
 * dat een PUT met de gelezen velden (zonder client_secret bij een SaaS-app) het geheim
 * en de client_id ongemoeid laat.
 */
export function metPolicies(app, policyIds) {
  const body = { ...app };
  for (const veld of ALLEEN_LEZEN) delete body[veld];
  if (body.saas_app) {
    body.saas_app = { ...body.saas_app };
    delete body.saas_app.client_secret;
  }
  return { ...body, policies: policyLijst(policyIds) };
}

export function policyIdsVanApp(app) {
  return (app?.policies ?? []).map((p) => (typeof p === "string" ? p : p.id));
}

export function cloudflareClient({ fetchFn = fetch, token, accountId, teamDomein }) {
  if (!token) throw new Error("de Cloudflare-sleutel (CLOUDFLARE_PROEF_TOKEN) ontbreekt");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID ontbreekt");
  const basis = `${CLOUDFLARE_API}/accounts/${accountId}`;
  const cf = async (pad, opties) =>
    (await vraag(fetchFn, `${basis}${pad}`, { token, ...opties }))?.result;

  async function lijst(pad) {
    const alles = [];
    for (let pagina = 1; ; pagina += 1) {
      const deel = (await cf(`${pad}?page=${pagina}&per_page=${PER_PAGINA}`)) ?? [];
      alles.push(...deel);
      if (deel.length < PER_PAGINA) return alles;
    }
  }

  return {
    // Herbruikbare policies: /accounts/{id}/access/policies.
    policies: () => lijst("/access/policies"),
    maakPolicy: (body) => cf("/access/policies", { methode: "POST", body }),
    werkPolicyBij: (id, body) => cf(`/access/policies/${id}`, { methode: "PUT", body }),
    verwijderPolicy: (id) => cf(`/access/policies/${id}`, { methode: "DELETE" }),

    apps: () => lijst("/access/apps"),
    maakApp: (body) => cf("/access/apps", { methode: "POST", body }),
    werkAppBij: (id, body) => cf(`/access/apps/${id}`, { methode: "PUT", body }),
    verwijderApp: (id) => cf(`/access/apps/${id}`, { methode: "DELETE" }),

    identiteitsdiensten: () => lijst("/access/identity_providers"),

    /**
     * Het teamdomein. Liefst meegegeven (CLOUDFLARE_TEAM_DOMAIN): een smalle sleutel kan
     * de organisatie niet altijd lezen. NAGAAN (U7): het veld `auth_domain`.
     */
    async teamDomein() {
      if (teamDomein) return normaliseerTeamDomein(teamDomein);
      const org = await cf("/access/organizations");
      const domein = normaliseerTeamDomein(org?.auth_domain);
      if (!domein) throw new Error("het teamdomein is onbekend; zet CLOUDFLARE_TEAM_DOMAIN (P1)");
      return domein;
    },

    /** Het workers.dev-subdomein van het account, bijvoorbeeld `stagetwo` in `x.stagetwo.workers.dev`. */
    async workersSubdomein() {
      const r = await cf("/workers/subdomain");
      const sub = r?.subdomain;
      if (!sub || !/^[a-z0-9-]+$/i.test(sub)) {
        throw new Error(
          "het account heeft geen workers.dev-subdomein; stel het in het dashboard in",
        );
      }
      return sub.toLowerCase();
    },

    /**
     * Bestaat de Worker al (is er al eens uitgerold)? 404 betekent nee. Het antwoord bij
     * 200 is de code van de Worker, geen JSON; daar kijken we niet naar.
     */
    async workerBestaat(naam) {
      try {
        await vraag(fetchFn, `${basis}/workers/scripts/${encodeURIComponent(naam)}`, { token });
        return true;
      } catch (fout) {
        if (fout.status === 404) return false;
        throw fout;
      }
    },
  };
}
