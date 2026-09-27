# Een nieuwe app beginnen

Deze repo is één app. Een **nieuwe** app krijgt een eigen repo, en die begin je zelf,
met de Stage Two-plugin in Claude Code: typ `/stack:nieuwe-app` in een lege map. Die
route denkt eerst met je mee (is het wel een nieuwe app, wat moet hij doen, heeft hij een
database nodig) en maakt de app daarna aan uit de nieuwste template, onder het
GitHub-account van je bedrijf. Je hoeft er Stage Two niet voor te mailen.

Eén uitzondering: het **allereerste** project. Dan staan de accounts van het bedrijf
(GitHub, hosting, database) nog niet, en die richt Stage Two in. Daarna kun je zelf
verder, ook als Stage Two er niet meer bij is.

## Eerst: is het wel een nieuwe app?

De regel is simpel: **één app per verzameling gegevens.** Gegevens die op twee plekken
staan gaan uit elkaar lopen, en een app die de gegevens van een andere app gebruikt is
voor iedereen moeilijker te overzien.

| Wat je wilt | Wat het is |
|---|---|
| Iets over gegevens die al in een app van het bedrijf zitten (dezelfde planten, orders, voorraad, klanten) | **uitbreiding** van die app |
| Een scherm, overzicht of werktuig erbij voor dezelfde mensen | **uitbreiding** van die app |
| Andere gebruikers, of gegevens die niets met elkaar te maken hebben | **nieuwe app** |
| Moet vindbaar zijn in Google | een website, geen app uit deze template; vraag Stage Two |
| "Kan dit er ook nog bij?" | vaak een uitbreiding |

Is het een uitbreiding? Volg dan `docs/routes/verder-werken.md` in de map van die app.

Wil je toch een aparte app op de gegevens van een bestaande app, bijvoorbeeld een portaal
voor mensen van buiten? Dat kan, maar dat is een keuze met een eigen beveiligingsopzet.
Die maakt Stage Two samen met je.

## Wat je vooraf scherp hebt

Hoe concreter je dit hebt, hoe beter de eerste versie wordt. "Dat zien we later wel" is
het duurste antwoord.

1. **Wat kan iemand straks dat nu niet kan?** Eén zin, vanuit de gebruiker geschreven.
2. **Wie gaat het gebruiken?** Hoeveel mensen, eigen personeel of ook mensen van buiten.
3. **Welke gegevens gaan erin?** En of daar persoonsgegevens bij zitten.
4. **Wat is de eerste versie waar iemand echt iets aan heeft?** Het kleinste ding dat
   maandag al gebruikt zou worden.

## De database: twee standen

- **Geen database.** De app draait alleen op de hosting. Kost niets extra. Past bij een
  rekenhulp, een formulier, een overzicht uit een vaste bron, een app voor één persoon
  zonder inloggen. Later alsnog een database erbij kan, met hulp van Stage Two.
- **Eigen database.** Nodig bij inloggen, meerdere mensen die tegelijk werken, relaties
  tussen gegevens, veel records. **Kost maandelijks geld** en wordt eenmalig door Stage
  Two ingericht. Je kunt intussen gewoon bouwen: de kwaliteitspoort draait tegen een
  eigen testdatabase.

Verwacht je binnen een jaar inloggen of meerdere mensen die gegevens invoeren? Kies dan
nu al een eigen database; dat scheelt een verhuizing.

## Wat er daarna gebeurt

`/stack:nieuwe-app` maakt de repo aan als kopie van de openbare template
(github.com/Stage-Two-AI/stack-template), vult de naam in, zet de databasestand, zet de
eerste versie op GitHub en beschermt de hoofdtak. De hosting (Vercel) en een eigen
database (Supabase) koppelt Stage Two: daarvoor is toegang nodig die bewust niet op een
werkcomputer staat. Laat Stage Two dus weten dat de app bestaat, met naam en link.

Begin **niet** alvast zelf met bouwen in een losse map zonder deze route: dat werk kan
niet overgezet worden naar de nieuwe app zonder alles opnieuw te doen.
