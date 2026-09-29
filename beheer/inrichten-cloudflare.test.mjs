import assert from "node:assert/strict";
import { test } from "node:test";
import {
  leesArgumenten,
  richtIn,
  ruimOp,
  tweedeDoorgang,
  uitvoerRegel,
  vangnet,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import { cloudflareClient, inlogApp } from "./lib/cloudflare.mjs";
import { supabaseBeheer, uriAllowList } from "./lib/supabase.mjs";
import { magAanmelden } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const TOEGANG = {
  groepen: { stagetwo: { adressen: ["aiwincoholland@gmail.com"] } },
  apps: { "cf-proef": ["stagetwo"] },
};
const ARG = {
  app: "cf-proef",
  hostname: "cf-proef.stagetwo.nl",
  worker: "cf-proef",
  repo: "Stage-Two-AI/stack-template-cloudflare",
  droogloop: false,
};
const WACHTWOORD = "GeheimDatabaseWachtwoord1234567";

function opzet(w, extra = {}) {
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "cf-token",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const supabase = supabaseBeheer({
    fetchFn: w.fetchFn,
    token: "sb-token",
    orgSlug: "stagetwo",
    slaap: async () => {},
  });
  const geheimen = [];
  return {
    cf,
    supabase,
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    toegang: TOEGANG,
    accountId: "acc",
    wachtwoord: () => WACHTWOORD,
    maskeer: (waarde) => geheimen.push(waarde),
    geheimen,
    ...extra,
  };
}

// ---------------------------------------------------------------- argumenten

test("argumenten: app verplicht, modi sluiten elkaar uit", () => {
  assert.deepEqual(leesArgumenten(["--app", "cf-proef", "--droogloop"]), {
    app: "cf-proef",
    hostname: null,
    repo: null,
    droogloop: true,
    opruimen: false,
    vangnet: false,
    tweedeDoorgang: false,
    toegang: false,
  });
  assert.throws(() => leesArgumenten(["--droogloop"]), /--app/);
  assert.throws(() => leesArgumenten(["--app", "Cf_Proef"]), /kleine letters/);
  assert.throws(() => leesArgumenten(["--app", "a", "--opruimen", "--vangnet"]), /één van/);
  assert.throws(() => leesArgumenten(["--app", "a", "--wat"]), /onbekende optie/);
  assert.equal(leesArgumenten(["--opruimen"]).opruimen, true, "opruimen kan zonder --app");
});

// ---------------------------------------------------------------- droogloop

test("droogloop: maakt niets aan en toont de volledige lijst geplande stappen", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...ARG, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.deepEqual(
    r.stappen.map((s) => s.stap),
    [
      "3.1 Supabase-project",
      "3.2 Access-policies",
      "3.2 Access SaaS-app (OIDC)",
      "3.3 custom provider custom:cloudflare",
      "3.4 auth-config",
      "3.5 Access-app op de hostname",
      "3.6 GitHub-variabelen en -secrets",
      "4 Access op de Worker",
    ],
  );
  assert.ok(r.stappen.every((s) => /gepland|bestaat al|nog niet uitgerold/.test(s.actie)));
});

// ---------------------------------------------------------------- volledige run

