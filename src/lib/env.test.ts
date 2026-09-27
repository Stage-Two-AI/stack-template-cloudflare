import { describe, expect, it } from "vitest";
import { env } from "./env";

describe("env", () => {
  it("praat standaard met het schema public", () => {
    // Zonder VITE_SUPABASE_SCHEMA (zie vitest.config.ts) is dit een app met een eigen
    // database, en die praat met `public`. `api` is alleen voor een gedeelde database.
    expect(env.VITE_SUPABASE_SCHEMA).toBe("public");
  });

  it("is standaard geen testomgeving", () => {
    // Zonder VITE_OMGEVING is dit productie (of een lokale Docker-database) en hoort er
    // geen testbalk in beeld te staan. Alleen `test` zet hem aan.
    expect(env.VITE_OMGEVING).toBeUndefined();
  });
});

describe("heeftDatabase", () => {
  it("is waar zodra de twee Supabase-waarden er zijn", async () => {
    // vitest.config.ts zet de Supabase-waarden; dit is de stand van de template zelf.
    const { heeftDatabase } = await import("./env");
    expect(heeftDatabase).toBe(true);
  });
});
