"""
load.py — Supabase upsert
Reads SUPABASE_URL and SUPABASE_SERVICE_KEY from environment variables.
"""
import math
import os

import pandas as pd
from supabase import create_client, Client

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

BATCH_SIZE = 500  # max rows per REST request

# Tables with a natural unique key → use upsert (insert or update on conflict)
UPSERT_ON = {
    "neighbourhoods":      "neighbourhood_id",
    "amenity_stats":       "amenity_name",
    "property_type_stats": "property_type",
    "citywide_medians":    "metric",
    "monthly_totals":      "month",
}

# Tables with auto-increment id → delete-all then bulk-insert (simpler & idempotent)
DELETE_INSERT = {"monthly_activity", "room_type_stats", "leaderboards"}

# Load order: tables referenced by FK must come first
LOAD_ORDER = [
    "citywide_medians",
    "neighbourhoods",
    "monthly_activity",
    "monthly_totals",
    "room_type_stats",
    "amenity_stats",
    "property_type_stats",
    "leaderboards",
]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _sanitise(record: dict) -> dict:
    """Replace NaN / inf with None so JSON serialisation never fails."""
    out = {}
    for k, v in record.items():
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            out[k] = None
        elif hasattr(v, "item"):          # numpy scalar → Python native
            out[k] = v.item()
        else:
            out[k] = v
    return out


def _to_records(df: pd.DataFrame) -> list[dict]:
    return [_sanitise(r) for r in df.to_dict(orient="records")]


def _upsert(client: Client, table: str, records: list[dict], on_conflict: str) -> None:
    for i in range(0, len(records), BATCH_SIZE):
        client.table(table).upsert(
            records[i : i + BATCH_SIZE],
            on_conflict=on_conflict,
        ).execute()


def _delete_insert(client: Client, table: str, records: list[dict]) -> None:
    # Wipe existing rows, then insert fresh batch
    client.table(table).delete().neq("id", 0).execute()
    for i in range(0, len(records), BATCH_SIZE):
        client.table(table).insert(records[i : i + BATCH_SIZE]).execute()


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def load_all(tables: dict[str, pd.DataFrame]) -> None:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    client: Client = create_client(url, key)

    for name in LOAD_ORDER:
        if name not in tables:
            print(f"  SKIP {name}: not found in tables dict")
            continue
        df = tables[name]
        if df.empty:
            print(f"  SKIP {name}: empty DataFrame")
            continue

        records = _to_records(df)

        if name in UPSERT_ON:
            _upsert(client, name, records, UPSERT_ON[name])
        else:
            _delete_insert(client, name, records)

        print(f"  OK {name}: {len(records):,} rows loaded")