test("volledige run: de schrijfacties volgen de volgorde van het ontwerp", async () => {
  const w = nepWolk();
  const d = opzet(w);
  const r = await richtIn(ARG, d);
  const schrijf = w.schrijfacties();
  const ref = w.staat.projecten[0].ref;
  assert.deepEqual(schrijf.slice(0, 8), [
    "POST sb/projects",
    // het wachtwoord meteen bewaren, vóór iets anders kan mislukken
    "gh secret set SUPABASE_PROJECT_REF",
    "gh secret set SUPABASE_DB_PASSWORD",
    "POST cf/access/policies",
    "POST cf/access/apps saas",
    "admin createProvider",
    `PATCH sb/projects/${ref}/config/auth`,
    "POST cf/access/apps self_hosted",
  ]);
  assert.ok(
    schrijf.slice(8).every((s) => s.startsWith("gh ")),
    "daarna alleen nog GitHub",
  );
  assert.equal(r.stappen.at(-1).actie, "overgeslagen: nog niet uitgerold");
  assert.equal(r.supabase.ref, ref);
  assert.equal(r.issuer, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid-3");
});

test("volledige run: SaaS-app is OIDC met callback, scopes, PKCE en expliciete inlogmethoden", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  const saas = w.aanroepen.find((a) => a.methode === "POST" && a.body?.type === "saas").body;
  assert.equal(saas.name, "cf-proef-cf-proef-inlog");
  assert.equal(saas.saas_app.auth_type, "oidc");
  assert.deepEqual(saas.saas_app.redirect_uris, [`https://${ref}.supabase.co/auth/v1/callback`]);
  assert.deepEqual(saas.saas_app.scopes, ["openid", "email", "profile", "groups"]);
  assert.deepEqual(saas.saas_app.grant_types, ["authorization_code"]);
  assert.deepEqual(saas.allowed_idps, ["idp-otp"]);
  const pol = w.staat.policies.find((p) => p.name === "cf-proef-stagetwo");
  assert.deepEqual(saas.policies, [{ id: pol.id, precedence: 1 }]);
  const deur = w.aanroepen.find((a) => a.methode === "POST" && a.body?.type === "self_hosted").body;
  assert.deepEqual(deur.policies, saas.policies, "deur en inlogdienst krijgen dezelfde policies");
  assert.equal(deur.domain, "cf-proef.stagetwo.nl");
});

test("volledige run: custom provider met issuer, client_id, PKCE en scopes, via de service role", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  const maak = w.aanroepen.find((a) => a.methode === "createProvider");
  assert.equal(maak.url, `https://${ref}.supabase.co`);
  assert.equal(maak.sleutel, `geheim-sr-${ref}`);
  assert.deepEqual(maak.body, {
    provider_type: "oidc",
    identifier: "custom:cloudflare",
    name: "Cloudflare Access",
    client_id: "cid-3",
    client_secret: "geheim-cs-3",
    issuer: "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid-3",
    pkce_enabled: true,
    scopes: ["openid", "email", "profile"],
    enabled: true,
  });
});

test("auth-config: e-mail uit, disable_signup onaangeroerd, redirects zonder wildcard in het subdomein", async () => {
  const w = nepWolk({ subdomein: "stagetwo-acc" });
  await richtIn(ARG, opzet(w));
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.external_email_enabled, false);
  assert.equal("disable_signup" in patch, false);
  assert.equal(patch.site_url, "https://cf-proef.stagetwo.nl");
  assert.equal(
    patch.uri_allow_list,
    "https://cf-proef.stagetwo.nl/**,https://pr-*-cf-proef.stagetwo-acc.workers.dev/**",
  );
});

test("uri_allow_list: het account-subdomein komt uit de API en is nooit een wildcard", () => {
  const lijst = uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "acc-sub" });
  const preview = new URL(lijst[1].replace("*", "x").replace("/**", "/"));
  const labels = preview.hostname.split(".");
  assert.deepEqual(labels.slice(1), ["acc-sub", "workers", "dev"]);
  assert.throws(
    () => uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "*" }),
    /subdomein/,
  );
  assert.throws(
    () => uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "" }),
    /subdomein/,
  );
});

test("GitHub: variabelen per omgeving, secrets via stdin, niets in de argumenten", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  for (const env of ["production", "preview"]) {
    assert.deepEqual(w.staat.ghVariabelen[env], {
      VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
      VITE_SUPABASE_ANON_KEY: `anon-${ref}`,
      VITE_INLOGDIENST: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "acc",
    });
  }
  assert.deepEqual(w.staat.ghSecrets.sort(), ["SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_REF"]);
  const gh = w.aanroepen.filter((a) => a.soort === "gh");
  assert.ok(gh.every((a) => a.args.includes("--repo") && a.args.includes(ARG.repo)));
  assert.ok(
    gh.every((a) => !a.args.join(" ").includes(WACHTWOORD)),
    "geen geheim in de argumenten",
  );
  const ww = gh.find((a) => a.args[2] === "SUPABASE_DB_PASSWORD");
  assert.equal(ww.invoer, WACHTWOORD);
  assert.equal(ww.args.includes("--env"), false, "deploy-db leest repo-secrets");
});

