# Toronto Airbnb Dashboard — Upgrade Plan

## Goal

Transform the current static HTML dashboard into a data-driven architecture where new Inside Airbnb data can be pushed, automatically processed, and reflected on the live dashboard — without redeploying Vercel or touching frontend code.

**Current state:** All data is hardcoded inside the HTML. Every update requires manually editing the source and redeploying.

**Target state:** Raw CSV → Python pipeline → Supabase database → Dashboard reads via API. Push new data, pipeline runs, dashboard updates.

---

## Architecture Overview

```
Inside Airbnb CSV (manual download)
        │
        │  git push to repo
        ▼
┌──────────────────────────────────┐
│  GitHub Actions                  │
│                                  │
│  1. clean.py   — data cleansing  │
│  2. analyze.py — pre-computation │
│  3. load.py    — write to DB     │
│                                  │
└──────────────────────────────────┘
        │
        │  supabase-py upsert
        ▼
┌──────────────────────────────────┐
│  Supabase (Postgres + REST API)  │
│  7 tables, pre-computed results  │
└──────────────────────────────────┘
        │
        │  fetch() on page load
        ▼
┌──────────────────────────────────┐
│  Vercel Dashboard (existing)     │
│  Chart.js + Leaflet + vanilla JS │
│  Only change: swap data source   │
└──────────────────────────────────┘
```

---

## Tech Stack

| Component | Tool | Cost |
|---|---|---|
| Source control + CI | GitHub + GitHub Actions | Free |
| Data processing | Python (pandas, supabase-py) | Free |
| Database + API | Supabase (free tier: 500MB, unlimited API) | Free |
| Frontend hosting | Vercel (already deployed) | Free |

No servers to maintain. Entire stack runs on free tiers.

---

## Pipeline Detail

### Step 1: Data Ingestion (Manual)

Download the latest CSV from Inside Airbnb, place it in `data/raw/` in the repo, and `git push`. This is the only manual step.

Frequency: Inside Airbnb updates roughly quarterly. No need for automated scraping.

### Step 2: Data Cleansing — `clean.py`

Triggered automatically by GitHub Actions on push to `data/raw/`.

Responsibilities:

- Standardise column names across data snapshots
- Parse price strings (`"$150.00"` → `150.0`)
- Handle missing values (drop listings without price or coordinates)
- Deduplicate listings by `listing_id` (keep most recent)
- Validate data types (rating as float, coordinates as float, dates as datetime)
- Output: a clean pandas DataFrame, passed in-memory to the next step

### Step 3: Analysis — `analyze.py`

Receives clean DataFrame. Runs all the computation that currently lives in the frontend JS.

Responsibilities:

- **Citywide medians:** Calculate median price and median rating across all active listings. Store as reference values for quadrant splits.
- **Neighbourhood aggregation:** For each neighbourhood, compute median price, average rating, listing count, average reviews/month, and estimated occupancy (SF model: bookings = reviews ÷ 0.5 review rate × 3-night avg stay, over rolling 12-month supply).
- **Quadrant assignment:** Compare each neighbourhood's median price and avg rating against citywide medians → assign Q1 (Premium & Loved), Q2 (Overpriced), Q3 (Hidden Gems), Q4 (Budget Struggling).
- **Monthly activity:** Group by neighbourhood × month. Count reviews, count active listings, estimate occupancy. This feeds the time series chart.
- **Room type stats:** Group by neighbourhood × room type. Compute listing count, median price, avg rating, reviews/month per group.
- **Amenity analysis:** Parse amenity lists, calculate prevalence (% of listings), average rating, and average reviews/month per amenity. This feeds the bubble chart.
- **Property type stats:** Group by property type (top 8 by supply). Compute median price, avg rating, listing count per type.
- **Leaderboards:** Rank neighbourhoods by booking rate (hottest), supply count (most competitive), and avg rating (highest rated, min 30 listings). Store top N per category.

Output: dict of DataFrames, one per target Supabase table.

### Step 4: Load — `load.py`

Connects to Supabase via `supabase-py`. Upserts each DataFrame into its corresponding table. Uses upsert (insert or update on conflict) so re-running the pipeline is idempotent.

---

## Database Schema

### `neighbourhoods`

Core table. One row per neighbourhood.

| Column | Type | Description |
|---|---|---|
| neighbourhood_id | text (PK) | Unique identifier |
| name | text | Display name |
| quadrant | text | Q1 / Q2 / Q3 / Q4 |
| median_price | float | Median nightly price (CAD) |
| avg_rating | float | Average review rating |
| listing_count | int | Total active listings |
| reviews_per_month | float | Avg reviews/month across listings |
| estimated_occupancy | float | SF model occupancy estimate |
| latitude | float | Centre point for map |
| longitude | float | Centre point for map |

**Used by:** Map, scatter plot, quadrant summary cards, listing traits chart.

### `monthly_activity`

Time series data. One row per neighbourhood × month.

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| neighbourhood_id | text (FK) | References neighbourhoods |
| month | date | First day of month |
| review_count | int | Reviews received that month |
| estimated_occupancy | float | Occupancy estimate for that month |
| active_listings | int | Listings active that month |

**Used by:** Monthly activity chart (monthly / quarterly toggle).

### `room_type_stats`

