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

describe("VITE_INLOGDIENST", () => {
  it("is standaard wachtwoord, zodat lokaal en CI werken zoals altijd", () => {
    expect(env.VITE_INLOGDIENST).toBe("wachtwoord");
  });

  it("weigert een onbekende inlogdienst met een duidelijke melding", async () => {
    const { envSchema } = await import("./env");
    const uitkomst = envSchema.safeParse({ VITE_INLOGDIENST: "okta" });
    expect(uitkomst.success).toBe(false);
  });

  it("kent de vijf diensten", async () => {
    const { envSchema } = await import("./env");
    for (const dienst of ["cloudflare", "azure", "google", "mailcode", "wachtwoord"]) {
      expect(envSchema.safeParse({ VITE_INLOGDIENST: dienst }).success).toBe(true);
    }
  });
});

describe("lege waarden", () => {
  it("behandelt een lege variabele als niet gezet, zoals GitHub Actions die doorgeeft", async () => {
    // `${{ vars.X }}` wordt een lege tekst als X niet bestaat. Dat mag de app niet
    // laten crashen: leeg betekent hetzelfde als afwezig.
    const { envSchema } = await import("./env");
    const uitkomst = envSchema.safeParse({
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_ANON_KEY: "",
      VITE_SUPABASE_SCHEMA: "",
      VITE_OMGEVING: "",
      VITE_INLOGDIENST: "",
    });
    expect(uitkomst.success).toBe(true);
    expect(uitkomst.data?.VITE_SUPABASE_SCHEMA).toBe("public");
    expect(uitkomst.data?.VITE_INLOGDIENST).toBe("wachtwoord");
    expect(uitkomst.data?.VITE_OMGEVING).toBeUndefined();
  });
});
