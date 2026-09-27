#!/usr/bin/env node
/**
 * Richt één app in de Cloudflare-proef in, vanuit GitHub Actions (workflow
 * proef-inrichten): Cloudflare als deur en als inlogdienst, Supabase als database en
 * de koppeling daartussen. Zelfde patroon als `stack-beheer/klant/scripts/inrichten.mjs`.
 *
 *   node beheer/inrichten-cloudflare.mjs --app <naam> [--hostname <host>] [--repo <org/naam>]
 *        [--droogloop | --opruimen | --vangnet | --tweede-doorgang | --toegang]
 *
 * Volgorde (plan U5, stap 3 en 4):
 *   3.1 Supabase-project (eu-central-1), wachten tot gezond, sleutels ophalen
 *   3.2 herbruikbare policies uit toegang.json, dan de Access SaaS-app (OIDC)
 *   3.3 custom provider custom:cloudflare in Supabase, met de issuer van de SaaS-app
 *   3.4 auth-config: site_url, uri_allow_list, e-mail-inlog uit (disable_signup blijft)
 *   3.5 Access-app op de hostname (de deur), dezelfde policies
 *   3.6 GitHub-variabelen en -secrets per omgeving
 *   4   Access op de Worker zelf; slaat over zolang er nog niet is uitgerold
 *
 * Elke stap is idempotent: wat al bestaat met het voorvoegsel `cf-proef-` wordt
 * hergebruikt, wat bestaat zónder voorvoegsel laat het script stoppen vóór er iets
 * gewijzigd is. De eigen-domeinroute beheert dit script niet; die staat in wrangler.jsonc.
 *
 * Omgeving (GitHub-omgeving proef-beheer, zie beheer/README.md):
 *   CLOUDFLARE_PROEF_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TEAM_DOMAIN,
 *   SUPABASE_ACCESS_TOKEN, SUPABASE_ORG_SLUG, GH_TOKEN,
 *   optioneel CLOUDFLARE_IDP_IDS (komma's) en CLOUDFLARE_GROEPEN_IDP (<type>:<id>).
 *
 * Uitvoer: één regel `INRICHTING {json}`; geheimen staan er nooit in leesbaar in, en in
 * GitHub Actions worden ze ook met ::add-mask:: uit het logboek gehouden.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareConfig } from "../scripts/lib/cloudflare-config.mjs";
import {
  appNamen,
  cloudflareClient,
  deurApp,
  inlogApp,
  issuerVoor,
  metPolicies,
  policyIdsVanApp,
  VOORVOEGSEL,
  workerApp,
} from "./lib/cloudflare.mjs";
import {
  afmeldSql,
  alleGebruikers,
  authInstellingen,
  callbackAdres,
  hookInstellingen,
  REGIO,
  standaardAdmin,
  supabaseBeheer,
  supabaseUrl,
  uriAllowList,
  verschil,
  verwijderProvider,
  zetProvider,
} from "./lib/supabase.mjs";
import {
  BAN_DUUR,
  gewenstePolicies,
  kaleNaamConflicten,
  koppelPolicies,
  policyIdsVoorApp,
  synchroniseerPolicies,
  trekIn,
  valideerToegang,
  vangnetSql,
  verwijderOverbodig,
} from "./lib/toegang.mjs";

export const OMGEVINGEN = ["production", "preview"];
export const HOOK_FUNCTIE = `${VOORVOEGSEL.replaceAll("-", "_")}voor_aanmelden`;
const GH_VARIABELEN = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_INLOGDIENST"];
const GH_SECRETS = ["SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD"];

// ---------------------------------------------------------------- argumenten

export function leesArgumenten(argv) {
  const uit = {
    app: null,
    hostname: null,
    repo: null,
    droogloop: false,
    opruimen: false,
    vangnet: false,
    tweedeDoorgang: false,
    toegang: false,
  };
  const vlaggen = {
    "--droogloop": "droogloop",
    "--opruimen": "opruimen",
    "--vangnet": "vangnet",
    "--tweede-doorgang": "tweedeDoorgang",
    "--toegang": "toegang",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (vlaggen[a]) uit[vlaggen[a]] = true;
    else if (["--app", "--hostname", "--repo"].includes(a)) {
      const waarde = argv[i + 1];
      if (waarde === undefined || waarde.startsWith("--"))
        throw new Error(`${a} vraagt een waarde`);
      uit[a.slice(2)] = waarde;
      i += 1;
    } else throw new Error(`onbekende optie: ${a}`);
  }
  const modi = ["opruimen", "vangnet", "tweedeDoorgang", "toegang"].filter((m) => uit[m]);
  if (modi.length > 1) {
    throw new Error("kies één van --opruimen, --vangnet, --tweede-doorgang of --toegang");
  }
  const appNodig = !uit.opruimen && !uit.toegang;
  if (uit.app === null && appNodig) throw new Error("geef --app <naam> mee");
  if (uit.app !== null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(uit.app)) {
    throw new Error("--app: alleen kleine letters, cijfers en streepjes");
  }
  if (uit.hostname !== null && !/^[a-z0-9.-]+$/.test(uit.hostname))
    throw new Error("--hostname is ongeldig");
  return uit;
}

/** Een databasewachtwoord: 32 tekens uit letters en cijfers, zonder tekens die URL's of shells verwarren. */
export function nieuwWachtwoord(bytes = randomBytes(48)) {
  const alfabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let uit = "";
  for (const b of bytes) {
    uit += alfabet[b % alfabet.length];
    if (uit.length === 32) break;
  }
  return uit;
}