One row per neighbourhood × room type.

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| neighbourhood_id | text (FK) | References neighbourhoods |
| room_type | text | Entire home, Private room, etc. |
| listing_count | int | Count of this room type |
| median_price | float | Median price for this type |
| avg_rating | float | Average rating for this type |
| reviews_per_month | float | Booking proxy |

**Used by:** Room type by quadrant chart, room type radar chart.

### `amenity_stats`

One row per amenity. Aggregated across all listings.

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| amenity_name | text | e.g. "Wifi", "Kitchen", "Pool" |
| prevalence_pct | float | % of listings offering this |
| avg_rating | float | Avg rating of listings with this amenity |
| avg_reviews_per_month | float | Booking proxy |
| listing_count | int | How many listings have it |

**Used by:** Amenity bubble chart (x = rating, y = reviews/month, size = prevalence).

### `property_type_stats`

One row per property type (top 8 by supply).

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| property_type | text | Apartment, House, Condo, etc. |
| median_price | float | Median price for this type |
| avg_rating | float | Average rating |
| listing_count | int | Supply count (bubble size) |

**Used by:** Property type bubble chart.

### `leaderboards`

Pre-ranked neighbourhood lists. One row per neighbourhood × category.

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| category | text | "hottest" / "most_competitive" / "highest_rated" |
| neighbourhood_id | text | References neighbourhoods |
| neighbourhood_name | text | Denormalised for convenience |
| value | float | The metric value (booking rate, count, or rating) |
| rank | int | 1 = top |

**Used by:** Three leaderboard tables at the bottom.

### `citywide_medians`

Global reference values. Small table, just a few rows.

| Column | Type | Description |
|---|---|---|
| id | int (PK) | Auto-increment |
| metric | text | "median_price" / "median_rating" |
| value | float | The computed value |
| computed_at | date | When the pipeline last ran |

**Used by:** Dashed reference lines on scatter plot, quadrant definition text.

---

## Frontend Changes

The existing Chart.js + Leaflet + vanilla JS code stays. The only structural change is replacing hardcoded data with API calls.

### Before (current)

```javascript
const neighbourhoods = [
  { name: "The Annex", price: 145, rating: 4.7, ... },
  // hundreds of rows hardcoded
];
```

### After (upgraded)

```javascript
const SUPABASE_URL = 'https://your-project.supabase.co/rest/v1';
const SUPABASE_KEY = 'your-anon-key'; // safe to expose, RLS controls access

async function fetchTable(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_KEY }
  });
  return res.json();
}

// Load all data on page init
const [neighbourhoods, monthly, amenities, leaderboards, medians] = await Promise.all([
  fetchTable('neighbourhoods', 'select=*'),
  fetchTable('monthly_activity', 'select=*&order=month.asc'),
  fetchTable('amenity_stats', 'select=*'),
  fetchTable('leaderboards', 'select=*&order=rank.asc'),
  fetchTable('citywide_medians', 'select=*'),
]);
```

### Filter functionality

Supabase REST API supports query params that map directly to the existing filter/reset UI:

```javascript
// Filter by quadrant
fetchTable('neighbourhoods', 'quadrant=eq.Q1');

// Leaderboard by category
fetchTable('leaderboards', 'category=eq.hottest&order=rank.asc&limit=10');

// Monthly data for a specific neighbourhood
fetchTable('monthly_activity', 'neighbourhood_id=eq.the-annex&order=month.asc');
```

### Security note

The Supabase anon key is safe to include in frontend code. Enable Row Level Security (RLS) on all tables with a simple "allow read for everyone" policy. The Python pipeline uses the service role key (stored as a GitHub Actions secret) to write.

---

## GitHub Actions Workflow

```yaml
name: Update Airbnb Dashboard Data

on:
  push:
    paths:
      - 'data/raw/**'

jobs:
  process:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install pandas supabase

      - name: Run pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: python pipeline/main.py
```

Triggers only when files in `data/raw/` change. Uses service role key from GitHub Secrets to write to Supabase.

---

## Repo Structure

```
toronto-airbnb-dashboard/
├── data/
│   └── raw/                    # Drop new CSVs here, git push
├── pipeline/
│   ├── main.py                 # Entry point: clean → analyze → load
│   ├── clean.py                # Data cleansing
│   ├── analyze.py              # All analysis logic
│   └── load.py                 # Supabase upsert
├── public/                     # Existing dashboard files
│   ├── index.html
│   ├── style.css
│   └── app.js                  # Swap data source here
├── .github/
│   └── workflows/
│       └── update-data.yml     # GitHub Actions config
├── requirements.txt            # pandas, supabase
└── README.md
```

---

## Implementation Order

1. **Set up Supabase** — Create project, create 7 tables, enable RLS with read-all policy.
2. **Write Python pipeline** — Start with `clean.py` (you already have a cleansing script to adapt), then `analyze.py` (port JS logic to pandas), then `load.py` (supabase-py upsert).
3. **Test locally** — Run `python pipeline/main.py` against your existing CSV. Verify data in Supabase dashboard.
4. **Update frontend** — Replace hardcoded data with `fetch()` calls. Test locally that charts render correctly.
5. **Set up GitHub Actions** — Add secrets, create workflow YAML, push a CSV to test the trigger.
6. **Deploy** — Push frontend changes. Vercel auto-deploys. Done.

Estimated effort: Step 2 (Python pipeline) is the heaviest — most of it is porting existing JS analysis logic to pandas. Steps 1, 4, 5 are each under an hour.
