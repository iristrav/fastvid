# FASTVID — WAAR YOUTUBE ECHT VERDWEEN

```
CODE STATUS:   READY — origin/main cf38573, worker deploy SUCCESS
RENDER STATUS: NOT STARTED
REASON:        USER ENQUEUE REQUIRED
```

---

## 1. De meting die de opdracht herschreef

De briefing ging ervan uit dat de cinematic editor YouTube-clips vervangt door archief. Render 602's
logs zeggen iets anders, en het is niet klein:

```
[SearchGate] provider=youtube_cc built=36 validated=34 sent=34 blocked=2
```

Zoeken werkt. Daarna:

| Stap | Aantal |
|---|---|
| Downloads geprobeerd | ~22 |
| **DOWNLOAD_FAILED** | **20** — 14× `download_timeout`, 6× `download_error` |
| Gedownload, nooit beoordeeld | 4 |
| Beoordeeld als **FIT** en geadopteerd | **2** |
| In de film | **0** |

**De bindende beperking op YouTube is niet de selectie. Het is de download.**

Mijn bronvoorkeur uit de vorige ronde werkt op kandidaten die download én vision hebben overleefd.
Dat waren er twee van de tweeëntwintig. De voorkeur had vrijwel niets om over te beslissen — dus
meer selectielogica bouwen zou schijnvooruitgang zijn geweest.

---

## 2. Defect 1 — de memo onthield een bestand dat de pipeline weggooide

Elke mislukte download droeg dezelfde vorm:

```
attempts=cloud:DOWNLOAD_FAILED(cloud_egress_blocked:cloud_egress_other),
         rapidapi:DOWNLOAD_TIMEOUT(scene_budget_0s_left)
reason=scene_budget_too_short_to_start
```

`scene_budget_0s_left` — het scènebudget was al op. Waar ging het heen?

```
[YouTubeDownload] video=C6T9Mvn3TY0 DOWNLOAD_SUCCESS … reason=rapidapi   ×4
[YouTubeDownload] video=fof6zEzfSlQ DOWNLOAD_SUCCESS … reason=rapidapi   ×3
```

Twee video's, zeven keer opgehaald, **nooit één keer** `source_reuse`. RONDE 261 bouwde een memo om
precies dat te voorkomen. Hij vuurde nooit:

```ts
noteYoutubeSourceFile(videoId, tmpPath, rapidFileSize);   // "het bestand staat hier"
...
} finally {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);     // en weg is het
}
```

Het `finally` liep op **elk** pad, ook bij succes. Dus `youtubeSourceFile` vond zijn entry,
`fs.existsSync` zei nee, en de hergebruikroute viel door naar een volledige nieuwe download.

> De ene kant noteerde het antwoord, de andere gooide weg waar het antwoord naar verwees, en niets
> verbond de twee. RONDE 261 kon zelf nooit zien dat zijn eigen teller op nul bleef staan.

**De fix.** De memo geeft nu terug *of* hij heeft opgeslagen — dezelfde vorm als
`noteCloudEgressBlocked`, die al teruggeeft of hij de latch sloot — en de delete luistert daarnaar.
First-writer-wins betekent dat het pad van een aanroeper níét het opgeslagen pad hoeft te zijn, dus
het krijgen van dat antwoord is de hele fix.

**Begrensd.** Bestanden bewaren maakt van een memo schijfruimte. Boven een plafond (512 MB,
`YOUTUBE_SOURCE_HOLD_MB`) neemt de memo niets meer aan en gedraagt alles zich exact als vóór deze
wijziging. Degraderen naar het oude gedrag is de enige veilige richting voor een cache — en op deze
runner falen writes bij een volle schijf terwijl deletes nog slagen, wat een veel slechtere render
is dan een dubbele download.

**De cut is onaangeraakt.** De hergebruikroute leidt zijn eigen trim af uit hetzelfde bestand, met
zijn eigen `clipStart` en `duration`. Alleen de transfer wordt overgeslagen.

---

## 3. Defect 2 — de route werd betaald voordat hij gevraagd werd

Op jouw vraag *"kunnen we dan niet beter altijd rapidapi gebruiken?"*

De latch die de dode cloudroute overslaat heeft **drie** opeenvolgende weigeringen nodig, en wordt
bij elke render gewist. Het enige dat zo'n weigering kon leveren was een download die zijn hele
window al had opgemaakt. Render 599, één scène:

```
Cloud DL failed z2kp1wkRE8o: … exceeded 117s — falling back to RapidAPI
Cloud DL failed FLal-KvTNAQ: … exceeded 117s — falling back to RapidAPI
Cloud DL failed aZbpVsQzBeU: … exceeded  84s — falling back to RapidAPI
Cloud DL failed 7bx_yqMF3jc: … exceeded  54s — falling back to RapidAPI
```

> *"The scene's wall was 276s and it used 280s, so five later YouTube candidates were refused before
> they started, under the 12s floor."*

