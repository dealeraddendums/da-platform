# Fleet stale-feed scan — 2026-10-09

Generated 2026-10-09T04:57:12.365Z by `POST /api/cron/feed-health?report=1` (read-only) over **2033 active dealers**, 0 errors. Same definition as Steven's `get_feed_provider` — `lib/feed-health.ts`.

## Definitions

- **Live feed** = a roster row (Fortellis enabled / CDK not Off / Tekion) or active vehicles written by a running pipeline: `FORTELLIS_*`, `CDK_*`, `automatic<N>` (ETL2). **Not** a feed: `VIN API` (dormant 4.0 copy), `csv_import`, `APP`, and hand-added rows (VIN decoder, `created_by` NULL).
- **Stale** = a store with feed vehicles where **none** was refreshed in the last 3 days **and** the newest feed-added vehicle is more than 7 days old.
- **Updating** = anything with feed vehicles that isn't stale. **Feed set up, no vehicles** = roster row but no feed vehicles. **No live feed** = neither (CSV / hand-added) — not broken, listed separately.
- **Printing** = vehicles with a print date in the last 14 days (5.0 prints + 4.0 prints synced nightly).

## Headline

| Health | Stores |
|---|---|
| Updating | 1236 |
| **Stale** | **13** |
| Feed set up, no vehicles | 0 |
| No live feed (CSV / hand-added) | 784 |

**Stale and printing in the last 14 days: 1.** All 13 stale stores are **still on 4.0** (0 on 5.0), so the stale data today is their 5.0 inventory copy; whether their 4.0 printing is also affected depends on the separate 4.0 feed pipeline (not checked here).

## Stale feeds (worst first)

| Store | Dealer ID | Provider | Feed | Newest feed vehicle | Days | Feed / active | Refreshed 3d | Printed 14d | Platform |
|---|---|---|---|---|---|---|---|---|---|
| Chuck Fairbanks Chevrolet | 3PA0004288 | CDK | CDK | 2026-09-24 | 14 | 370/387 | 0% | 5 | 4.0 |
| M'Lady Nissan | 4384 | unknown | ETL2 job 79 | 2026-05-08 | 153 | 474/474 | 0% | 0 | 4.0 |
| Rick Case Hyundai Roswell | 3PA0003717-R | unknown | ETL2 job 9 | 2026-05-18 | 144 | 12/932 | 0% | 0 | 4.0 |
| Rick Case Kia Duluth | 3PA0003717-K | unknown | ETL2 job 9 | 2026-05-18 | 144 | 5/5 | 0% | 0 | 4.0 |
| Genesis of Gwinnett | 3PA0003717-G | CDK | ETL2 job 9 | 2026-05-18 | 144 | 4/4 | 0% | 0 | 4.0 |
| Doral Genesis | 3PA111786 | CDK | CDK | 2026-06-02 | 128 | 103/103 | 0% | 0 | 4.0 |
| Audi Gwinnett | 3PA0003717-A | CDK | ETL2 job 9 | 2026-06-07 | 123 | 5/5 | 0% | 0 | 4.0 |
| Genesis of Roswell | 3PA0003717-S | CDK | ETL2 job 9 | 2026-08-19 | 50 | 2/155 | 0% | 0 | 4.0 |
| Hicks Family Subaru | 3PA79471 | CDK | CDK | 2026-08-30 | 39 | 586/586 | 0% | 0 | 4.0 |
| Audi Coral Springs | 3PA107826 | CDK | CDK | 2026-09-04 | 34 | 1150/1150 | 0% | 0 | 4.0 |
| FINDLAY VOLKSWAGEN | 3PA0002993 | CDK | CDK | 2026-09-23 | 15 | 276/276 | 0% | 0 | 4.0 |
| Bob Utter | 3PA0003649 | CDK | CDK | 2026-09-27 | 11 | 908/915 | 0% | 0 | 4.0 |
| SPARTANBURG HONDA | 3PA120975 | CDK | CDK | 2026-09-30 | 8 | 1233/1243 | 0% | 0 | 4.0 |

