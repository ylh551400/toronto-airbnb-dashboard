"""
main.py — Pipeline entry point
Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python pipeline/main.py

Or locally with a .env file:
    pip install python-dotenv
    python pipeline/main.py   (dotenv loaded automatically if present)
"""
import sys
from pathlib import Path

# Ensure pipeline/ is importable regardless of where you call this from
sys.path.insert(0, str(Path(__file__).parent))

# Optional: load a local .env for development convenience
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
    print("  (loaded .env)")
except ImportError:
    pass  # python-dotenv not installed — rely on real env vars

from clean   import clean_listings, clean_reviews
from analyze import analyze
from load    import load_all

RAW_DIR      = Path(__file__).parent.parent / "rawdata_new"
LISTINGS_CSV = RAW_DIR / "listings.csv"
REVIEWS_CSV  = RAW_DIR / "reviews.csv"


def main() -> None:
    # ── 1. Clean ──────────────────────────────────────────────────────────────
    print("\n=== Step 1: Clean ===")
    listings = clean_listings(LISTINGS_CSV)
    reviews  = clean_reviews(REVIEWS_CSV, listings)
    print(f"  listings : {len(listings):,} rows")
    print(f"  reviews  : {len(reviews):,} rows")

    # ── 2. Analyse ────────────────────────────────────────────────────────────
    print("\n=== Step 2: Analyse ===")
    tables = analyze(listings, reviews)
    for name, df in tables.items():
        print(f"  {name:<25} {len(df):>6,} rows")

    # ── 3. Load ───────────────────────────────────────────────────────────────
    print("\n=== Step 3: Load ===")
    load_all(tables)

    print("\nPipeline complete.")


if __name__ == "__main__":
    main()