`egressRefusalReason` vraagt de service zijn eigen `/health/egress` en antwoordt in milliseconden.
RONDE 258 bouwde hem — en hing hem aan het **timeout**-pad. Dus ná de kosten die hij moest
voorkomen. Dezelfde signatuurfout: het antwoord bestond, was gepubliceerd, en werd niet opgehaald op
het moment dat een beslissing ervan afhing.

**De fix.** De probe is nu een tweede *bron* van hetzelfde bewijs. Een strike kost een milliseconde
in plaats van twee minuten.

### Waarom ik jouw voorstel niet heb uitgevoerd

```
RapidAPI fetches the WHOLE source before trimming, so closing this route
closed the only one that fetches just the seconds a beat needs.
```

De cloudroute vraagt `?id=&duration=&start=` — alleen de seconden van die beat. RapidAPI haalt de
hele video en knipt daarna. Dit bestand heeft "altijd de snelle route" twee keer eerder afgewezen,
en render 582 is wat het kostte toen het toch gebeurde.

**Maar je punt wint terrein.** Door defect 1 wordt die hele-video-download nu bewaard en hergebruikt,
dus je betaalt hem één keer per video in plaats van één keer per beat. Als de volgende render laat
zien dat `source_reuse` werkelijk vuurt, is "altijd rapidapi" een serieuzer voorstel dan het
vanochtend was — en dan met cijfers in plaats van een vermoeden.

---

## 4. Twee dingen die ik onderweg moest intrekken

**A. `strict_voice_refill` is niet de blocker die ik zei.** Beide takken van
`refillSceneStrictVoiceMatch` seeden al uit de geadopteerde clips (RC-3, na render 589). En 602's
"REPLACED" regels tonen hetzelfde bestand onder een nieuw lineage-id:

```
#26  scene_2_ytfu_0__pid_youtube_cc-921a74541ec6341d_transformed.mp4  outcome=REPLACED derivedIds=#104
#104 scene_2_ytfu_0__pid_youtube_cc-921a74541ec6341d_transformed.mp4  ADOPTED
```

Het beeld verdween niet; de administratie verschoof. Dat was opnieuw een verhaal op logvolgorde.

**B. "De dode cloudroute eet het budget op" klopte ook niet.** De latch slaat hem over en dat kost
niets — `cloud_egress_blocked` is de *overgeslagen* route, niet een mislukte.

**C. En mijn eerste versie van fix 2 was fout.** Ik vroeg de probe één keer per render en nam aan dat
dat de latch sloot. **Mijn eigen test ving het**: de latch eist er drie, en die drie hebben een goede
reden — een roterende residentiële proxy betekent dat één weigering over één IP uit negentig miljoen
gaat. Drempel ongewijzigd; alleen de kosten van een strike zijn gedaald.

---

## 5. Wat ik NIET heb gebouwd, en waarom

§4 (dekking over de hele video), §5 (meerdere kandidaten bewaren), §6/§8 (meer shots), §7 (segmenten
splitsen), §9 (motion), §10 (transitions).

Die werken allemaal op clips die de montage halen. In 602 waren dat er nul, in 600 vier. Zolang 20
van de 22 downloads faalt, heeft dekkingslogica niets om over te beslissen. **Dit is een inschatting
van mij, geen uitstel** — als de volgende render laat zien dat er wél YouTube-clips binnenkomen, zijn
§4–§10 het volgende, dan met echte aantallen om tegen te toetsen.

---

## 6. Status

| | |
|---|---|
| `origin/main` | **`cf38573`** |
| fastvid worker | deploy `11aba17b` — **SUCCESS** |
| Testsuite | 769 bestanden, **12.608 groen**, 21 skipped, **0 rood** |
| `tsc --noEmit` | schoon |
| Nieuwe tests | 33 |
| Ankers verplaatst / verzwakt | 1 / **0** |
| Gates versoepeld, drempels verlaagd, routes verwijderd | **geen** |

Commits:

| | |
|---|---|
| `3788717` | a held source is not deleted before it is used |
| `cf38573` | the route is asked before it is paid for |

---

## 7. Volgende stap

> **Start één render, zelfde onderwerp: Berlin / 1945 / Führerbunker / Hitler.**

Ik push niets tot hij klaar is.

Drie regels die ik als eerste zoek:

```
[Pipeline] yt-dlp egress preflight says …        goedkoop geleerd i.p.v. een window betaald
[Pipeline] holding <videoId>'s source …          de memo bewaart nu werkelijk
[YouTubeDownload] … reason=source_reuse          en hij wordt gebruikt
```

Daarna het getal dat telt: hoeveel `scene_budget_0s_left` er nog over is — en of er eindelijk een
YouTube-clip in de eindmontage staat.

**Wat ik niet beloof:** dat dit 70–90% YouTube oplevert. Deze twee fixes halen verspilling weg uit
het downloadpad. Of dat genoeg is om het doel te halen, weet ik pas als ik de volgende trechter zie.
