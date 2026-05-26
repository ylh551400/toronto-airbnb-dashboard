# Toronto Airbnb Market Dashboard

**Live demo →** [toronto-airbnb-dashboard.vercel.app](https://toronto-airbnb-dashboard.vercel.app)

A data pipeline and interactive dashboard that maps 15,776 Toronto Airbnb listings across 140 neighbourhoods into four market quadrants. Built as a portfolio project to demonstrate end-to-end data engineering, from raw CSV to live, auto-updating web product.

---

## What it does

Every neighbourhood is scored on two axes — **occupancy** (estimated nights booked per year) and **guest rating** — then placed into one of four quadrants:

| Quadrant | Occupancy | Rating | Story |
|---|---|---|---|
| Q1 Star | ≥ median | ≥ median | Highly booked *and* highly rated — market leaders |
| Q2 Volume | ≥ median | < median | Busy but under-delivering on guest experience |
| Q3 Hidden Gem | < median | ≥ median | Well-reviewed but underdiscovered |
| Q4 Struggling | < median | < median | Low demand and low satisfaction |

The dashboard also surfaces amenity impact on bookings, room type composition, property type comparisons, a 3-year monthly activity trend, and neighbourhood leaderboards.

---

## Pipeline architecture

```
Inside Airbnb CSV  (manual download, quarterly)
        │
        │  git push rawdata_new/
        ▼
┌─────────────────────────────────────┐
│  GitHub Actions                     │
│                                     │
│  1. clean.py   — normalise & dedupe │
│  2. analyze.py — pre-compute stats  │
│  3. load.py    — upsert to database │
└─────────────────────────────────────┘
        │
        │  supabase-py  (service role key, stored as GH Secret)
        ▼
┌─────────────────────────────────────┐
│  Supabase  (Postgres + REST API)    │
│  8 tables, all pre-computed         │
└─────────────────────────────────────┘
        │
        │  fetch() on page load  (anon key, safe to expose)
        ▼
┌─────────────────────────────────────┐
│  Vercel  (static frontend)          │
│  Chart.js · Leaflet · vanilla JS    │
└─────────────────────────────────────┘
```

**Update cycle:** Drop new CSVs into `rawdata_new/`, push. GitHub Actions handles the rest. No server to maintain; entire stack runs on free tiers.

---

## Database schema

Eight Postgres tables hold all pre-computed results. The frontend reads directly via Supabase's auto-generated REST API. No custom backend needed.

| Table | Rows | Purpose |
|---|---|---|
| `neighbourhoods` | 140 | Core quadrant data, coordinates, aggregated metrics |
| `monthly_activity` | 4,442 | Neighbourhood × month time-series (review & occupancy) |
| `monthly_totals` | 32 | Citywide monthly aggregates — used by the trend chart |
| `room_type_stats` | 303 | Neighbourhood × room type breakdown |
| `amenity_stats` | 193 | Per-amenity prevalence, rating, and booking proxy |
| `property_type_stats` | 8 | Top 8 property types by supply |
| `leaderboards` | 30 | Pre-ranked top-10 lists for three categories |
| `citywide_medians` | 2 | Reference values that define the quadrant split lines |

Row-level security is enabled on every table with a public-read policy. The pipeline writes via service role key (GitHub Secret); the frontend reads via anon key.

---

## Design decisions worth noting

**Why occupancy instead of price?**
Inside Airbnb removed price data from their public dataset in 2025. Rather than approximate price from third-party sources, I pivoted the quadrant axis to occupancy (estimated nights booked per year), which is arguably a more direct signal of market performance anyway. The quadrant model stays logically coherent. It just answers "who's busy and well-reviewed" instead of "who's expensive and well-reviewed".

**Why compute quadrant medians from neighbourhood aggregates, not raw listings?**
Airbnb's rating system is heavily inflated at the listing level, the citywide median rating across 15,776 listings is 4.9, which would place almost every neighbourhood *below* the median. Instead, the pipeline first aggregates to neighbourhood-level averages, then takes the median of those 140 values (4.81). This produces a balanced four-way split.

**Why a `monthly_totals` pre-aggregation table?**
Supabase's free tier enforces a 1,000-row hard limit per API response. The `monthly_activity` table has 4,442 rows (140 neighbourhoods × 32 months). Fetching it in chunks would require sequential paginated requests, which slows page load and complicates client code. Pre-aggregating to one row per month reduces the payload to 32 rows and makes the frontend code simpler.

**Why keep all computation in Python rather than SQL views?**
The pipeline runs in GitHub Actions, not inside the database. Keeping logic in Python (pandas) makes it easier to test locally, version-control, and reason about without needing a live DB connection. The tradeoff is slightly more code, but the testability is worth it for a project that updates on a push-triggered schedule.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Data source | [Inside Airbnb](http://insideairbnb.com) | Quarterly Toronto scrape, publicly available |
| CI / pipeline trigger | GitHub Actions | Free, push-triggered, no infra to manage |
| Data processing | Python · pandas · numpy | Flexible, readable, easy to run locally |
| Database + API | Supabase (Postgres) | Auto-generated REST API, free tier, RLS built-in |
| Frontend | Vanilla JS · Chart.js · Leaflet | No framework overhead for a single-page viz |
| Hosting | Vercel | Zero-config static deploy from GitHub |

---

## Data

Source: [Inside Airbnb — Toronto](http://insideairbnb.com/toronto)
Snapshot date: January 2026
Listings: 15,776 active | Neighbourhoods: 140 | Reviews: 543,448
