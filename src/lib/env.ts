import { z } from "zod";

/**
 * Omgevingsvariabelen worden hier één keer gevalideerd, bij het opstarten van de app.
 * Zo krijg je een begrijpelijke foutmelding in plaats van een `undefined` die pas
 * drie schermen verderop stukloopt.
 *
 * Alles met de prefix VITE_ zit in de gedownloade bundel en is dus publiek.
 * Zet hier nooit een geheime sleutel neer; zie docs/WERKWIJZE.md.
 */
const envSchema = z
  .object({
    /**
     * De twee Supabase-waarden horen bij elkaar: allebei aanwezig (een app met een
     * database) of allebei afwezig (`"database": false` in stack.config.json; de app
     * draait dan alleen op de hosting en toont de startpagina). Eén van de twee is
     * een fout, en die melden we hieronder.
     */
    VITE_SUPABASE_URL: z.string().min(1).optional(),
    VITE_SUPABASE_ANON_KEY: z.string().min(20, "VITE_SUPABASE_ANON_KEY is te kort").optional(),
    /**
     * Welk databaseschema deze app gebruikt. Een app met een eigen database praat met
     * `public`. Een app die de database van een andere app gebruikt (`"database":
     * "gedeeld"` in stack.config.json) praat uitsluitend met haar contract: het schema
     * `api`. Meer smaken zijn er niet, en dat is opzet.
     */
    VITE_SUPABASE_SCHEMA: z.enum(["public", "api"]).default("public"),
    /**
     * Staat deze versie van de app op de testdatabase? Dan `test`, en de app laat dat
     * zien met een balk bovenin. Vercel zet dit op de Preview-omgeving, `pnpm env:test`
     * op je eigen computer. In productie ontbreekt hij, en dan is er geen balk.
     */
    VITE_OMGEVING: z.enum(["test"]).optional(),
  })
  .superRefine((waarden, ctx) => {
    const url = Boolean(waarden.VITE_SUPABASE_URL);
    const sleutel = Boolean(waarden.VITE_SUPABASE_ANON_KEY);
    if (url !== sleutel) {
      ctx.addIssue({
        code: "custom",
        message: url ? "VITE_SUPABASE_ANON_KEY ontbreekt" : "VITE_SUPABASE_URL ontbreekt",
      });
    }
  });

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
  throw new Error(
    `De omgevingsvariabelen kloppen niet:\n${details}\n\nKopieer .env.example naar .env.local en vul de waarden in, of draai \`pnpm env:local\` als je lokaal met Supabase werkt.`,
  );
}

export const env = parsed.data;

/**
 * Heeft deze build een database? Zonder de Supabase-waarden niet, en dan toont de app
 * de startpagina in plaats van het inlogscherm. Dat is de stand van een verse app
 * met `"database": false`, en van elke app tot Stage Two de database heeft gekoppeld.
 */
export const heeftDatabase = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
