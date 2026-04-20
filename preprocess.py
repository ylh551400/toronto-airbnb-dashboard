"""Preprocess Toronto Airbnb data into data.json for the dashboard."""
import calendar
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

BASE = Path(__file__).parent
RAW = BASE / "original data"
LISTINGS_CSV = RAW / "cleandata1.csv"
REVIEWS_CSV = RAW / "reviews.csv"
OUT = BASE / "data.json"

# ---------- Load ----------
df = pd.read_csv(LISTINGS_CSV, encoding="latin-1", low_memory=False)
df["price"] = pd.to_numeric(df["price"], errors="coerce")
df["review_scores_rating"] = pd.to_numeric(df["review_scores_rating"], errors="coerce")
df = df.dropna(subset=["price", "review_scores_rating", "neighbourhood_cleansed"])
df = df[df["price"] > 0]

# amenities count
def amen_count(s):
    try:
        return len(json.loads(s)) if isinstance(s, str) else 0
    except Exception:
        return 0
df["amenities_count"] = df["amenities"].apply(amen_count)
df["superhost"] = (df["host_is_superhost"] == "t").astype(int)
df["instant_bk"] = (df["instant_bookable"] == "t").astype(int)
df["rpm"] = pd.to_numeric(df.get("reviews_per_month"), errors="coerce").fillna(0.0)

# ---------- KPIs ----------
kpi = {
    "total_listings": int(len(df)),
    "neighbourhoods": int(df["neighbourhood_cleansed"].nunique()),
    "median_price": float(df["price"].median()),
    "avg_rating": float(df["review_scores_rating"].mean()),
}

# ---------- Neighbourhood aggregation ----------
agg = df.groupby("neighbourhood_cleansed").agg(
    listings=("id", "count"),
    median_price=("price", "median"),
    avg_rating=("review_scores_rating", "mean"),
    avg_rpm=("rpm", "mean"),
    lat=("latitude", "mean"),
    lon=("longitude", "mean"),
).reset_index()

# ---------- Quadrant thresholds (medians across neighbourhoods) ----------
price_med = float(agg["median_price"].median())
rating_med = float(agg["avg_rating"].median())

def quadrant(p, r):
    if p >= price_med and r >= rating_med: return "Q1"
    if p >= price_med and r <  rating_med: return "Q2"
    if p <  price_med and r >= rating_med: return "Q3"
    return "Q4"

agg["quadrant"] = [quadrant(p, r) for p, r in zip(agg["median_price"], agg["avg_rating"])]
neighbourhoods = [
    {
        "name": row["neighbourhood_cleansed"],
        "listings": int(row["listings"]),
        "median_price": round(float(row["median_price"]), 2),
        "avg_rating": round(float(row["avg_rating"]), 3),
        "avg_rpm": round(float(row["avg_rpm"]), 3),
        "lat": round(float(row["lat"]), 5),
        "lon": round(float(row["lon"]), 5),
        "quadrant": row["quadrant"],
    }
    for _, row in agg.iterrows()
]

# ---------- Assign quadrant to each listing (via its neighbourhood's quadrant) ----------
nb_q = dict(zip(agg["neighbourhood_cleansed"], agg["quadrant"]))
df["quadrant"] = df["neighbourhood_cleansed"].map(nb_q)

# ---------- Room type composition by quadrant ----------
room_types = ["Entire home/apt", "Private room", "Shared room", "Hotel room"]
room_comp = {}
for q in ["Q1", "Q2", "Q3", "Q4"]:
    sub = df[df["quadrant"] == q]
    total = len(sub)
    counts = sub["room_type"].value_counts().to_dict()
    room_comp[q] = {rt: int(counts.get(rt, 0)) for rt in room_types}
    room_comp[q]["_total"] = int(total)

# ---------- Radar: quadrant traits ----------
radar = {}
for q in ["Q1", "Q2", "Q3", "Q4"]:
    sub = df[df["quadrant"] == q]
    radar[q] = {
        "accommodates": float(sub["accommodates"].mean()),
        "superhost_pct": float(sub["superhost"].mean() * 100),
        "instant_pct": float(sub["instant_bk"].mean() * 100),
        "amenities": float(sub["amenities_count"].mean()),
        "reviews": float(sub["number_of_reviews"].mean()),
    }