// ---------------------------------------------------------------- verkennen (alleen lezen)

async function kiesIdps(d) {
  if (d.idps?.length) return [...d.idps];
  const lijst = await d.cf.identiteitsdiensten();
  const pin = lijst.filter((i) => i.type === "onetimepin").map((i) => i.id);
  if (pin.length === 0) {
    throw new Error(
      "er is geen one-time PIN-inlogmethode in Zero Trust (P1); voeg hem toe of zet CLOUDFLARE_IDP_IDS met de toegestane inlogmethoden",
    );
  }
  return pin;
}

/**
 * Leest alles wat er al staat en controleert of het script mag beginnen. Hier wordt
 * niets geschreven; elke reden om te stoppen komt hier boven, vóór de eerste wijziging.
 */
async function verken(arg, d, { schrijven }) {
  const t = valideerToegang(d.toegang);
  if (!t.apps[arg.app]) {
    throw new Error(
      `app "${arg.app}" staat niet in beheer/toegang.json; voeg hem toe met minstens één groep`,
    );
  }
  if (!/^[a-z0-9.-]+$/.test(arg.hostname ?? ""))
    throw new Error("de hostname ontbreekt of is ongeldig");
  if (!/^[a-z0-9-]+$/.test(arg.worker ?? ""))
    throw new Error("de Worker-naam ontbreekt (wrangler.jsonc)");
  if (schrijven && !arg.repo) {
    throw new Error(
      "geen repo bekend voor de GitHub-variabelen; geef --repo mee of draai in GitHub Actions",
    );
  }
  const gewenst = gewenstePolicies(t, { groepenIdp: d.groepenIdp });
  const namen = appNamen(arg.app);
  const { cf, supabase } = d;

  const policies = await cf.policies();
  const apps = await cf.apps();
  const projecten = await supabase.projecten();
  const idps = await kiesIdps(d);
  const subdomein = await cf.workersSubdomein();
  const team = await cf.teamDomein();

  const fouten = [...kaleNaamConflicten(t, policies)];
  for (const naam of [namen.deur, namen.inlog, namen.worker]) {
    const kaal = naam.slice(VOORVOEGSEL.length);
    if (apps.some((a) => a.name === kaal)) {
      fouten.push(`Access-app "${kaal}" bestaat al zonder voorvoegsel ${VOORVOEGSEL}`);
    }
  }
  const opHost = apps.find(
    (a) =>
      !a.name?.startsWith(VOORVOEGSEL) &&
      (a.domain === arg.hostname || (a.destinations ?? []).some((x) => x.uri === arg.hostname)),
  );
  if (opHost)
    fouten.push(`Access-app "${opHost.name}" (zonder voorvoegsel) bewaakt ${arg.hostname} al`);
  const kaalProject = namen.project.slice(VOORVOEGSEL.length);
  if (projecten.some((p) => p.name === kaalProject)) {
    fouten.push(`Supabase-project "${kaalProject}" bestaat al zonder voorvoegsel ${VOORVOEGSEL}`);
  }
  if (fouten.length) throw new Error(`gestopt zonder wijzigingen: ${fouten.join("; ")}`);

  return {
    t,
    gewenst,
    namen,
    policies,
    apps,
    idps,
    subdomein,
    team,
    project: projecten.find((p) => p.name === namen.project) ?? null,
    deur: apps.find((a) => a.name === namen.deur) ?? null,
    inlog: apps.find((a) => a.name === namen.inlog) ?? null,
    workerAccess: apps.find((a) => a.name === namen.worker) ?? null,
  };
}