test("tweede run met alles al aanwezig maakt niets dubbel aan", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await richtIn(ARG, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.projecten.length, 1);
  assert.equal(w.staat.apps.length, 2);
  assert.equal(w.staat.policies.length, 1);
  assert.equal(w.staat.providers.length, 1);
  assert.ok(
    r.stappen.slice(0, 7).every((s) => /hergebruikt|ongewijzigd/.test(s.actie)),
    JSON.stringify(r.stappen),
  );
});

test("een resource zonder voorvoegsel met dezelfde naam laat het script stoppen zonder wijziging", async () => {
  for (const wolk of [
    { policies: [{ id: "p", name: "stagetwo", decision: "allow", include: [] }] },
    { apps: [{ id: "a", name: "cf-proef-inlog", type: "saas" }] },
    {
      apps: [{ id: "a", name: "eigen deur", type: "self_hosted", domain: "cf-proef.stagetwo.nl" }],
    },
    {
      projecten: [
        { ref: "r", name: "cf-proef", organization_slug: "stagetwo", status: "ACTIVE_HEALTHY" },
      ],
    },
  ]) {
    const w = nepWolk(wolk);
    await assert.rejects(
      () => richtIn(ARG, opzet(w)),
      /gestopt zonder wijzigingen.*zonder voorvoegsel|gestopt zonder wijzigingen.*bewaakt/,
    );
    assert.deepEqual(w.schrijfacties(), [], JSON.stringify(wolk));
  }
});

test("een 4xx van Cloudflare bij de SaaS-app stopt vóór de Supabase-provider, met het endpoint", async () => {
  const w = nepWolk({
    faal: (methode, _pad, body) =>
      methode === "POST" && body?.type === "saas"
        ? { status: 400, message: "ongeldige saas_app" }
        : null,
  });
  await assert.rejects(
    () => richtIn(ARG, opzet(w)),
    /POST \/client\/v4\/accounts\/acc\/access\/apps gaf 400: ongeldige saas_app/,
  );
  assert.equal(
    w.aanroepen.some((a) => a.methode === "createProvider"),
    false,
  );
  assert.equal(
    w.aanroepen.some((a) => a.methode === "PATCH"),
    false,
  );
});

test("het databasewachtwoord is bewaard, ook als een latere stap mislukt", async () => {
  // Het wachtwoord van een nieuw project is alleen bij het aanmaken bekend. Mislukt een
  // latere stap, dan moet het al in GitHub staan, anders is het voorgoed weg.
  const w = nepWolk({
    faal: (methode, _pad, body) =>
      methode === "POST" && body?.type === "saas" ? { status: 400, message: "kapot" } : null,
  });
  await assert.rejects(() => richtIn(ARG, opzet(w)), /gaf 400/);
  assert.ok(w.staat.ghSecrets.includes("SUPABASE_DB_PASSWORD"));
  assert.ok(w.staat.ghSecrets.includes("SUPABASE_PROJECT_REF"));
});

test("SaaS-app: een lege lijst inlogmethoden is een fout, ook vóór er iets wordt aangemaakt", async () => {
  assert.throws(
    () =>
      inlogApp({
        naam: "x",
        callback: "https://r.supabase.co/auth/v1/callback",
        policyIds: ["p"],
        idps: [],
      }),
    /inlogmethoden/,
  );
  const w = nepWolk({ idps: [{ id: "g", type: "google", name: "Google" }] });
  await assert.rejects(() => richtIn(ARG, opzet(w)), /one-time PIN|inlogmethode/);
  assert.deepEqual(w.schrijfacties(), []);
  const w2 = nepWolk({ idps: [] });
  await richtIn({ ...ARG, droogloop: true }, opzet(w2, { idps: ["idp-entra"] }));
});

