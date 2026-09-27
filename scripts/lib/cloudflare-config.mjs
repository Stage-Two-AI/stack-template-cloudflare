import { readFileSync } from "node:fs";

/**
 * `wrangler.jsonc` beschrijft hoe deze app op Cloudflare draait. Het bestand is van het
 * project, want naam en adres verschillen per app, maar een paar regels gelden voor
 * elke app in deze stack:
 *
 *   - alleen de gebouwde bestanden, geen eigen Worker-code (`main`);
 *   - diepe links vallen terug op index.html (`single-page-application`);
 *   - geen `*.workers.dev`-adres naast het eigen domein (`workers_dev: false`);
 *   - een eigen domein (`custom_domain`), zodat Cloudflare Access ervoor kan staan;
 *   - geen opslag van Cloudflare zelf: gegevens horen in Supabase.
 *
 * `preview_urls` staat aan voor de previews per pull request. Dat geldt voor de hele
 * Worker, dus ook voor elke productieversie; daarom zet de inrichting Access op de
 * Worker zelf (zie `beheer/`).
 */
const OPSLAG = [
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "vectorize",
  "hyperdrive",
];

/** JSON met `//`- en `/* *\/`-commentaar, zoals wrangler.jsonc dat toestaat. */
function leesJsonc(tekst) {
  let uit = "";
  let inString = false;
  for (let i = 0; i < tekst.length; i++) {
    const teken = tekst[i];
    if (inString) {
      uit += teken;
      if (teken === "\\") {
        uit += tekst[++i] ?? "";
      } else if (teken === '"') {
        inString = false;
      }
    } else if (teken === '"') {
      inString = true;
      uit += teken;
    } else if (teken === "/" && tekst[i + 1] === "/") {
      while (i < tekst.length && tekst[i] !== "\n") i++;
      uit += "\n";
    } else if (teken === "/" && tekst[i + 1] === "*") {
      i += 2;
      while (i < tekst.length && !(tekst[i] === "*" && tekst[i + 1] === "/")) i++;
      i++;
    } else {
      uit += teken;
    }
  }
  return JSON.parse(uit.replace(/,(\s*[}\]])/g, "$1"));
}

function fout(melding) {
  throw new Error(`wrangler.jsonc: ${melding}`);
}

/** Leest en controleert wrangler.jsonc; geeft de Worker-naam en het eigen domein terug. */
export function cloudflareConfig(pad = "wrangler.jsonc") {
  let tekst;
  try {
    tekst = readFileSync(pad, "utf8");
  } catch {
    fout(
      `het bestand ${pad} ontbreekt. Elke app in deze stack draait op Cloudflare en heeft het nodig.`,
    );
  }
  const config = leesJsonc(tekst);

  if (typeof config.name !== "string" || config.name === "") fout("`name` ontbreekt.");
  if (config.main !== undefined) {
    fout(
      "`main` hoort er niet in: deze stack serveert alleen de gebouwde bestanden, zonder Worker-code.",
    );
  }
  if (config.assets?.not_found_handling !== "single-page-application") {
    fout(
      '`assets.not_found_handling` moet "single-page-application" zijn, anders werken diepe links niet.',
    );
  }
  if (config.workers_dev !== false) {
    fout(
      "`workers_dev` moet false zijn: de app hoort alleen op het eigen domein achter Access te staan.",
    );
  }
  for (const sleutel of OPSLAG) {
    if (config[sleutel] !== undefined) {
      fout(`\`${sleutel}\` hoort er niet in: gegevens staan in Supabase, niet bij Cloudflare.`);
    }
  }
  const domein = (config.routes ?? []).find((r) => r?.custom_domain === true);
  if (!domein?.pattern) {
    fout("er staat geen route met `custom_domain: true` in; de app heeft een eigen domein nodig.");
  }
  return { worker: config.name, hostname: domein.pattern };
}