// ---------------------------------------------------------------- GitHub

function leesJsonLijst(tekst) {
  const lijst = JSON.parse(tekst || "[]");
  return Array.isArray(lijst) ? lijst : [];
}

/** Zet variabelen per omgeving (alleen wat anders is) en repo-secrets via stdin. */
async function zetGithub(d, repo, { variabelen, secrets = {} }) {
  const gezet = [];
  for (const env of OMGEVINGEN) {
    const huidig = Object.fromEntries(
      leesJsonLijst(
        await d.gh(["variable", "list", "--env", env, "--repo", repo, "--json", "name,value"]),
      ).map((v) => [v.name, v.value]),
    );
    for (const [naam, waarde] of Object.entries(variabelen)) {
      if (huidig[naam] === waarde) continue;
      await d.gh(["variable", "set", naam, "--env", env, "--repo", repo], { invoer: waarde });
      gezet.push(`${env}/${naam}`);
    }
  }
  const namen = Object.keys(secrets);
  if (namen.length) {
    const bestaand = leesJsonLijst(
      await d.gh(["secret", "list", "--repo", repo, "--json", "name"]),
    ).map((s) => s.name);
    for (const naam of namen) {
      const { waarde, altijd } = secrets[naam];
      if (!waarde || (!altijd && bestaand.includes(naam))) continue;
      // Secrets gaan via stdin, nooit als argument: argumenten zijn zichtbaar in de proceslijst.
      await d.gh(["secret", "set", naam, "--repo", repo], { invoer: waarde });
      gezet.push(`secret ${naam}`);
    }
  }
  return gezet;
}