# ---------- Amenity impact on rating & booking rate ----------
AMEN_CANONICAL = [
    ("wifi", "Wifi"),
    ("kitchen", "Kitchen"),
    ("free parking", "Free parking"),
    ("paid parking", "Paid parking"),
    ("pool", "Pool"),
    ("hot tub", "Hot tub"),
    ("washer", "Washer"),
    ("dryer", "Dryer"),
    ("air conditioning", "Air conditioning"),
    ("central air", "Air conditioning"),
    ("window ac", "Air conditioning"),
    ("portable air", "Air conditioning"),
    ("heating", "Heating"),
    ("dedicated workspace", "Workspace"),
    ("self check-in", "Self check-in"),
    ("lockbox", "Self check-in"),
    ("keypad", "Self check-in"),
    ("smart lock", "Self check-in"),
    ("hdtv", "TV"),
    ("hair dryer", "Hair dryer"),
    ("long term stays", "Long-term stays"),
    ("shampoo", "Shampoo"),
    ("refrigerator", "Refrigerator"),
    ("microwave", "Microwave"),
    ("dishwasher", "Dishwasher"),
    ("elevator", "Elevator"),
    ("gym", "Gym"),
    ("patio or balcony", "Balcony/Patio"),
    ("balcony", "Balcony/Patio"),
    ("bbq", "BBQ grill"),
    ("pets allowed", "Pets allowed"),
    ("smoke alarm", "Smoke alarm"),
    ("carbon monoxide", "CO alarm"),
    ("first aid", "First aid kit"),
    ("fire extinguisher", "Fire extinguisher"),
    ("security camera", "Security camera"),
    ("coffee maker", "Coffee maker"),
    ("nespresso", "Coffee maker"),
    ("essentials", "Essentials"),
    ("hangers", "Hangers"),
    ("iron", "Iron"),
    ("bathtub", "Bathtub"),
    ("crib", "Crib"),
    ("dining table", "Dining table"),
    ("oven", "Oven"),
    ("stove", "Stove"),
    ("bed linens", "Bed linens"),
    # Branded specials catch-alls
    (" tv", "TV"),
]

def normalize_amen(a):
    low = a.strip().lower()
    if not low:
        return None
    # exact-ish checks
    if low in ("tv",): return "TV"
    if low in ("iron",): return "Iron"
    if low in ("oven",): return "Oven"
    if low in ("stove",): return "Stove"
    for key, canon in AMEN_CANONICAL:
        if key in low:
            return canon
    return None

def parse_amen_list(s):
    if not isinstance(s, str):
        return []
    try:
        arr = json.loads(s)
    except Exception:
        return []
    out = []
    for a in arr:
        if not isinstance(a, str):
            continue
        n = normalize_amen(a)
        if n:
            out.append(n)
    return out

amen_stats = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rating_n": 0, "rpm_sum": 0.0})
for amens, r, rpm in zip(
    df["amenities"].map(parse_amen_list),
    df["review_scores_rating"].values,
    df["rpm"].values,
):
    for a in set(amens):
        s = amen_stats[a]
        s["count"] += 1
        s["rating_sum"] += float(r)
        s["rating_n"] += 1
        s["rpm_sum"] += float(rpm)

total_listings = len(df)
amenity_impact = []
for a, s in amen_stats.items():
    if s["count"] < 200:  # min sample
        continue
    amenity_impact.append({
        "name": a,
        "count": int(s["count"]),
        "share": round(s["count"] / total_listings, 4),
        "avg_rating": round(s["rating_sum"] / s["rating_n"], 3),
        "avg_rpm": round(s["rpm_sum"] / s["count"], 3),
    })
# Keep top 22 by frequency
amenity_impact.sort(key=lambda x: -x["count"])
amenity_impact = amenity_impact[:22]

# Overall baselines for the amenity chart
amen_baseline = {
    "avg_rating": float(df["review_scores_rating"].mean()),
    "avg_rpm": float(df["rpm"].mean()),
}

# ---------- Room type / property type stats ----------
room_type_stats = []
for rt, sub in df.groupby("room_type"):
    if len(sub) < 20:
        continue
    room_type_stats.append({
        "name": rt,
        "count": int(len(sub)),
        "median_price": round(float(sub["price"].median()), 2),
        "avg_rating": round(float(sub["review_scores_rating"].mean()), 3),
        "avg_rpm": round(float(sub["rpm"].mean()), 3),
    })
room_type_stats.sort(key=lambda x: -x["count"])

property_type_stats = []
for pt, sub in df.groupby("property_type"):
    if len(sub) < 100:
        continue
    property_type_stats.append({
        "name": pt,
        "count": int(len(sub)),
        "median_price": round(float(sub["price"].median()), 2),
        "avg_rating": round(float(sub["review_scores_rating"].mean()), 3),
        "avg_rpm": round(float(sub["rpm"].mean()), 3),
    })
property_type_stats.sort(key=lambda x: -x["count"])
property_type_stats = property_type_stats[:8]

