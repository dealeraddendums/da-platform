# Fleet stale-feed scan — 2026-10-10 (adds FROZEN feeds)

Generated 2026-10-11T00:40:32.264Z by `POST /api/cron/feed-health?report=1` (read-only) over **2028 active dealers**, 0 errors. Definitions: `lib/feed-health.ts`. Previous report: `stale-feed-scan-20261009.md`.

## What changed

The scan now flags two kinds of broken feed:

- **Feed stopped** (`health = stale`, unchanged): none of the store's feed vehicles refreshed in 3 days AND no feed vehicle added in over 7 days.
- **Frozen — refreshing but no new inventory** (`frozen`, new): the feed IS refreshing the store's rows, but has added no NEW vehicle in over **21 days** (`FROZEN_NEWEST_DAYS`). Usually a provider resending the same file. Before this, these read as "updating".

Live data has a clean gap — every refreshing store either had a new vehicle within ~30 days or none for 70+ days — so 21 sits in it. `frozen` is internal (scan + digest); Steven's dealer-facing `feed_health` is unchanged. Feed-less stores (CSV / hand-added) are never either.

## Headline

| | Stores |
|---|---|
| Updating (healthy) | 1203 |
| **Frozen — refreshing but no new inventory** | **33** |
| **Feed stopped** | **16** |
| No live feed (CSV / hand-added) — not flagged | 776 |

Frozen and printing in the last 14 days: **2** (Kia Delray, Ford of Upland). Frozen on 5.0: 4.

## Frozen — refreshing but no new inventory (worst first)

| Store | Dealer ID | Provider | Feed | Newest feed vehicle | Days | Feed / active | Refreshed 3d | Printed 14d |
|---|---|---|---|---|---|---|---|---|
| Ford of Upland | fordup24 | DealerTrack | ETL2 job 5 | 2026-05-06 | 157 | 283/502 | 88% | 2 |
| Kia Delray | 9058274 | unknown | ETL2 job 79 | 2026-05-08 | 155 | 230/1468 | 100% | 55 |
| Legacy Toyota of Dallas | legacytoyotaofdallas | DealerInspire | ETL2 job 47 | 2026-05-06 | 157 | 261/2042 | 100% | 0 |
| Mark Kia | mk2022 | unknown | ETL2 job 5 | 2026-05-06 | 157 | 621/1001 | 48% | 0 |
| Genesis of Naples | GenesisofNaples | unknown | ETL2 job 47 | 2026-05-06 | 157 | 632/967 | 98% | 0 |
| Elk Grove Acura | elk grove acura | Advent | ETL2 job 28 | 2026-05-06 | 157 | 177/848 | 99% | 0 |
| Dimmitt Chevrolet | DimmittChevroletDA | unknown | ETL2 job 21 | 2026-05-06 | 157 | 349/368 | 100% | 0 |
| HARBIN FORD | HarbinMotorCoIncDA | unknown | ETL2 job 21 | 2026-05-06 | 157 | 354/367 | 38% | 0 |
| Benoit Nissan | BenoitNissan2025 | unknown | ETL2 job 47 | 2026-05-06 | 157 | 181/324 | 97% | 0 |
| Land Rover Cerritos | DVD57552 | unknown | ETL2 job 1 | 2026-05-06 | 157 | 190/246 | 84% | 0 |
| Kia South Austin | KiaSouthAustin | unknown | ETL2 job 6 | 2026-05-06 | 157 | 237/237 | 73% | 0 |
| PERFORMANCE KIA | 9021297 | unknown | ETL2 job 79 | 2026-05-08 | 155 | 254/1119 | 74% | 0 |
| CDJR San Antonio | sacdjr | unknown | ETL2 job 79 | 2026-05-08 | 155 | 645/645 | 85% | 0 |
| Hyundai Escondido | 9046585 | Homenet | ETL2 job 79 | 2026-05-08 | 155 | 402/403 | 100% | 0 |
| Toyota Escondido | 32329 | Homenet | ETL2 job 79 | 2026-05-08 | 155 | 178/390 | 99% | 0 |
| CLASSIC NISSAN OF NEWPORT NEWS | ClassicNissanofNewportNews | Homenet | ETL2 job 79 | 2026-05-08 | 155 | 264/265 | 78% | 0 |
| Melloy Ford | 146739 | Reynolds | ETL2 job 50 | 2026-05-21 | 142 | 200/204 | 69% | 0 |
| Melloy Chrysler Dodge Jeep Ram | 146741 | Reynolds | ETL2 job 50 | 2026-05-21 | 142 | 188/202 | 65% | 0 |
| Melloy Chevrolet | 146740 | Automate | ETL2 job 50 | 2026-05-21 | 142 | 100/112 | 65% | 0 |
| AutoNation Honda Tucson | 17692 | unknown | ETL2 job 51 | 2026-06-02 | 130 | 190/194 | 100% | 0 |
| Hessert Chevrolet | hessert01 | unknown | ETL2 job 5 | 2026-06-02 | 130 | 192/192 | 84% | 0 |
| Arcadia Chevrolet Buick | 19164 | Homenet | ETL2 job 79 | 2026-06-02 | 130 | 185/185 | 97% | 0 |
| Vaden Hyundai of Brunswick | VadenHyundaiBrunswickDA | DealersLink | ETL2 job 21 | 2026-06-10 | 122 | 180/269 | 92% | 0 |
| Volkswagen of Waco | 4959 | unknown | ETL2 job 54 | 2026-07-30 | 72 | 219/219 | 70% | 0 |
| Steele Chrysler Jeep Dodge Ram Gonzales | 4731 | unknown | ETL2 job 54 | 2026-07-30 | 72 | 99/99 | 64% | 0 |
| Steele North Star Chrysler Jeep Dodge Ram | 4824 | unknown | ETL2 job 54 | 2026-07-31 | 71 | 202/202 | 80% | 0 |
| Steele GMC Round Rock | 4748 | unknown | ETL2 job 54 | 2026-08-01 | 70 | 414/414 | 76% | 0 |
| Steele Hyundai Kyle | 4958 | unknown | ETL2 job 54 | 2026-08-01 | 70 | 352/372 | 99% | 0 |
| Steele Hyundai of New Braunfels | 4961 | unknown | ETL2 job 54 | 2026-08-01 | 70 | 269/269 | 77% | 0 |
| Steele Chevrolet GMC of Luling | 4539 | unknown | ETL2 job 54 | 2026-08-01 | 70 | 80/80 | 78% | 0 |
| Steele Chrysler Jeep Dodge Ram Lockhart | 4732 | unknown | ETL2 job 54 | 2026-08-01 | 70 | 73/73 | 58% | 0 |
| Alfa Romeo of Plano | MP10298A | Vauto | ETL2 job 75 | 2026-09-10 | 30 | 11/11 | 100% | 0 |
| Performance Ford West Covina | MP22607 | Vauto | ETL2 job 75 | 2026-09-12 | 28 | 63/67 | 98% | 0 |