/** De standaard-`gh`: een kindproces met GH_TOKEN uit de omgeving; invoer via stdin. */
export function standaardGh(env = process.env) {
  return (args, { invoer } = {}) =>
    new Promise((resolve, reject) => {
      const kind = spawn("gh", args, { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let uit = "";
      let fout = "";
      kind.stdout.on("data", (c) => {
        uit += c;
      });
      kind.stderr.on("data", (c) => {
        fout += c;
      });
      kind.on("error", reject);
      kind.on("close", (code) =>
        code === 0
          ? resolve(uit)
          : reject(
              new Error(
                `gh ${args.slice(0, 3).join(" ")} gaf ${code}: ${fout.trim().slice(0, 300)}`,
              ),
            ),
      );
      kind.stdin.end(invoer ?? "");
    });
}

// ---------------------------------------------------------------- stap 4

async function stapWorker(arg, d, v, policyIds) {
  const stap = "4 Access op de Worker";
  if (!(await d.cf.workerBestaat(arg.worker))) {
    return { stap, actie: "overgeslagen: nog niet uitgerold", id: null };
  }
  if (!v.workerAccess) {
    const nieuw = await d.cf.maakApp(
      workerApp({
        naam: v.namen.worker,
        worker: arg.worker,
        subdomein: v.subdomein,
        policyIds,
        idps: v.idps,
      }),
    );
    return { stap, actie: "aangemaakt", id: nieuw.id };
  }
  if (JSON.stringify(policyIdsVanApp(v.workerAccess)) === JSON.stringify(policyIds)) {
    return { stap, actie: "ongewijzigd", id: v.workerAccess.id };
  }
  await d.cf.werkAppBij(v.workerAccess.id, metPolicies(v.workerAccess, policyIds));
  return { stap, actie: "policies bijgewerkt", id: v.workerAccess.id };
}

// ---------------------------------------------------------------- de inrichting

function geplandeStappen(arg, v, workerBestaat) {
  const bestaat = (x, tekst) => (x ? `bestaat al (${x.id ?? x.ref})` : `gepland: ${tekst}`);
  const policiesErAl = v.gewenst.every((g) => v.policies.some((p) => p.name === g.body.name));
  return [
    { stap: "3.1 Supabase-project", actie: bestaat(v.project, `${v.namen.project} in ${REGIO}`) },
    {
      stap: "3.2 Access-policies",
      actie: policiesErAl
        ? "bestaat al (bijwerken waar nodig)"
        : `gepland: ${v.gewenst.map((g) => g.body.name).join(", ")}`,
    },
    {
      stap: "3.2 Access SaaS-app (OIDC)",
      actie: bestaat(v.inlog, `${v.namen.inlog}, inlogmethoden ${v.idps.join(", ")}`),
    },
    { stap: "3.3 custom provider custom:cloudflare", actie: "gepland: aanmaken of gelijkzetten" },
    {
      stap: "3.4 auth-config",
      actie: `gepland: site_url https://${arg.hostname}, redirects ${uriAllowList({ hostname: arg.hostname, worker: arg.worker, subdomein: v.subdomein }).join(" ")}, e-mail-inlog uit`,
    },
    {
      stap: "3.5 Access-app op de hostname",
      actie: bestaat(v.deur, `${v.namen.deur} op ${arg.hostname}`),
    },
    {
      stap: "3.6 GitHub-variabelen en -secrets",
      actie: `gepland: ${OMGEVINGEN.join(" en ")}, plus repo-secrets`,
    },
    {
      stap: "4 Access op de Worker",
      actie: workerBestaat
        ? bestaat(v.workerAccess, v.namen.worker)
        : "nog niet uitgerold: stap 4 volgt na de eerste uitrol",
    },
  ];
}

/**
 * De hele inrichting. `d` (diensten) is injecteerbaar voor de tests:
 *   cf, supabase, maakAdmin(url, serviceRole), gh(args, {invoer}), toegang, accountId,
 *   idps?, groepenIdp?, wachtwoord?, maskeer(waarde)
 */
export async function richtIn(arg, d) {
  const maskeer = d.maskeer ?? (() => {});
  const v = await verken(arg, d, { schrijven: !arg.droogloop });
  const resultaat = {
    app: arg.app,
    hostname: arg.hostname,
    droogloop: Boolean(arg.droogloop),
    stappen: [],
    waarschuwingen: [],
  };
  if (arg.droogloop) {
    resultaat.stappen = geplandeStappen(arg, v, await d.cf.workerBestaat(arg.worker));
    return resultaat;
  }
  const stap = (naam, actie) => resultaat.stappen.push({ stap: naam, actie });
  const { cf, supabase } = d;

  // 3.1 Supabase-project
  let project = v.project;
  let wachtwoord = null;
  if (project) stap("3.1 Supabase-project", `hergebruikt (${project.ref})`);
  else {
    wachtwoord = (d.wachtwoord ?? nieuwWachtwoord)();
    maskeer(wachtwoord);
    project = await supabase.maakProject(v.namen.project, wachtwoord);
    stap("3.1 Supabase-project", `aangemaakt (${project.ref}, ${REGIO})`);
  }
  await supabase.wachtTotGezond(project.ref);
  const sleutels = await supabase.sleutels(project.ref);
  maskeer(sleutels.serviceRole);
  resultaat.supabase = { ref: project.ref, url: supabaseUrl(project.ref) };

  // 3.2 policies en de SaaS-app
  const sync = await synchroniseerPolicies(cf, v.t, {
    groepenIdp: d.groepenIdp,
    bestaand: v.policies,
  });
  stap("3.2 Access-policies", sync.acties.length ? sync.acties.join("; ") : "ongewijzigd");
  const policyIds = policyIdsVoorApp(v.t, arg.app, sync.ids);
  let inlog = v.inlog;
  let clientSecret = null;
  if (!inlog) {
    inlog = await cf.maakApp(
      inlogApp({
        naam: v.namen.inlog,
        callback: callbackAdres(project.ref),
        policyIds,
        idps: v.idps,
      }),
    );
    clientSecret = inlog?.saas_app?.client_secret ?? null;
    maskeer(clientSecret);
    stap("3.2 Access SaaS-app (OIDC)", `aangemaakt (${inlog.id})`);
  } else if (JSON.stringify(policyIdsVanApp(inlog)) !== JSON.stringify(policyIds)) {
    await cf.werkAppBij(inlog.id, metPolicies(inlog, policyIds));
    stap("3.2 Access SaaS-app (OIDC)", `hergebruikt, policies bijgewerkt (${inlog.id})`);
  } else stap("3.2 Access SaaS-app (OIDC)", `hergebruikt (${inlog.id})`);
  // NAGAAN (U7): client_id staat in `saas_app.client_id` van het antwoord.
  const clientId = inlog?.saas_app?.client_id;
  if (!clientId) throw new Error(`de SaaS-app ${v.namen.inlog} heeft geen client_id in saas_app`);
  const issuer = issuerVoor(v.team, clientId);
  resultaat.issuer = issuer;

  // 3.3 custom provider
  const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(project.ref), sleutels.serviceRole);
  const provider = await zetProvider(admin.customProviders, { issuer, clientId, clientSecret });
  stap("3.3 custom provider custom:cloudflare", provider);

  // 3.4 auth-config
  const gewenstAuth = authInstellingen({
    hostname: arg.hostname,
    worker: arg.worker,
    subdomein: v.subdomein,
  });
  const anders = verschil(await supabase.authConfig(project.ref), gewenstAuth);
  if (Object.keys(anders).length) {
    await supabase.werkAuthBij(project.ref, anders);
    stap("3.4 auth-config", `bijgewerkt: ${Object.keys(anders).join(", ")}`);
  } else stap("3.4 auth-config", "ongewijzigd");
  resultaat.uri_allow_list = gewenstAuth.uri_allow_list.split(",");

  // 3.5 de deur
  let deur = v.deur;
  if (!deur) {
    deur = await cf.maakApp(
      deurApp({ naam: v.namen.deur, hostname: arg.hostname, policyIds, idps: v.idps }),
    );
    stap("3.5 Access-app op de hostname", `aangemaakt (${deur.id})`);
  } else if (JSON.stringify(policyIdsVanApp(deur)) !== JSON.stringify(policyIds)) {
    await cf.werkAppBij(deur.id, metPolicies(deur, policyIds));
    stap("3.5 Access-app op de hostname", `hergebruikt, policies bijgewerkt (${deur.id})`);
  } else stap("3.5 Access-app op de hostname", `hergebruikt (${deur.id})`);

  // 3.6 GitHub
  const gezet = await zetGithub(d, arg.repo, {
    variabelen: {
      VITE_SUPABASE_URL: supabaseUrl(project.ref),
      VITE_SUPABASE_ANON_KEY: sleutels.anon,
      VITE_INLOGDIENST: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: d.accountId,
    },
    secrets: {
      SUPABASE_PROJECT_REF: { waarde: project.ref, altijd: Boolean(wachtwoord) },
      SUPABASE_DB_PASSWORD: { waarde: wachtwoord, altijd: true },
    },
  });
  stap(
    "3.6 GitHub-variabelen en -secrets",
    gezet.length ? `gezet: ${gezet.join(", ")}` : "ongewijzigd",
  );
  if (!wachtwoord) {
    resultaat.waarschuwingen.push(
      "het project bestond al; SUPABASE_DB_PASSWORD is niet opnieuw gezet (alleen bij aanmaken bekend)",
    );
  }

  // 4 Access op de Worker (tweede doorgang, slaat over zolang er niet is uitgerold)
  const w = await stapWorker(arg, d, v, policyIds);
  stap(w.stap, w.actie);

  const weg = await verwijderOverbodig(cf, sync.overbodig);
  if (weg.length) stap("3.2 Access-policies", `overbodig verwijderd: ${weg.join(", ")}`);

  resultaat.cloudflare = { policies: sync.ids, inlog: inlog.id, deur: deur.id, worker: w.id };
  return resultaat;
}

/** Alleen stap 4, na de eerste uitrol vanaf main. */
export async function tweedeDoorgang(arg, d) {
  const v = await verken(arg, d, { schrijven: false });
  const ids = {};
  for (const { groep, body } of v.gewenst) {
    const p = v.policies.find((x) => x.name === body.name);
    if (!p) throw new Error(`policy ${body.name} ontbreekt; draai eerst de inrichting zelf`);
    ids[groep] = p.id;
  }
  const policyIds = policyIdsVoorApp(v.t, arg.app, ids);
  if (arg.droogloop) {
    const bestaat = await d.cf.workerBestaat(arg.worker);
    return {
      app: arg.app,
      melding: bestaat ? "gepland: Access op de Worker" : "nog niet uitgerold",
    };
  }
  const w = await stapWorker(arg, d, v, policyIds);
  return { app: arg.app, melding: w.actie, worker: w.id };
}

// ---------------------------------------------------------------- vangnet (R18)

/**
 * Het vangnet: e-mail-inlog weer aan, met een before-user-created-hook die alleen de
 * domeinen en adressen van de gekozen groepen toelaat. De app schakelt via
 * VITE_INLOGDIENST=mailcode om; geen codewijziging nodig.
 */
export async function vangnet(arg, d) {
  const v = await verken(arg, d, { schrijven: !arg.droogloop });
  if (!v.project)
    throw new Error(`Supabase-project ${v.namen.project} bestaat niet; draai eerst de inrichting`);
  const sql = vangnetSql(v.t, arg.app, HOOK_FUNCTIE);
  const resultaat = {
    app: arg.app,
    supabase: { ref: v.project.ref },
    hook: HOOK_FUNCTIE,
    stappen: [],
  };
  if (arg.droogloop) {
    resultaat.stappen.push({
      stap: "vangnet",
      actie: "gepland: hook-functie, auth-config, VITE_INLOGDIENST=mailcode",
    });
    return resultaat;
  }
  await d.supabase.voerSqlUit(v.project.ref, sql);
  resultaat.stappen.push({ stap: "hook-functie", actie: `public.${HOOK_FUNCTIE} gezet` });
  const anders = verschil(
    await d.supabase.authConfig(v.project.ref),
    hookInstellingen(HOOK_FUNCTIE),
  );
  if (Object.keys(anders).length) await d.supabase.werkAuthBij(v.project.ref, anders);
  resultaat.stappen.push({
    stap: "auth-config",
    actie: Object.keys(anders).length ? "bijgewerkt" : "ongewijzigd",
  });
  const gezet = await zetGithub(d, arg.repo, { variabelen: { VITE_INLOGDIENST: "mailcode" } });
  resultaat.stappen.push({
    stap: "GitHub",
    actie: gezet.length ? `gezet: ${gezet.join(", ")}` : "ongewijzigd",
  });
  return resultaat;
}

// ---------------------------------------------------------------- opruimen

/**
 * Verwijdert alles met het voorvoegsel, in omgekeerde volgorde van de inrichting, en
 * meldt wat er stond. Alles zonder voorvoegsel blijft staan. De Worker zelf en de
 * eigen-domeinroute horen bij wrangler en blijven ook staan; daar komt een waarschuwing.
 */
export async function ruimOp(arg, d) {
  const { cf, supabase } = d;
  const apps = (await cf.apps()).filter((a) => a.name?.startsWith(VOORVOEGSEL));
  const policies = (await cf.policies()).filter((p) => p.name?.startsWith(VOORVOEGSEL));
  const projecten = (await supabase.projecten()).filter((p) => p.name?.startsWith(VOORVOEGSEL));
  const workerApps = apps.filter((a) => a.name.endsWith("-worker"));
  const saasApps = apps.filter((a) => a.type === "saas");
  const deurApps = apps.filter((a) => !workerApps.includes(a) && !saasApps.includes(a));
  const verwijderd = [];
  const waarschuwingen = [];
  const droog = Boolean(arg.droogloop);

  for (const a of workerApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access op de Worker", naam: a.name });
  }

  if (arg.repo) {
    const namen = [];
    for (const env of OMGEVINGEN) {
      const huidig = leesJsonLijst(
        await d.gh(["variable", "list", "--env", env, "--repo", arg.repo, "--json", "name,value"]),
      ).map((x) => x.name);
      for (const naam of GH_VARIABELEN.filter((n) => huidig.includes(n))) {
        if (!droog) await d.gh(["variable", "delete", naam, "--env", env, "--repo", arg.repo]);
        namen.push(`${env}/${naam}`);
      }
    }
    const secrets = leesJsonLijst(
      await d.gh(["secret", "list", "--repo", arg.repo, "--json", "name"]),
    ).map((x) => x.name);
    for (const naam of GH_SECRETS.filter((n) => secrets.includes(n))) {
      if (!droog) await d.gh(["secret", "delete", naam, "--repo", arg.repo]);
      namen.push(`secret ${naam}`);
    }
    if (namen.length) verwijderd.push({ soort: "GitHub", naam: namen.join(", ") });
  }

  for (const a of deurApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access-app op de hostname", naam: a.name });
  }

  for (const p of projecten) {
    const sleutels = await supabase.sleutels(p.ref);
    const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(p.ref), sleutels.serviceRole);
    if (droog) {
      verwijderd.push({
        soort: "custom provider",
        naam: `${p.name}: custom:cloudflare (indien aanwezig)`,
      });
    } else if (await verwijderProvider(admin.customProviders)) {
      verwijderd.push({ soort: "custom provider", naam: `${p.name}: custom:cloudflare` });
    }
  }

  for (const a of saasApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access SaaS-app", naam: a.name });
  }
  for (const p of policies) {
    if (!droog) await cf.verwijderPolicy(p.id);
    verwijderd.push({ soort: "Access-policy", naam: p.name });
  }
  for (const p of projecten) {
    if (!droog) await supabase.verwijderProject(p.ref);
    verwijderd.push({ soort: "Supabase-project", naam: `${p.name} (${p.ref})` });
  }

  if (arg.worker && (await cf.workerBestaat(arg.worker))) {
    waarschuwingen.push(
      `Worker ${arg.worker} staat nog uitgerold en heeft geen deur meer; verwijder hem met wrangler delete (U8) of draai de inrichting opnieuw`,
    );
  }
  return { droogloop: droog, verwijderd, waarschuwingen };
}