Notes: the four Rick Case rooftops (3PA0003717-*) match the CDK feed turned off on the legacy feeds box on 2026-08-14 (60k-row wedge). Most of the rest are CDK — check them against the CDK PIP → Fortellis cutover.

## No live feed — not broken, but never-retired inventory (on 5.0)

784 active stores have no automatic feed (CSV or hand-added). That is a legitimate setup, but **nothing ever marks a hand-added car sold**, so their active list grows forever. These 26 stores **on 5.0** have 50+ hand-added active vehicles older than 180 days (likely sold):

| Store | Dealer ID | Active | Hand-added > 180 days | Printed 14d |
|---|---|---|---|---|
| Scott Clark Honda | 5235 | 6041 | 4991 | 94 |
| Toyota of El Cajon | 1620839604 | 4441 | 3868 | 0 |
| Brandon Ford | 1403037817 | 3732 | 2936 | 155 |
| Burns Honda | burnshonda | 3576 | 2864 | 104 |
| Puente Hills Nissan | MP24217 | 3399 | 2854 | 6 |
| Hendrick Toyota Wilmington | 1701183768 | 2820 | 2560 | 4 |
| Benton Nissan of Columbia | bentoncolumbia | 3047 | 2348 | 108 |
| Keffer Kia | 1717514454 | 2016 | 1789 | 22 |
| NORTH HOLLYWOOD HONDA | ICC12 | 1968 | 1780 | 5 |
| SPRINGFIELD HYUNDAI | potamkinspringfieldhyundai | 1989 | 1679 | 1 |
| Puente Hills Ford | 24842 | 1738 | 1496 | 8 |
| Jim White Honda | jimwhitehondaoh | 1682 | 1480 | 0 |
| Morgan City Toyota | 1733853691 | 1484 | 1345 | 11 |
| Naples Nissan | 1701468709 | 1386 | 1309 | 79 |
| PARADISE CHEVROLET | icc007 | 1498 | 1305 | 0 |
| JStar Motors | jstarmotors | 1143 | 943 | 0 |
| American Luxury Coach | 1591306877 | 887 | 673 | 26 |
| MYRTLE BEACH HYUNDAI | 13913 | 695 | 552 | 42 |
| Acura of Omaha | acuraofomahaadw | 527 | 457 | 0 |
| DCH HONDA OXNARD | icc003 | 961 | 352 | 0 |
| BMW of South Atlanta | 1755624238 | 410 | 324 | 2 |
| Atlantic Coast Honda | 1771428335 | 516 | 248 | 11 |
| Hanlees Hilltop Nissan | 25329 | 217 | 183 | 3 |
| Kunes Country Ford of Antioch | MP4564 | 199 | 173 | 4 |
| American Shade Window Tint | 1763922467 | 455 | 52 | 60 |
| Butler Ford | 1774876678 | 75 | 52 | 0 |

## Healthy feed, but a large never-retired hand-added backlog (on 5.0)

35 stores on 5.0 have an updating feed **and** 200+ hand-added active vehicles older than 180 days — the feed retires its own rows, but not hand-added ones:

| Store | Dealer ID | Feed vehicles | Active | Hand-added > 180 days |
|---|---|---|---|---|
| Toyota of San Bernardino | MP8273 | 405 | 4790 | 4292 |
| Toyota of Brookfield | MP16353 | 173 | 3622 | 3366 |
| Simi Valley Toyota | MP21288 | 168 | 2860 | 2299 |
| Tamiami Ford | MP10366 | 830 | 2476 | 1633 |
| Simpson Chevrolet of Garden Grove | MP13515 | 160 | 1917 | 1583 |
| ALM Hyundai | 7845773 | 196 | 1723 | 1446 |
| Audi Henderson | MP18908 | 333 | 1745 | 1397 |
| DAVID WILSON'S MAZDA OF ORANGE | MP3365 | 243 | 1291 | 1037 |
| Toyota Carlsbad | 8917037 | 54 | 1066 | 981 |
| Tallahassee Ford Lincoln | MP16550 | 352 | 1303 | 938 |
| Kia Delray | 9058274 | 230 | 1441 | 808 |
| AutoNation Toyota Cerritos | 18859 | 409 | 1323 | 766 |
| PERFORMANCE KIA  | 9021297 | 254 | 1119 | 745 |
| Hemborg Ford | MP749 | 286 | 936 | 645 |
| ALM Hyundai West | MP90513 | 497 | 1134 | 618 |
| Stevenson Hendrick Honda | shhonda | 404 | 993 | 578 |
| Surf City Nissan | SURF CITY NISSAN | 260 | 797 | 537 |
| SEDANO FORD | MP88725 | 566 | 1109 | 527 |
| Al Packer Lincoln | 46144 | 296 | 785 | 485 |
| Al Packer Ford | 19356 | 500 | 960 | 458 |
| Dickson City Hyundai  | Dkcity24 | 1316 | 1789 | 436 |
| TOYOTA OF RIDGECREST | toyridge | 67 | 537 | 435 |
| Kennesaw Mazda | MP91912 | 333 | 735 | 397 |
| Mossy of Picayune | mossypica2024 | 299 | 687 | 382 |
| Lehighton Kia  | lehightonkia | 150 | 534 | 381 |
| Al Packer Ford Royal Palm Beach | 23119 | 578 | 955 | 376 |
| Villa Ford | MP5676 | 456 | 878 | 371 |
| Stevenson Hendrick Mazda | shmazda | 290 | 643 | 351 |
| Al Packer’s White Marsh Ford | 21924 | 341 | 671 | 330 |
| SERRA NISSAN VOLKWAGEN | MP7878 | 259 | 522 | 260 |
| ROCK HONDA | 3PA105705 | 3149 | 3389 | 236 |
| DARCARS Lexus of Silver Spring | MP23090 | 440 | 688 | 226 |
| Napleton Mazda of Naperville | NAPLETON33 | 285 | 521 | 226 |
| Corona Nissan | CORONA NISSAN | 455 | 671 | 213 |
| Ford of Upland | fordup24 | 283 | 502 | 203 |

## Spot checks

- **Burns Honda** (burnshonda) → `no_live_feed` — no feed — hand-added, never retired: 0 feed / 3576 active, newest feed vehicle —, hand-added > 180d 2864.
- **Mercedes Benz of Fremont** (9103991) → `updating` — healthy Homenet feed: 705 feed / 705 active, newest feed vehicle 2026-10-08, hand-added > 180d 0.
- **Riverside Ford Lincoln** (MP2621) → `updating` — healthy vAuto feed: 224 feed / 227 active, newest feed vehicle 2026-10-08, hand-added > 180d 0.
- **QA Test Dealer A** (qa-test-dealer-a) → `no_live_feed` — manual QA store: 0 feed / 5 active, newest feed vehicle —, hand-added > 180d 0.
- **Toyota Carlsbad** (8917037) → `updating` — Tekion feed + old hand-added backlog: 54 feed / 1066 active, newest feed vehicle 2026-10-09, hand-added > 180d 981.

Remediation of any store (re-connecting a feed, retiring vehicles) is a separate, approved, backed-up step per store.

## Update — digest test, 05:01 UTC

Two more stores crossed the 7-day line minutes after the scan above and went **stale**: **Doral Acura (3PA116793)** and
**Audi Fort Lauderdale (3PA107771)** — both ETL2 job 9, newest vehicle and last refresh 2026-10-01 05:01. With the
Rick Case rooftops also on job 9, **job 9 looks to have stopped delivering around 2026-10-01** (worth checking first).
Stale total: **15**. The digest emailed them as "newly stale" on its next run — the de-dup working as designed.

Digest: daily via `/api/cron/harvest-vin-trims` (03:00 UTC, fire-and-forget) → `/api/cron/feed-health` logic; emails
support@ + allan@ only when a store becomes stale or recovers (`admin_settings.feed_health_alert_state`). A dedicated
EasyCron entry for `POST /api/cron/feed-health` is optional; double runs are harmless.