// ---------------------------------------------------------------- tweede doorgang

test("tweede doorgang zonder Worker: meldt 'nog niet uitgerold' en wijzigt niets", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await tweedeDoorgang(ARG, d);
  assert.match(r.melding, /nog niet uitgerold/);
  assert.deepEqual(w.schrijfacties(), []);
});

test("tweede doorgang met Worker: Access op workers.dev en alle preview-adressen, zelfde policies", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  const worker = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef-worker");
  const deur = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef");
  assert.ok(worker, "de eerste run zet hem al als de Worker bestaat");
  assert.deepEqual(worker.destinations, [
    { type: "public", uri: "cf-proef.stagetwo-acc.workers.dev" },
    { type: "public", uri: "*-cf-proef.stagetwo-acc.workers.dev" },
  ]);
  assert.deepEqual(worker.policies, deur.policies);
  w.aanroepen.length = 0;
  const r = await tweedeDoorgang(ARG, d);
  assert.match(r.melding, /ongewijzigd/);
  assert.deepEqual(w.schrijfacties(), []);
});

// ---------------------------------------------------------------- tijdelijke stand (workers.dev)

const TIJDELIJK = { ...ARG, hostname: null, stand: "tijdelijk" };
const WORKERS_DEV = "cf-proef.stagetwo-acc.workers.dev";

test("tijdelijke stand: alleen de Access op de Worker, geen app op een hostname", async () => {
  const w = nepWolk({ workerBestaat: true });
  const r = await richtIn(TIJDELIJK, opzet(w));
  const selfHosted = w.staat.apps.filter((a) => a.type === "self_hosted");
  assert.deepEqual(
    selfHosted.map((a) => a.name),
    ["cf-proef-cf-proef-worker"],
    "geen deur op een hostname, wel Access op de Worker",
  );
  assert.deepEqual(selfHosted[0].destinations, [
    { type: "public", uri: WORKERS_DEV },
    { type: "public", uri: `*-${WORKERS_DEV}` },
  ]);
  const saas = w.staat.apps.find((a) => a.type === "saas");
  assert.deepEqual(selfHosted[0].policies, saas.policies, "zelfde policies als de inlogdienst");
  assert.equal(r.hostname, WORKERS_DEV);
  assert.equal(r.cloudflare.deur, null);
  assert.match(
    r.stappen.find((s) => s.stap === "3.5 Access-app op de hostname").actie,
    /overgeslagen: tijdelijke stand/,
  );
});

test("tijdelijke stand: site_url en redirect-lijst op het workers.dev-adres plus het previewpatroon", async () => {
  const w = nepWolk({ workerBestaat: true });
  const r = await richtIn(TIJDELIJK, opzet(w));
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.site_url, `https://${WORKERS_DEV}`);
  assert.equal(
    patch.uri_allow_list,
    `https://${WORKERS_DEV}/**,https://pr-*-cf-proef.stagetwo-acc.workers.dev/**`,
  );
  assert.deepEqual(r.uri_allow_list, patch.uri_allow_list.split(","));
});

test("tijdelijke stand: een tweede run verandert niets", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(TIJDELIJK, d);
  w.aanroepen.length = 0;
  const r = await richtIn(TIJDELIJK, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.apps.length, 2, "inlogdienst en Worker-Access, verder niets");
  assert.ok(
    r.stappen.every((s) => /hergebruikt|ongewijzigd|overgeslagen: tijdelijke stand/.test(s.actie)),
    JSON.stringify(r.stappen),
  );
});