// ---------------------------------------------------------------- toegang bijwerken (U6)

/**
 * Maakt Cloudflare gelijk aan toegang.json en trekt daarna de toegang in van wie niet
 * meer past: ban en afmelden in het Supabase-project van elke app.
 */
export async function werkToegangBij(arg, d) {
  const t = valideerToegang(d.toegang);
  const { cf, supabase } = d;
  const policies = await cf.policies();
  const apps = await cf.apps();
  const projecten = await supabase.projecten();
  if (arg.droogloop) {
    gewenstePolicies(t, { groepenIdp: d.groepenIdp });
    const conflicten = kaleNaamConflicten(t, policies);
    if (conflicten.length) throw new Error(`gestopt zonder wijzigingen: ${conflicten.join("; ")}`);
    return {
      droogloop: true,
      acties: ["gepland: policies gelijkzetten, apps koppelen, intrekken"],
    };
  }
  const sync = await synchroniseerPolicies(cf, t, { groepenIdp: d.groepenIdp, bestaand: policies });
  const gekoppeld = await koppelPolicies(cf, t, apps, sync.ids);
  const weg = await verwijderOverbodig(cf, sync.overbodig);

  const ingetrokken = {};
  const onbekend = {};
  const doelApps = arg.app ? [arg.app] : Object.keys(t.apps);
  for (const app of doelApps) {
    const project = projecten.find((p) => p.name === appNamen(app).project);
    if (!project || !t.apps[app]) continue;
    const sleutels = await supabase.sleutels(project.ref);
    d.maskeer?.(sleutels.serviceRole);
    const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(project.ref), sleutels.serviceRole);
    const r = await trekIn({
      gebruikers: await alleGebruikers(admin),
      toegang: t,
      app,
      ban: async (id) => {
        const { error } = await admin.updateUserById(id, { ban_duration: BAN_DUUR });
        if (error) throw new Error(`Supabase updateUserById: ${error.message ?? error}`);
      },
      afmelden: (id) => supabase.voerSqlUit(project.ref, afmeldSql(id)),
    });
    if (r.ingetrokken.length) ingetrokken[app] = r.ingetrokken;
    if (r.onbekend.length) onbekend[app] = r.onbekend;
  }
  return {
    acties: [...sync.acties, ...gekoppeld, ...weg.map((n) => `policy ${n} verwijderd`)],
    ingetrokken,
    onbekend,
  };
}