## Feed stopped (worst first)

| Store | Dealer ID | Provider | Feed | Newest feed vehicle | Days | Feed / active | Refreshed 3d | Printed 14d |
|---|---|---|---|---|---|---|---|---|
| Chuck Fairbanks Chevrolet | 3PA0004288 | CDK | CDK | 2026-09-24 | 16 | 370/387 | 0% | 5 |
| M'Lady Nissan | 4384 | unknown | ETL2 job 79 | 2026-05-08 | 155 | 474/474 | 0% | 0 |
| Rick Case Hyundai Roswell | 3PA0003717-R | unknown | ETL2 job 9 | 2026-05-18 | 146 | 12/932 | 0% | 0 |
| Rick Case Kia Duluth | 3PA0003717-K | unknown | ETL2 job 9 | 2026-05-18 | 146 | 5/5 | 0% | 0 |
| Genesis of Gwinnett | 3PA0003717-G | CDK | ETL2 job 9 | 2026-05-18 | 146 | 4/4 | 0% | 0 |
| Doral Genesis | 3PA111786 | CDK | CDK | 2026-06-02 | 130 | 103/103 | 0% | 0 |
| Audi Gwinnett | 3PA0003717-A | CDK | ETL2 job 9 | 2026-06-07 | 125 | 5/5 | 0% | 0 |
| Genesis of Roswell | 3PA0003717-S | CDK | ETL2 job 9 | 2026-08-19 | 52 | 2/155 | 0% | 0 |
| Hicks Family Subaru | 3PA79471 | CDK | CDK | 2026-08-30 | 41 | 586/586 | 0% | 0 |
| Audi Coral Springs | 3PA107826 | CDK | CDK | 2026-09-04 | 36 | 1150/1150 | 0% | 0 |
| FINDLAY VOLKSWAGEN | 3PA0002993 | CDK | CDK | 2026-09-23 | 17 | 276/276 | 0% | 0 |
| Bob Utter | 3PA0003649 | CDK | CDK | 2026-09-27 | 13 | 908/915 | 0% | 0 |
| SPARTANBURG HONDA | 3PA120975 | CDK | CDK | 2026-09-30 | 10 | 1233/1243 | 0% | 0 |
| Doral Acura | 3PA116793 | CDK | CDK | 2026-10-01 | 9 | 1098/1098 | 0% | 0 |
| Audi Fort Lauderdale | 3PA107771 | CDK | CDK | 2026-10-01 | 9 | 929/929 | 0% | 0 |
| GREENSBORO NISSAN | 3PA114232 | CDK | CDK | 2026-10-02 | 8 | 1279/1279 | 0% | 0 |

## Job 21 (DealersLink) audit cross-check

The audit's 10 frozen Job 21 feeds: only 3 belong to an ACTIVE store, and all 3 are now flagged frozen — Dimmitt Chevrolet, HARBIN FORD, Vaden Hyundai of Brunswick. The other 7 can't appear in a per-store health scan:

- **Deactivated stores (`active=false`), feed still delivering:** Vaden CDJR Savannah, Vaden Hyundai of Statesboro, Vaden CDJR Brunswick.
- **Feed id matches no dealer at all (unattached rows):** BentleyBuickGMCDA, BlackwellCDJRKiaDA, SubaruofOrangeParkDA, McClintonChevroletMitsubishiDA — same class as the DealersLink id-mapping fix; several LIVE unattached Job 21 ids exist too (WildWestFordDA, AlanJayFordLincolnDA, AlanJayKiaAllstarDA, CountrysideMadison, warechevroletDA, QualityAutoDA, QABlackHillsDA, QACasperDA).
