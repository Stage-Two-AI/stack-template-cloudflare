import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * De uitrol-workflow bepaalt wie welke sleutel te zien krijgt. Een pull request mag
 * nooit bij de sleutels van productie of van de inrichting: GitHub geeft secrets van
 * een omgeving aan elke job die die omgeving noemt, ook op een PR-tak.
 */
const WORKFLOWS = resolve(__dirname, "../../.github/workflows");

type Stap = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
};
type Job = { if?: string; environment?: string | { name: string }; steps: Stap[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function lees(naam: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS, naam), "utf8")) as Workflow;
}

function omgeving(job: Job): string | undefined {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}

const uitrollen = lees("uitrollen.yml");

function job(naam: string): Job {
  const gevonden = uitrollen.jobs[naam];
  if (!gevonden) throw new Error(`job ${naam} ontbreekt in uitrollen.yml`);
  return gevonden;
}

describe("uitrollen.yml", () => {
  it("rolt productie alleen uit bij een push op main, in omgeving production", () => {
    const productie = job("productie");
    expect(productie.if).toContain("github.event_name == 'push'");
    expect(omgeving(productie)).toBe("production");
    expect(uitrollen.on.push).toEqual({ branches: ["main"] });
  });

  it("zet een preview per PR met een vaste alias, in omgeving preview", () => {
    const preview = job("preview");
    expect(preview.if).toContain("github.event_name == 'pull_request'");
    expect(omgeving(preview)).toBe("preview");
    const upload = preview.steps.find((s) => s.run?.includes("versions upload"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub-expressie, geen JS-template
    expect(upload?.run).toContain("--preview-alias pr-${{ github.event.pull_request.number }}");
  });

  it("bouwt de preview met de testbalk aan", () => {
    const bouw = job("preview").steps.find((s) => s.run?.includes("pnpm build"));
    expect(bouw?.env?.VITE_OMGEVING).toBe("test");
  });

  it("rolt productie niet uit zolang de database nog niet is ingericht", () => {
    const controle = job("productie").steps.find((s) => s.run?.includes("VITE_SUPABASE_URL"));
    expect(controle?.run).toContain("skip=true");
    const deploy = job("productie").steps.find((s) => s.run?.includes("wrangler deploy"));
    expect(deploy?.if).toContain("skip != 'true'");
  });

  it("slaat over met een melding als de uitrolsleutel ontbreekt", () => {
    for (const j of [job("productie"), job("preview")]) {
      const controle = j.steps.find((s) => s.run?.includes("CLOUDFLARE_API_TOKEN"));
      expect(controle?.run).toContain("::notice::");
    }
  });
});

describe("sleutels per omgeving, in alle workflows", () => {
  const bestanden = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  it("geen job die op een pull request kan draaien noemt proef-beheer of production", () => {
    for (const naam of bestanden) {
      const wf = lees(naam);
      const opPr = "pull_request" in (wf.on ?? {}) || "pull_request_target" in (wf.on ?? {});
      if (!opPr) continue;
      for (const [jobNaam, job] of Object.entries(wf.jobs)) {
        const env = omgeving(job);
        if (env === "proef-beheer" || env === "production") {
          expect(job.if ?? "", `${naam}/${jobNaam}`).toContain("github.event_name == 'push'");
        }
      }
    }
  });
});