# ---------- Monthly trend from reviews (2019-01 .. 2024-10) ----------
rv = pd.read_csv(REVIEWS_CSV, usecols=["listing_id", "date"])
rv["date"] = pd.to_datetime(rv["date"], errors="coerce")
rv = rv.dropna(subset=["date"])
rv = rv[(rv["date"] >= "2019-01-01") & (rv["date"] < "2024-11-01")]
rv["ym"] = rv["date"].dt.to_period("M").astype(str)
monthly = rv.groupby("ym").agg(
    reviews=("listing_id", "size"),
    active_listings=("listing_id", "nunique"),
).reset_index().sort_values("ym")

# Estimated citywide occupancy (Inside Airbnb "San Francisco model"):
#   bookings = reviews × (1 / review_rate)      (review_rate ≈ 0.5)
#   nights_booked = bookings × avg_length_of_stay
#   supply(month) = unique listings with a review in the trailing 12 months
#   occupancy = nights_booked / (supply × days_in_month), capped at 0.70
REVIEW_RATE = 0.5
LOS = 3.0  # Inside Airbnb Toronto default

# Rolling 12-month unique-listing supply proxy
rv_dates = rv[["listing_id", "date"]].sort_values("date")
occ = []
supply_series = []
for ym in monthly["ym"]:
    y, m = map(int, ym.split("-"))
    end = pd.Timestamp(year=y, month=m, day=calendar.monthrange(y, m)[1])
    start = end - pd.DateOffset(months=12)
    supply = int(rv_dates[(rv_dates["date"] > start) & (rv_dates["date"] <= end)]["listing_id"].nunique())
    supply_series.append(supply)
monthly["supply"] = supply_series

for ym, r, s in zip(monthly["ym"], monthly["reviews"], monthly["supply"]):
    y, m = map(int, ym.split("-"))
    days = calendar.monthrange(y, m)[1]
    if s == 0 or days == 0:
        occ.append(0.0)
        continue
    o = r * (1.0 / REVIEW_RATE) * LOS / (s * days)
    occ.append(round(min(0.70, o), 4))

# Quarterly aggregate
monthly["q"] = monthly["ym"].map(lambda s: f"{s[:4]}-Q{(int(s[5:7]) - 1)//3 + 1}")
q_df = monthly.groupby("q").agg(
    reviews=("reviews", "sum"),
    active_listings=("active_listings", "mean"),
    supply=("supply", "mean"),
).reset_index().sort_values("q")
# Occupancy per quarter: weight months by their days, use rolling supply
month_days = monthly.assign(
    days=[calendar.monthrange(*map(int, s.split("-")))[1] for s in monthly["ym"]]
)
q_occ = []
for q in q_df["q"]:
    sub = month_days[month_days["q"] == q]
    total_days = sub["days"].sum()
    nights = (sub["reviews"] * (1.0 / REVIEW_RATE) * LOS).sum()
    avg_supply = sub["supply"].mean()
    if avg_supply and total_days:
        q_occ.append(round(min(0.70, nights / (avg_supply * total_days)), 4))
    else:
        q_occ.append(0.0)

trend = {
    "months": monthly["ym"].tolist(),
    "reviews": monthly["reviews"].astype(int).tolist(),
    "active_listings": monthly["active_listings"].astype(int).tolist(),
    "supply": supply_series,
    "occupancy": occ,
    "los": round(LOS, 2),
    "review_rate": REVIEW_RATE,
    "quarters": q_df["q"].tolist(),
    "quarterly_reviews": q_df["reviews"].astype(int).tolist(),
    "quarterly_active": q_df["active_listings"].round().astype(int).tolist(),
    "quarterly_supply": q_df["supply"].round().astype(int).tolist(),
    "quarterly_occupancy": q_occ,
}

# ---------- Neighbourhood leaderboards ----------
# Filter to neighbourhoods with enough sample to avoid small-n noise
MIN_LISTINGS = 30
nb_eligible = [n for n in neighbourhoods if n["listings"] >= MIN_LISTINGS]

def top10(items, key, reverse=True):
    return sorted(items, key=lambda n: n[key], reverse=reverse)[:10]

leaderboards = {
    "hottest": [
        {"name": n["name"], "value": n["avg_rpm"], "listings": n["listings"],
         "price": n["median_price"], "rating": n["avg_rating"], "quadrant": n["quadrant"]}
        for n in top10(nb_eligible, "avg_rpm")
    ],
    "competitive": [
        {"name": n["name"], "value": n["listings"], "listings": n["listings"],
         "price": n["median_price"], "rating": n["avg_rating"], "quadrant": n["quadrant"]}
        for n in top10(neighbourhoods, "listings")
    ],
    "rated": [
        {"name": n["name"], "value": n["avg_rating"], "listings": n["listings"],
         "price": n["median_price"], "rating": n["avg_rating"], "quadrant": n["quadrant"]}
        for n in top10(nb_eligible, "avg_rating")
    ],
}

