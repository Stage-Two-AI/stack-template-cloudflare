import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `wrangler.jsonc` is van het project (naam en adres verschillen per app), maar een
 * paar regels moeten in elke app gelijk zijn, anders staat de app ergens open of
 * werken diepe links niet. `scripts/lib/cloudflare-config.mjs` controleert dat; deze
 * test draait die controle zoals CI dat doet: als los Node-proces in een map.
 */
const LIB = resolve(__dirname, "../../scripts/lib/cloudflare-config.mjs");

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "cf-config-"));
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

const GOED = {
  name: "cf-proef",
  compatibility_date: "2026-09-01",
  assets: { directory: "./dist", not_found_handling: "single-page-application" },
  workers_dev: false,
  preview_urls: true,
  routes: [{ pattern: "cf-proef.stagetwo.nl", custom_domain: true }],
};

function schrijf(inhoud: string): void {
  writeFileSync(join(map, "wrangler.jsonc"), inhoud);
}

function controleer(): { code: number | null; uitvoer: string } {
  const code = `import(${JSON.stringify(LIB)}).then((m) => console.log(JSON.stringify(m.cloudflareConfig())))`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("cloudflareConfig", () => {
  it("geeft naam en hostname terug bij een goede config, ook met commentaar", () => {
    schrijf(`// uitleg\n${JSON.stringify(GOED, null, 2)}`);
    const r = controleer();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer)).toEqual({ worker: "cf-proef", hostname: "cf-proef.stagetwo.nl" });
  });

  it("weigert workers_dev aan", () => {
    schrijf(JSON.stringify({ ...GOED, workers_dev: true }));
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
  });

  it("weigert een config zonder single-page-application", () => {
    schrijf(JSON.stringify({ ...GOED, assets: { directory: "./dist" } }));
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("single-page-application");
  });

  it("weigert een Worker-script naast de bestanden", () => {
    schrijf(JSON.stringify({ ...GOED, main: "src/worker.ts" }));
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("main");
  });

  it("weigert opslag van Cloudflare zelf", () => {
    schrijf(JSON.stringify({ ...GOED, kv_namespaces: [{ binding: "X", id: "y" }] }));
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("kv_namespaces");
  });

  it("weigert een config zonder eigen domein", () => {
    schrijf(JSON.stringify({ ...GOED, routes: [] }));
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("custom_domain");
  });

  it("keurt de wrangler.jsonc van deze repo zelf goed", () => {
    writeFileSync(
      join(map, "wrangler.jsonc"),
      readFileSync(resolve(__dirname, "../../wrangler.jsonc"), "utf8"),
    );
    expect(controleer().code).toBe(0);
  });

  it("meldt duidelijk dat het bestand ontbreekt", () => {
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });
});
