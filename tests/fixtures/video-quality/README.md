# FastVid — vaste testset en kwaliteitsmeting

Meetinfrastructuur, geen pipeline-logica. Niets hier verandert een render.

## Bestanden

| Bestand | Inhoud |
| --- | --- |
| `prompts.json` | De twaalf vaste testprompts (`vq-01` … `vq-12`): id, genre, prompt, vaste scriptversie (nog `null`), verwachte visuele strategie. De strategie is een **testverwachting**, geen gedwongen uitkomst. |
| `human-rating.schema.json` | JSON Schema voor één menselijke beoordeling: zes scores 1–5 en het gemiddelde. |
| `human-ratings.json` | De ingevulde beoordelingen. **Leeg tot een mens ze invult.** Er worden nooit scores gegenereerd. |
| `render-645.worker.log` | Echte samenvattingsregels uit het Railway-workerlog van render 645 (Tesla, 2026-10-11), gefilterd op de regels die de analyser leest. Geen sleutels of URL's. |

## Twee echte chapter cards als fixture

`primary-card-short-title.png` en `primary-card-wide-title.png` zijn frames van een fullscreen
`chapter_card` zoals de Remotion-bundel van dit project ze zelf tekent (`PrimaryStage` op
`PRIMARY_GROUND`, Graphics.tsx), gerenderd op 1920×1080 met `renderStill` en daarna verkleind naar
320×180. Ze zijn de ijking van de placeholder-herkenning in `postRenderSpotCheck.ts`
(`readGroundFrame`): een korte titel en een titel die tot de zijkanten van het beeld loopt. De
tests in `server/hardQualityGate.test.ts` lezen ze terug via ffmpeg en encoderen ze in een
testfilm, zodat de scan over alle frames wordt bewezen op een echte kaart en niet alleen op een
synthetische vlakke kleur.

## De analyser lokaal draaien

```
npx tsx server/railwayLogAnalyser.ts <worker.log> --video 645 --pretty
```

Invoer: een Railway-logexport van de worker (regels `HH:MM:SS.mmm i [Tag] …` of met ISO-datum ervoor).
Uitvoer: één `RenderQualityReport` (JSON) per render-id, plus hoeveel regels dubbel, ongeldig of niet toe te wijzen waren.
Onbekende waarden zijn `null`, nooit 0; elk cijfer heeft een herkomst in `provenance` (measured / derived / estimated / unknown) en de formules staan in `notes`.

## Twee extra secties in het rapport

* `coverage` — de harde eis per zin: `sentenceVisualCoverage` (zinnen met zichtbaar beeld of een inhoudelijke graphic), `uncoveredSentenceCount`, `blueGrayPlaceholderSeconds` (seconden dat de blauwgrijze kaartondergrond `PRIMARY_GROUND` het beeld is, gemeten op de timeline-kaartclips uit `[EDL]`, **niet** op de MP4), `placeholderDetected`, `deliveredFileCheck` (de bestaande `contentCheck` van het bestand: zwart/freeze/stilte) en `visualCoverageFailures` (zin, tekst, redenen).
* `secondSection` — de tweede-sectieroute, geteld uit haar eigen `[SecondSection]`-regels (aangevraagd ≠ gesneden ≠ aangeboden ≠ FIT ≠ geplaatst); `active=false` met alle tellers 0 als de render de route niet kende (render 645), `null` als er niets te lezen is.

## Een menselijke beoordeling toevoegen

Voeg een object toe aan `human-ratings.json` dat aan `human-rating.schema.json` voldoet, bijvoorbeeld:

```json
{
  "renderId": "645",
  "testId": "vq-01-tesla-growth-competition",
  "gitSha": "87651b6",
  "ratedAt": "2026-10-12T09:00:00Z",
  "rater": "initialen",
  "scores": { "pictureMatchesSpeech": 3, "visualVariety": 2, "editingAndPace": 3, "voiceoverAndSubtitles": 4, "chartsAndExplanation": 2, "overallViewingQuality": 3 },
  "averageScore": 2.83,
  "note": "korte toelichting"
}
```

`server/videoQualityMetrics.test.ts` controleert dat elk opgeslagen record geldig is en dat `averageScore` klopt.

## Wat nog ontbreekt

* `promptId` en `gitSha` staan niet in de logs van de worker; het rapport laat ze `null` tot de pipeline ze één keer per render logt.
* Historische Railway-logs zijn niet lokaal opgeslagen; alleen render 645 is als fixture aanwezig.
* De twaalf prompts zijn nog niet gerenderd; een productie-uitvoering kost credits en vereist afzonderlijke toestemming.
