"""
clean.py — Data cleansing
Inputs : rawdata_new/listings.csv, rawdata_new/reviews.csv
Outputs: clean listings DataFrame, clean reviews DataFrame
"""
import pandas as pd
from pathlib import Path

REQUIRED_COLS = [
    "id",
    "neighbourhood_cleansed",
    "latitude",
    "longitude",
    "property_type",
    "room_type",
    "review_scores_rating",
    "reviews_per_month",
    "amenities",
    "estimated_occupancy_l365d",
    "number_of_reviews_ltm",
    "number_of_reviews",
]


def _make_slug(series: pd.Series) -> pd.Series:
    """'Rosedale-Moore Park' → 'rosedale-moore-park'"""
    return (
        series.str.strip()
        .str.lower()
        .str.replace(r"\s+", "-", regex=True)
        .str.replace(r"[^a-z0-9\-]", "", regex=True)
    )


def clean_listings(path: Path) -> pd.DataFrame:
    print(f"  Reading listings from {path} ...")
    df = pd.read_csv(path, dtype=str, low_memory=False)

    # Keep only the columns the pipeline needs
    cols = [c for c in REQUIRED_COLS if c in df.columns]
    missing = set(REQUIRED_COLS) - set(cols)
    if missing:
        print(f"  ⚠ Missing optional columns (skipped): {missing}")
    df = df[cols].copy()

    # Parse numeric fields
    df["latitude"]                  = pd.to_numeric(df["latitude"],                  errors="coerce")
    df["longitude"]                 = pd.to_numeric(df["longitude"],                 errors="coerce")
    df["review_scores_rating"]      = pd.to_numeric(df["review_scores_rating"],      errors="coerce")
    df["reviews_per_month"]         = pd.to_numeric(df["reviews_per_month"],         errors="coerce")
    df["estimated_occupancy_l365d"] = pd.to_numeric(df["estimated_occupancy_l365d"], errors="coerce")
    df["number_of_reviews_ltm"]     = pd.to_numeric(df["number_of_reviews_ltm"],     errors="coerce")
    df["number_of_reviews"]         = pd.to_numeric(df["number_of_reviews"],         errors="coerce")

    before = len(df)

    # Drop rows missing coordinates — can't be mapped
    df = df.dropna(subset=["latitude", "longitude"])

    print(f"  Dropped {before - len(df):,} rows (no coords); {len(df):,} kept")

    # Clean neighbourhood name + add slug ID
    df["neighbourhood_cleansed"] = df["neighbourhood_cleansed"].str.strip()
    df["neighbourhood_id"]       = _make_slug(df["neighbourhood_cleansed"])

    return df.reset_index(drop=True)


def clean_reviews(path: Path, listings: pd.DataFrame) -> pd.DataFrame:
    print(f"  Reading reviews from {path} ...")
    reviews = pd.read_csv(path, dtype=str, low_memory=False)

    reviews["listing_id"] = pd.to_numeric(reviews["listing_id"], errors="coerce")
    reviews["date"]       = pd.to_datetime(reviews["date"],       errors="coerce")
    reviews = reviews.dropna(subset=["listing_id", "date"])

    # Attach neighbourhood_id via the listings map
    id_map = listings[["id", "neighbourhood_id"]].copy()
    id_map["id"] = pd.to_numeric(id_map["id"], errors="coerce")

    reviews = reviews.merge(id_map, left_on="listing_id", right_on="id", how="inner")
    print(f"  {len(reviews):,} reviews matched to known listings")

    return reviews[["listing_id", "date", "neighbourhood_id"]].reset_index(drop=True)
