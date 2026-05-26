"""
analyze.py — Pre-computation
Receives clean DataFrames, returns a dict of output DataFrames
(one per Supabase table).
"""
import ast
import json
import math

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_amenities(raw) -> list:
    """Parse Airbnb amenities field (JSON or Python repr) into a list."""
    if not isinstance(raw, str) or raw.strip() in ("", "[]"):
        return []
    try:
        return json.loads(raw)
    except Exception:
        pass
    try:
        return ast.literal_eval(raw)
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def analyze(listings: pd.DataFrame, reviews: pd.DataFrame) -> dict:
    tables = {}

    # Build neighbourhood aggregates first (without quadrant),
    # then derive citywide medians from those neighbourhood-level values.
    # This avoids Airbnb's listing-level rating inflation pushing the
    # median above almost every neighbourhood's avg rating.
    nbhd_raw = _neighbourhood_aggregates(listings)
    med_occupancy = float(nbhd_raw["median_occupancy"].median())
    med_rating    = float(nbhd_raw["avg_rating"].median())

    tables["citywide_medians"]    = _citywide_medians_from_nbhd(med_occupancy, med_rating)
    tables["neighbourhoods"]      = _assign_quadrants(nbhd_raw, med_occupancy, med_rating)
    tables["monthly_activity"]    = _monthly_activity(reviews, listings)
    tables["monthly_totals"]      = _monthly_totals(tables["monthly_activity"])
    tables["room_type_stats"]     = _room_type_stats(listings)
    tables["amenity_stats"]       = _amenity_stats(listings)
    tables["property_type_stats"] = _property_type_stats(listings)
    tables["leaderboards"]        = _leaderboards(tables["neighbourhoods"])

    return tables


# ─────────────────────────────────────────────────────────────────────────────
# Individual computations
# ─────────────────────────────────────────────────────────────────────────────

def _citywide_medians_from_nbhd(med_occupancy: float, med_rating: float) -> pd.DataFrame:
    """Citywide medians computed from neighbourhood-level aggregates (not raw listings).
    This prevents Airbnb's rating inflation from pushing the cut point above
    almost every neighbourhood's average.
    """
    today = str(pd.Timestamp.today().date())
    return pd.DataFrame([
        {"metric": "median_occupancy", "value": round(med_occupancy, 4), "computed_at": today},
        {"metric": "median_rating",    "value": round(med_rating,    4), "computed_at": today},
    ])


