import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_prices  # noqa: E402
from fetch_prices import holdings_as_of  # noqa: E402
from market_data import (  # noqa: E402
    parse_kasset_nav_history,
    validate_kasset_nav_freshness,
)


def nav_html(rows):
    return f'<div id="DataPerNavTable_DIV">{json.dumps(rows)}</div>'


class KAssetNavTests(unittest.TestCase):
    def test_parses_buddhist_date_and_nav(self):
        history = parse_kasset_nav_history(nav_html([
            {"dateFormat": "17/07/2569", "nav": "11.9961"},
        ]))
        self.assertEqual(history, {"2026-07-17": 11.9961})

    def test_rejects_non_finite_nav(self):
        with self.assertRaisesRegex(ValueError, "invalid KAsset NAV"):
            parse_kasset_nav_history(
                '<div id="DataPerNavTable_DIV">'
                '[{"dateFormat":"17/07/2569","nav":"NaN"}]</div>'
            )

    def test_rejects_stale_nav(self):
        today = date(2026, 7, 18)
        stale = (today - timedelta(days=8)).isoformat()
        with self.assertRaisesRegex(ValueError, "stale"):
            validate_kasset_nav_freshness({stale: 11.9}, today=today)

    def test_accepts_weekend_carry_forward(self):
        validate_kasset_nav_freshness(
            {"2026-07-17": 11.9961},
            today=date(2026, 7, 18),
        )


class DatedHoldingTests(unittest.TestCase):
    def setUp(self):
        self.portfolio = {
            "holdings": [{
                "ticker": "K-SF-A",
                "symbol": "K-SF-A",
                "market": "TH_FUND",
                "class": "Money Market",
                "targetWeight": 0.1,
                "startsOn": "2026-07-12",
                "buyValueTHB": 10_000_000,
                "replaces": {
                    "ticker": "CASH",
                    "class": "Cash",
                    "valueTHB": 10_000_000,
                },
            }],
        }

    def test_future_replacement_remains_cash(self):
        holdings = holdings_as_of(self.portfolio, "2026-07-11")
        self.assertEqual(holdings[0]["ticker"], "CASH")
        self.assertEqual(holdings[0]["market"], "CASH")

    def test_replacement_activates_on_start_date(self):
        holdings = holdings_as_of(self.portfolio, "2026-07-12")
        self.assertEqual(holdings[0]["ticker"], "K-SF-A")


class IncompleteSnapshotTests(unittest.TestCase):
    def test_failed_fund_quote_does_not_overwrite_history(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portfolio_path = root / "portfolio.json"
            prices_path = root / "prices.json"
            history_path = root / "history.json"
            portfolio = {
                "meta": {
                    "investmentDate": "2026-06-12",
                    "versionDate": "2026-07-12",
                    "version": "round-2",
                    "ozPerBahtWeight": 0.490147,
                },
                "holdings": [{
                    "ticker": "K-SF-A",
                    "symbol": "K-SF-A",
                    "market": "TH_FUND",
                    "class": "Money Market",
                    "targetWeight": 0.1,
                    "startsOn": "2026-07-12",
                    "units": 833583.4083558401,
                    "buyValueTHB": 10_000_000,
                }],
                "watchlist": [],
            }
            existing_history = [{"date": "2026-07-17", "totalValueTHB": 123.45}]
            portfolio_path.write_text(json.dumps(portfolio), encoding="utf-8")
            history_path.write_text(json.dumps(existing_history), encoding="utf-8")
            good_quote = {"price": 1.0, "previousClose": 1.0, "ok": True}
            failed_fund = {"price": None, "previousClose": None, "ok": False}

            with (
                mock.patch.object(fetch_prices, "PORTFOLIO", str(portfolio_path)),
                mock.patch.object(fetch_prices, "PRICES", str(prices_path)),
                mock.patch.object(fetch_prices, "HISTORY", str(history_path)),
                mock.patch.object(fetch_prices, "fetch_quote", return_value=good_quote),
                mock.patch.object(fetch_prices, "fetch_kasset_nav_quote", return_value=failed_fund),
            ):
                fetch_prices.main()

            self.assertEqual(
                json.loads(history_path.read_text(encoding="utf-8")),
                existing_history,
            )
            snapshot = json.loads(prices_path.read_text(encoding="utf-8"))
            self.assertFalse(snapshot["complete"])


if __name__ == "__main__":
    unittest.main()