// ---------------------------------------------------------------- uitvoer

/** Eén regel `INRICHTING {json}`, met elk bekend geheim vervangen door ***. */
export function uitvoerRegel(object, geheimen = []) {
  let tekst = JSON.stringify(object);
  for (const g of geheimen) {
    if (typeof g !== "string" || g.length < 4) continue;
    tekst = tekst.replaceAll(g, "***").replaceAll(JSON.stringify(g).slice(1, -1), "***");
  }
  return `INRICHTING ${tekst}\n`;
}

function eis(naam) {
  const w = process.env[naam];
  if (!w) throw new Error(`${naam} ontbreekt; zie beheer/README.md (voorwaarden P1 tot en met P4)`);
  return w;
}

function leesGroepenIdp(waarde) {
  if (!waarde) return undefined;
  const [type, id] = waarde.split(":");
  if (!type || !id)
    throw new Error("CLOUDFLARE_GROEPEN_IDP heeft de vorm <type>:<id>, bijvoorbeeld azureAD:<id>");
  return { type, id };
}

if (
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname
) {
  const geheimen = [];
  const maskeer = (waarde) => {
    if (!waarde) return;
    geheimen.push(waarde);
    if (process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${waarde}\n`);
  };
  let modus = "inrichten";
  try {
    const arg = leesArgumenten(process.argv.slice(2));
    modus = ["opruimen", "vangnet", "tweedeDoorgang", "toegang"].find((m) => arg[m]) ?? "inrichten";
    let config = null;
    try {
      config = cloudflareConfig();
    } catch (fout) {
      if (!["opruimen", "toegang"].includes(modus)) throw fout;
    }
    arg.hostname ??= config?.hostname ?? null;
    arg.worker = config?.worker ?? null;
    arg.repo ??= process.env.GITHUB_REPOSITORY ?? null;
    for (const naam of ["CLOUDFLARE_PROEF_TOKEN", "SUPABASE_ACCESS_TOKEN", "GH_TOKEN"])
      maskeer(process.env[naam]);
    const ghNodig = !arg.droogloop && ["inrichten", "vangnet", "opruimen"].includes(modus);
    if (ghNodig) eis("GH_TOKEN");
    const d = {
      cf: cloudflareClient({
        token: eis("CLOUDFLARE_PROEF_TOKEN"),
        accountId: eis("CLOUDFLARE_ACCOUNT_ID"),
        teamDomein: process.env.CLOUDFLARE_TEAM_DOMAIN || undefined,
      }),
      supabase: supabaseBeheer({
        token: eis("SUPABASE_ACCESS_TOKEN"),
        orgSlug: eis("SUPABASE_ORG_SLUG"),
      }),
      maakAdmin: standaardAdmin,
      gh: standaardGh(),
      toegang: JSON.parse(readFileSync(new URL("./toegang.json", import.meta.url), "utf8")),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      idps: (process.env.CLOUDFLARE_IDP_IDS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      groepenIdp: leesGroepenIdp(process.env.CLOUDFLARE_GROEPEN_IDP),
      maskeer,
    };
    const uitvoeren = {
      inrichten: richtIn,
      opruimen: ruimOp,
      vangnet,
      tweedeDoorgang,
      toegang: werkToegangBij,
    }[modus];
    const resultaat = await uitvoeren(arg, d);
    process.stdout.write(uitvoerRegel({ status: "gelukt", modus, ...resultaat }, geheimen));
  } catch (fout) {
    process.stdout.write(uitvoerRegel({ status: "mislukt", modus, reden: fout.message }, geheimen));
    process.exitCode = 1;
  }
}