def _neighbourhood_aggregates(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate listings to neighbourhood level (no quadrant yet)."""
    grp = df.groupby(["neighbourhood_id", "neighbourhood_cleansed"])
    agg = grp.agg(
        median_occupancy    =("estimated_occupancy_l365d", "median"),
        avg_rating          =("review_scores_rating",      "mean"),
        listing_count       =("id",                        "count"),
        reviews_per_month   =("reviews_per_month",         "mean"),
        estimated_occupancy =("estimated_occupancy_l365d", "mean"),
        latitude            =("latitude",                  "mean"),
        longitude           =("longitude",                 "mean"),
    ).reset_index().rename(columns={"neighbourhood_cleansed": "name"})
    return agg


def _assign_quadrants(agg: pd.DataFrame, med_occupancy: float, med_rating: float) -> pd.DataFrame:
    """Assign Q1–Q4 based on neighbourhood-level medians, then round and return."""
    agg = agg.copy()

    # Q1 = 明星 (Star)       : occupancy >= median AND rating >= median
    # Q2 = 走量 (Volume)     : occupancy >= median AND rating <  median
    # Q3 = 潜力 (Hidden Gem) : occupancy <  median AND rating >= median
    # Q4 = 挣扎 (Struggling) : occupancy <  median AND rating <  median
    ho = agg["median_occupancy"] >= med_occupancy
    hr = agg["avg_rating"]       >= med_rating
    agg["quadrant"] = np.select(
        [ho & hr, ho & ~hr, ~ho & hr, ~ho & ~hr],
        ["Q1",    "Q2",     "Q3",      "Q4"],
        default="Q4",
    )

    for col in ["median_occupancy", "avg_rating", "reviews_per_month",
                "estimated_occupancy", "latitude", "longitude"]:
        agg[col] = agg[col].round(4)

    return agg[[
        "neighbourhood_id", "name", "quadrant",
        "median_occupancy", "avg_rating", "listing_count",
        "reviews_per_month", "estimated_occupancy",
        "latitude", "longitude",
    ]]


def _monthly_activity(reviews: pd.DataFrame, listings: pd.DataFrame) -> pd.DataFrame:
    r = reviews.copy()
    r["month"] = r["date"].dt.to_period("M").dt.to_timestamp()

    agg = (
        r.groupby(["neighbourhood_id", "month"])
        .agg(
            review_count    =("listing_id", "count"),
            active_listings =("listing_id", "nunique"),
        )
        .reset_index()
    )

    # Occupancy proxy: active listings this month / total listings in neighbourhood
    total = listings.groupby("neighbourhood_id")["id"].count().rename("total_listings")
    agg   = agg.merge(total, on="neighbourhood_id", how="left")
    agg["estimated_occupancy"] = (
        agg["active_listings"] / agg["total_listings"]
    ).round(4)
    agg.drop(columns=["total_listings"], inplace=True)

    # Limit to last 36 months to keep the table manageable
    cutoff = pd.Timestamp.today().floor("D") - pd.DateOffset(months=36)
    agg    = agg[agg["month"] >= cutoff]

    agg["month"] = agg["month"].dt.strftime("%Y-%m-%d")
    return agg.reset_index(drop=True)


def _room_type_stats(df: pd.DataFrame) -> pd.DataFrame:
    agg = (
        df.groupby(["neighbourhood_id", "room_type"])
        .agg(
            listing_count    =("id",                        "count"),
            median_occupancy =("estimated_occupancy_l365d", "median"),
            avg_rating       =("review_scores_rating",      "mean"),
            reviews_per_month=("reviews_per_month",         "mean"),
        )
        .reset_index()
    )
    for col in ["median_occupancy", "avg_rating", "reviews_per_month"]:
        agg[col] = agg[col].round(4)
    return agg


def _amenity_stats(df: pd.DataFrame) -> pd.DataFrame:
    total_listings = len(df)
    work = df[["id", "review_scores_rating", "reviews_per_month", "amenities"]].copy()
    work["amenity_list"] = work["amenities"].apply(_parse_amenities)

    exploded = work.explode("amenity_list").rename(columns={"amenity_list": "amenity_name"})
    exploded = exploded[
        exploded["amenity_name"].notna()
        & (exploded["amenity_name"].str.strip() != "")
    ].copy()
    exploded["amenity_name"] = exploded["amenity_name"].str.strip()

    agg = (
        exploded.groupby("amenity_name")
        .agg(
            listing_count        =("id",                   "nunique"),
            avg_rating           =("review_scores_rating", "mean"),
            avg_reviews_per_month=("reviews_per_month",    "mean"),
        )
        .reset_index()
    )
    agg["prevalence_pct"] = (agg["listing_count"] / total_listings * 100).round(2)
    for col in ["avg_rating", "avg_reviews_per_month"]:
        agg[col] = agg[col].round(4)

    # Keep amenities present in at least 1 % of listings
    agg = agg[agg["prevalence_pct"] >= 1.0].sort_values(
        "prevalence_pct", ascending=False
    ).reset_index(drop=True)

    return agg[["amenity_name", "prevalence_pct", "avg_rating",
                "avg_reviews_per_month", "listing_count"]]


def _property_type_stats(df: pd.DataFrame) -> pd.DataFrame:
    agg = (
        df.groupby("property_type")
        .agg(
            listing_count   =("id",                        "count"),
            median_occupancy=("estimated_occupancy_l365d", "median"),
            avg_rating      =("review_scores_rating",      "mean"),
        )
        .reset_index()
        .nlargest(8, "listing_count")
        .reset_index(drop=True)
    )
    agg["median_occupancy"] = agg["median_occupancy"].round(2)
    agg["avg_rating"]       = agg["avg_rating"].round(4)
    return agg[["property_type", "median_occupancy", "avg_rating", "listing_count"]]


def _monthly_totals(monthly: pd.DataFrame) -> pd.DataFrame:
    """Citywide monthly aggregates — one row per month, used by the trend chart."""
    agg = (
        monthly.groupby("month")
        .agg(
            total_review_count   =("review_count",         "sum"),
            total_active_listings=("active_listings",      "sum"),
            avg_occupancy        =("estimated_occupancy",  "mean"),
        )
        .reset_index()
    )
    agg["avg_occupancy"] = agg["avg_occupancy"].round(4)
    return agg.sort_values("month").reset_index(drop=True)


def _leaderboards(neighbourhoods: pd.DataFrame) -> pd.DataFrame:
    rows = []

    def _add(category, subset, value_col):
        for rank, (_, r) in enumerate(subset.iterrows(), start=1):
            rows.append({
                "category":           category,
                "neighbourhood_id":   r["neighbourhood_id"],
                "neighbourhood_name": r["name"],
                "value":              round(float(r[value_col]), 4),
                "rank":               rank,
            })

    # Hottest: most reviews per month (booking proxy)
    _add("hottest",
         neighbourhoods.nlargest(10, "reviews_per_month"),
         "reviews_per_month")

    # Most competitive: largest supply
    _add("most_competitive",
         neighbourhoods.nlargest(10, "listing_count"),
         "listing_count")

    # Highest rated: min 30 listings
    eligible = neighbourhoods[neighbourhoods["listing_count"] >= 30]
    _add("highest_rated",
         eligible.nlargest(10, "avg_rating"),
         "avg_rating")

    return pd.DataFrame(rows)
