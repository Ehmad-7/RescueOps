"""Inventory domain logic."""
import json
from pathlib import Path


def load_items(path: Path, max_items: int) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    return items[:max_items]


def total_value(items: list[dict]) -> float:
    return round(sum(item["qty"] * item["price"] for item in items), 2)