test("tijdelijke stand zonder uitrol: waarschuwt dat workers.dev tot de tweede doorgang open staat", async () => {
  const w = nepWolk();
  const r = await richtIn(TIJDELIJK, opzet(w));
  assert.equal(w.staat.apps.filter((a) => a.type === "self_hosted").length, 0);
  assert.ok(
    r.waarschuwingen.some((x) => /--tweede-doorgang/.test(x) && x.includes(WORKERS_DEV)),
    JSON.stringify(r.waarschuwingen),
  );
});

test("tijdelijke stand: droogloop plant geen hostname-app en toont het workers.dev-adres", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...TIJDELIJK, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(
    r.stappen.find((s) => s.stap === "3.5 Access-app op de hostname").actie,
    /overgeslagen: tijdelijke stand/,
  );
  assert.match(r.stappen.find((s) => s.stap === "3.4 auth-config").actie, /workers\.dev/);
});

test("tijdelijke stand: een --hostname erbij is een fout, want er is nog geen domein", async () => {
  const w = nepWolk();
  await assert.rejects(
    () => richtIn({ ...TIJDELIJK, hostname: "app.klant.nl" }, opzet(w)),
    /tijdelijke stand.*hostname/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("tijdelijke stand: een Access-app zonder voorvoegsel op het workers.dev-adres laat het script stoppen", async () => {
  const w = nepWolk({
    workerBestaat: true,
    apps: [{ id: "a", name: "dashboardknop", type: "self_hosted", domain: WORKERS_DEV }],
  });
  await assert.rejects(() => richtIn(TIJDELIJK, opzet(w)), /gestopt zonder wijzigingen.*bewaakt/);
  assert.deepEqual(w.schrijfacties(), []);
});

test("tijdelijke stand: tweede doorgang zet Access op de Worker", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(TIJDELIJK, d);
  const w2 = nepWolk({ workerBestaat: true });
  Object.assign(w2.staat, structuredClone(w.staat));
  const d2 = opzet(w2);
  const r = await tweedeDoorgang(TIJDELIJK, d2);
  assert.equal(r.melding, "aangemaakt");
  assert.deepEqual(
    w2.staat.apps.filter((a) => a.type === "self_hosted").map((a) => a.domain),
    [WORKERS_DEV],
  );
});

// ---------------------------------------------------------------- vangnet

test("--vangnet: e-mail weer aan en een hook die jan@elders.nl weigert en piet@klant.nl toelaat", async () => {
  const w = nepWolk();
  const toegang = {
    groepen: { klant: { domeinen: ["klant.nl"] } },
    apps: { "cf-proef": ["klant"] },
  };
  const d = opzet(w, { toegang });
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await vangnet(ARG, d);
  const ref = w.staat.projecten[0].ref;
  assert.equal(w.staat.sql.length, 1);
  assert.match(w.staat.sql[0], /domein = any \(array\['klant\.nl'\]::text\[\]\)/);
  assert.doesNotMatch(w.staat.sql[0], /elders/);
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.external_email_enabled, true);
  assert.equal(patch.hook_before_user_created_enabled, true);
  assert.equal(
    patch.hook_before_user_created_uri,
    "pg-functions://postgres/public/cf_proef_voor_aanmelden",
  );
  assert.equal("disable_signup" in patch, false);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "mailcode");
  assert.equal(magAanmelden("jan@elders.nl", toegang, "cf-proef"), "nee", "JS-spiegel van de hook");
  assert.equal(magAanmelden("piet@klant.nl", toegang, "cf-proef"), "ja", "JS-spiegel van de hook");
  assert.equal(r.supabase.ref, ref);
});

// ---------------------------------------------------------------- opruimen