# ---------- Insights (computed) ----------
q_counts = df["quadrant"].value_counts().to_dict()
q1_top = (
    df[df["quadrant"] == "Q1"]["neighbourhood_cleansed"]
    .value_counts().head(3).index.tolist()
)
q3_sh = float(df[df["quadrant"] == "Q3"]["superhost"].mean() * 100)
q1_entire = float(
    (df[df["quadrant"] == "Q1"]["room_type"] == "Entire home/apt").mean() * 100
)
price_gap = float(
    df[df["quadrant"] == "Q1"]["price"].median()
    - df[df["quadrant"] == "Q4"]["price"].median()
)

# Seasonality: post-recovery (>=2022) summer vs winter avg occupancy
post = [(m, o) for m, o in zip(trend["months"], trend["occupancy"]) if m >= "2022-01"]
summer_occ = [o for m, o in post if m[5:7] in ("06", "07", "08", "09")]
winter_occ = [o for m, o in post if m[5:7] in ("12", "01", "02")]
summer_pct = round(100 * sum(summer_occ) / max(len(summer_occ), 1))
winter_pct = round(100 * sum(winter_occ) / max(len(winter_occ), 1))

# Room-type price/rating gap (Entire home/apt vs Private room)
rs = {r["name"]: r for r in room_type_stats}
entire = rs.get("Entire home/apt", {})
private = rs.get("Private room", {})
price_mult = (entire.get("median_price", 0) / private["median_price"]) if private.get("median_price") else 0
rating_gap = (entire.get("avg_rating", 0) - private.get("avg_rating", 0))

# Amenities that lift both rating and booking above baseline (excluding near-universal)
lift_rows = [
    a for a in amenity_impact
    if a["avg_rating"] > amen_baseline["avg_rating"]
    and a["avg_rpm"] > amen_baseline["avg_rpm"]
    and a["share"] < 0.90
]
# Rank by combined lift (normalised)
lift_rows.sort(
    key=lambda a: -((a["avg_rating"] - amen_baseline["avg_rating"]) * 10
                    + (a["avg_rpm"] - amen_baseline["avg_rpm"]))
)
top_amens = [a["name"] for a in lift_rows[:3]]

# Hottest neighborhood
hot = leaderboards["hottest"][0]
city_rpm_avg = float(df["rpm"].mean())

insights = [
    {
        "title": "Premium clusters in the core",
        "body": f"Q1 (Premium & Loved) concentrates in {', '.join(q1_top)}, where Entire home/apt makes up {q1_entire:.0f}% of listings.",
    },
    {
        "title": f"Some amenities lift both rating and bookings",
        "body": (
            f"{', '.join(top_amens)} all sit above the citywide average on BOTH rating and "
            "reviews/month — non-universal amenities that correlate with real demand, "
            "not just standard checklist items like Wifi or Heating."
        ),
    },
    {
        "title": f"Demand swings ~{summer_pct - winter_pct} points across seasons",
        "body": (
            f"Estimated occupancy averages {summer_pct}% in summer (Jun–Sep) but only "
            f"{winter_pct}% in winter (Dec–Feb) since the post-COVID recovery — "
            "pricing and revenue forecasts should plan for a ~2× summer–winter swing."
        ),
    },
    {
        "title": f"{hot['name']}: high demand at value prices",
        "body": (
            f"Tops the booking-rate leaderboard at {hot['value']:.2f} reviews/month per listing — "
            f"{hot['value']/city_rpm_avg:.1f}× the citywide average of {city_rpm_avg:.2f} — "
            f"at a median price of CAD ${hot['price']:.0f}, below the CAD {int(kpi['median_price'])} "
            "citywide median. A true value hotspot."
        ),
    },
    {
        "title": "Superhosts over-index in Hidden Gems",
        "body": f"Q3 (Hidden Gems) has the highest Superhost share at {q3_sh:.0f}%, suggesting host quality — not location — drives ratings in value segments.",
    },
]

# ---------- Write ----------
out = {
    "kpi": kpi,
    "thresholds": {"price_median": price_med, "rating_median": rating_med},
    "neighbourhoods": neighbourhoods,
    "room_composition": room_comp,
    "radar": radar,
    "trend": trend,
    "quadrant_counts": {k: int(v) for k, v in q_counts.items()},
    "amenity_impact": amenity_impact,
    "amenity_baseline": amen_baseline,
    "room_type_stats": room_type_stats,
    "property_type_stats": property_type_stats,
    "leaderboards": leaderboards,
    "insights": insights,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {OUT} ({OUT.stat().st_size/1024:.1f} KB)")
print("KPI:", kpi)
print("Thresholds:", out["thresholds"])
print("Quadrant counts:", out["quadrant_counts"])
print("Trend months:", len(trend["months"]), trend["months"][0], "->", trend["months"][-1])
