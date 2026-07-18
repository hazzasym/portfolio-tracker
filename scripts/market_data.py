"""Market-data helpers for instruments that are not available from Yahoo Finance."""

import json
import math
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime


HEADERS = {"User-Agent": "Mozilla/5.0 (portfolio-tracker)"}
KASSET_FUND_URL = (
    "https://www.kasikornasset.com/kasset/en/mutual-fund/"
    "fund-template/Pages/{fund_code}.aspx"
)
MAX_KASSET_NAV_AGE_DAYS = 7


def _kasset_url(fund_code):
    return KASSET_FUND_URL.format(fund_code=urllib.parse.quote(fund_code, safe="-"))


def _parse_kasset_date(value):
    """Convert KAsset's DD/MM/Buddhist-year date to ISO format."""
    day, month, buddhist_year = (int(part) for part in value.split("/"))
    return datetime(buddhist_year - 543, month, day).date().isoformat()


def parse_kasset_nav_history(html):
    """Return {YYYY-MM-DD: NAV} from KAsset's embedded official NAV table."""
    match = re.search(
        r'id=["\']DataPerNavTable_DIV["\'][^>]*>(\[.*?\])</div>',
        html,
        re.DOTALL,
    )
    if not match:
        raise ValueError("KAsset NAV table block not found")

    rows = json.loads(match.group(1))
    history = {}
    for row in rows:
        date_text = row.get("dateFormat")
        nav = row.get("nav")
        if not date_text or nav in (None, "", "N/A"):
            continue
        nav_value = float(str(nav).replace(",", ""))
        if not math.isfinite(nav_value) or nav_value <= 0:
            raise ValueError(f"invalid KAsset NAV value: {nav}")
        history[_parse_kasset_date(date_text)] = nav_value
    if not history:
        raise ValueError("KAsset NAV table contained no usable observations")
    return history


def validate_kasset_nav_freshness(history, today=None, max_age_days=MAX_KASSET_NAV_AGE_DAYS):
    """Reject a cached or truncated official table that is too old for valuation."""
    current_date = today or date.today()
    latest_date = date.fromisoformat(max(history))
    age_days = (current_date - latest_date).days
    if age_days < 0:
        raise ValueError(f"KAsset NAV date {latest_date} is in the future")
    if age_days > max_age_days:
        raise ValueError(
            f"KAsset NAV is stale: latest {latest_date} is {age_days} days old"
        )


def fetch_kasset_nav_history(fund_code, attempts=3):
    """Fetch the official KAsset NAV history for one fund code."""
    url = _kasset_url(fund_code)
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=35) as response:
                html = response.read().decode("utf-8", errors="replace")
            history = parse_kasset_nav_history(html)
            validate_kasset_nav_freshness(history)
            return history
        except Exception as error:  # noqa: BLE001 - retry all transient source failures
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch KAsset NAV for {fund_code}: {last_error}")


def fetch_kasset_nav_quote_from_history(fund_code, history, source_url=None):
    """Build a current quote and normalized history from parsed KAsset NAVs."""
    dates = sorted(history)
    latest_date = dates[-1]
    previous_date = dates[-2] if len(dates) > 1 else latest_date
    quote = {
        "price": history[latest_date],
        "currency": "THB",
        "previousClose": history[previous_date],
        "ok": True,
        "asOf": latest_date,
        "source": source_url or _kasset_url(fund_code),
    }
    return quote, history


def fetch_kasset_nav_quote(fund_code, attempts=3):
    """Fetch the latest official KAsset NAV and previous business-day NAV."""
    url = _kasset_url(fund_code)
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=35) as response:
                html = response.read().decode("utf-8", errors="replace")
            history = parse_kasset_nav_history(html)
            validate_kasset_nav_freshness(history)
            quote, _ = fetch_kasset_nav_quote_from_history(
                fund_code,
                history,
                source_url=url,
            )
            return quote
        except Exception as error:  # noqa: BLE001 - retry all transient source failures
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    return {
        "price": None,
        "currency": "THB",
        "previousClose": None,
        "ok": False,
        "source": url,
        "error": str(last_error),
    }