test("--opruimen: omgekeerde volgorde, meldt wat er stond en laat alles zonder voorvoegsel staan", async () => {
  const w = nepWolk({
    workerBestaat: true,
    policies: [{ id: "eigen-pol", name: "kienia", decision: "allow", include: [] }],
    apps: [
      { id: "eigen-app", name: "kienia-portaal", type: "self_hosted", domain: "portaal.kienia.nl" },
    ],
    projecten: [
      {
        ref: "financeref",
        name: "finance",
        organization_slug: "stagetwo",
        status: "ACTIVE_HEALTHY",
      },
    ],
    ghVariabelen: { production: { ANDERE: "blijft" } },
  });
  const d = opzet(w);
  await richtIn(ARG, d);
  const ref = w.staat.projecten.find((p) => p.name === "cf-proef-cf-proef").ref;
  w.aanroepen.length = 0;
  const r = await ruimOp({ ...ARG }, d);
  const schrijf = w.schrijfacties().filter((s) => !s.startsWith("gh "));
  assert.deepEqual(
    schrijf.map((s) => s.replace(/\/(app|pol)-\d+/, "/<id>")),
    [
      "DELETE cf/access/apps/<id>",
      "DELETE cf/access/apps/<id>",
      "admin deleteProvider",
      "DELETE cf/access/apps/<id>",
      "DELETE cf/access/policies/<id>",
      `DELETE sb/projects/${ref}`,
    ],
  );
  const volgorde = r.verwijderd.map((v) => v.soort);
  assert.deepEqual(volgorde, [
    "Access op de Worker",
    "GitHub",
    "Access-app op de hostname",
    "custom provider",
    "Access SaaS-app",
    "Access-policy",
    "Supabase-project",
  ]);
  assert.deepEqual(
    w.staat.policies.map((p) => p.id),
    ["eigen-pol"],
  );
  assert.deepEqual(
    w.staat.apps.map((a) => a.id),
    ["eigen-app"],
  );
  assert.deepEqual(
    w.staat.projecten.map((p) => p.ref),
    ["financeref"],
  );
  assert.deepEqual(w.staat.ghVariabelen.production, {
    ANDERE: "blijft",
    CLOUDFLARE_ACCOUNT_ID: "acc",
  });
  assert.deepEqual(w.staat.ghSecrets, []);
  assert.match(r.waarschuwingen.join(" "), /Worker cf-proef/);
});

test("--opruimen zonder iets met voorvoegsel doet niets", async () => {
  const w = nepWolk({
    policies: [{ id: "eigen", name: "stagetwo", decision: "allow", include: [] }],
  });
  const r = await ruimOp(ARG, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.deepEqual(r.verwijderd, []);
});

// ---------------------------------------------------------------- toegang bijwerken

test("toegang bijwerken: ongewijzigd bestand en passende gebruikers geven nul schrijfacties", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  w.staat.gebruikers.push({
    id: "11111111-1111-4111-8111-111111111111",
    email: "aiwincoholland@gmail.com",
  });
  w.aanroepen.length = 0;
  await werkToegangBij({ ...ARG }, d);
  assert.deepEqual(w.schrijfacties(), []);
});

test("toegang bijwerken: een verwijderd adres geeft een ban en afmelden via SQL", async () => {
  const w = nepWolk();
  const d = opzet(w, {
    toegang: {
      groepen: { a: { adressen: ["aiwincoholland@gmail.com", "oud@elders.nl"] } },
      apps: { "cf-proef": ["a"] },
    },
  });
  await richtIn(ARG, d);
  w.staat.gebruikers.push(
    { id: "11111111-1111-4111-8111-111111111111", email: "aiwincoholland@gmail.com" },
    { id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" },
  );
  w.aanroepen.length = 0;
  d.toegang = {
    groepen: { a: { adressen: ["aiwincoholland@gmail.com"] } },
    apps: { "cf-proef": ["a"] },
  };
  const r = await werkToegangBij(ARG, d);
  const schrijf = w.schrijfacties();
  assert.ok(schrijf.includes("admin updateUserById"));
  const ban = w.aanroepen.find((a) => a.methode === "updateUserById").body;
  assert.deepEqual(ban, { id: "22222222-2222-4222-8222-222222222222", ban_duration: "876000h" });
  assert.match(
    w.staat.sql.at(-1),
    /delete from auth\.sessions where user_id = '22222222-2222-4222-8222-222222222222'/,
  );
  assert.deepEqual(r.ingetrokken, { "cf-proef": ["oud@elders.nl"] });
});

test("toegang bijwerken: wie weer op de lijst komt, krijgt de ban opgeheven", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.staat.gebruikers.push(
    { id: "11111111-1111-4111-8111-111111111111", email: "aiwincoholland@gmail.com" },
    {
      id: "22222222-2222-4222-8222-222222222222",
      email: "oud@elders.nl",
      banned_until: "2126-01-01T00:00:00Z",
    },
  );
  d.toegang = {
    groepen: { a: { adressen: ["aiwincoholland@gmail.com", "oud@elders.nl"] } },
    apps: { "cf-proef": ["a"] },
  };
  w.aanroepen.length = 0;
  const r = await werkToegangBij(ARG, d);
  const updates = w.aanroepen.filter((a) => a.methode === "updateUserById").map((a) => a.body);
  assert.deepEqual(updates, [{ id: "22222222-2222-4222-8222-222222222222", ban_duration: "none" }]);
  assert.equal(w.staat.gebruikers[1].banned_until, undefined);
  assert.deepEqual(r.toegelaten, { "cf-proef": ["oud@elders.nl"] });
  assert.deepEqual(r.ingetrokken, {});
});

// ---------------------------------------------------------------- uitvoer en grenzen

test("toegang bijwerken: een mislukte policy-verwijdering houdt het intrekken niet tegen", async () => {
  const w = nepWolk();
  const d = opzet(w, {
    toegang: {
      groepen: {
        a: { adressen: ["aiwincoholland@gmail.com"] },
        oud: { adressen: ["oud@elders.nl"] },
      },
      apps: { "cf-proef": ["a", "oud"] },
    },
  });
  await richtIn(ARG, d);
  w.staat.gebruikers.push({ id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" });
  d.toegang = {
    groepen: { a: { adressen: ["aiwincoholland@gmail.com"] } },
    apps: { "cf-proef": ["a"] },
  };
  const origineel = w.fetchFn;
  d.cf = cloudflareClient({
    fetchFn: async (url, opties = {}) =>
      (opties.method ?? "GET") === "DELETE" && url.includes("/access/policies/")
        ? {
            ok: false,
            status: 400,
            statusText: "Fout",
            text: async () => '{"success":false,"errors":[{"message":"in gebruik"}]}',
          }
        : origineel(url, opties),
    token: "cf-token",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const r = await werkToegangBij(ARG, d);
  assert.ok(
    w.aanroepen.some((a) => a.methode === "updateUserById"),
    "Jan is toch ingetrokken",
  );
  assert.match(r.waarschuwingen.join(" "), /niet verwijderd/);
});

test("uitvoer: één regel INRICHTING zonder geheimen in leesbare vorm", async () => {
  const w = nepWolk();
  const d = opzet(w);
  const r = await richtIn(ARG, d);
  const regel = uitvoerRegel({ status: "gelukt", ...r }, d.geheimen);
  assert.match(regel, /^INRICHTING \{.*\}\n$/);
  assert.equal(regel.split("\n").length, 2);
  const ref = w.staat.projecten[0].ref;
  for (const geheim of [WACHTWOORD, "geheim-cs-3", `geheim-sr-${ref}`, "cf-token", "sb-token"]) {
    assert.equal(regel.includes(geheim), false, geheim);
  }
  assert.ok(d.geheimen.includes(WACHTWOORD) && d.geheimen.includes("geheim-cs-3"));
  assert.equal(
    uitvoerRegel({ x: "a geheim-cs-3 b" }, ["geheim-cs-3"]),
    'INRICHTING {"x":"a *** b"}\n',
  );
});

test("Edge Functions en hun instellingen worden nergens aangeraakt", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  await vangnet(ARG, d);
  await werkToegangBij(ARG, d);
  await ruimOp(ARG, d);
  assert.equal(
    w.aanroepen.some((a) => /functions/.test(a.url ?? "")),
    false,
  );
});
