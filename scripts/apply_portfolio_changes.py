#!/usr/bin/env python3
"""Apply dated holding replacements to existing daily portfolio history.

This migration is idempotent and recomputes already-tagged points when official
prices, units, or the migration logic change. It preserves pre-change values
while recasting each post-change point with the replacement holding's official
price history.
"""

import json
import os

from market_data import fetch_kasset_nav_history


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTFOLIO = os.path.join(ROOT, "portfolio.json")
HISTORY = os.path.join(ROOT, "history.json")


def latest_value_on_or_before(series, date):
    eligible = [series_date for series_date in series if series_date <= date]
    if not eligible:
        raise ValueError(f"no price available on or before {date}")
    return series[max(eligible)]


def main():
    with open(PORTFOLIO, "r", encoding="utf-8") as file:
        portfolio = json.load(file)
    with open(HISTORY, "r", encoding="utf-8") as file:
        history = json.load(file)

    version = portfolio["meta"].get("version")
    version_date = portfolio["meta"].get("versionDate")
    changes = [
        holding for holding in portfolio["holdings"]
        if holding.get("replaces") and holding.get("startsOn") == version_date
    ]
    if not changes:
        raise ValueError(f"no dated replacements found for {version} on {version_date}")
    fund_history = {}
    for holding in changes:
        if holding["market"] != "TH_FUND":
            raise ValueError(f"unsupported dated replacement market: {holding['market']}")
        fund_history[holding["symbol"]] = fetch_kasset_nav_history(holding["symbol"])

    updated = 0
    for point in history:
        applicable = [holding for holding in changes if point["date"] >= holding["startsOn"]]
        if not applicable:
            point.setdefault("portfolioVersion", "round-1")
            continue

        for holding in applicable:
            replacement = holding["replaces"]
            nav = latest_value_on_or_before(fund_history[holding["symbol"]], point["date"])
            new_value = round(nav * holding["units"], 2)
            adjustment_key = f"{replacement['ticker']}->{holding['ticker']}"
            adjustments = point.setdefault("portfolioAdjustments", {})
            previous_adjustment = adjustments.get(adjustment_key)
            by_class = point.setdefault("byClass", {})

            old_class = replacement.get("class", "Cash")
            if previous_adjustment:
                prior_value = previous_adjustment["valueTHB"]
                delta = new_value - prior_value
                point["totalValueTHB"] = round(point["totalValueTHB"] + delta, 2)
                by_class[holding["class"]] = round(
                    by_class.get(holding["class"], 0.0) + delta,
                    2,
                )
            elif point.get("portfolioVersion") == version:
                # Adopt history written by the original migration. This is safe
                # only when the replacement is the sole holding in its class.
                same_class = [
                    h for h in portfolio["holdings"]
                    if h.get("class") == holding["class"] and h["ticker"] != holding["ticker"]
                ]
                if same_class:
                    raise ValueError(
                        f"cannot infer prior {holding['class']} adjustment for {point['date']}"
                    )
                prior_value = by_class.get(holding["class"], 0.0)
                delta = new_value - prior_value
                point["totalValueTHB"] = round(point["totalValueTHB"] + delta, 2)
                by_class[holding["class"]] = new_value
            else:
                old_value = replacement["valueTHB"]
                point["totalValueTHB"] = round(
                    point["totalValueTHB"] - old_value + new_value,
                    2,
                )
                old_class_value = round(by_class.get(old_class, 0.0) - old_value, 2)
                if abs(old_class_value) < 0.01:
                    by_class.pop(old_class, None)
                else:
                    by_class[old_class] = old_class_value
                by_class[holding["class"]] = round(
                    by_class.get(holding["class"], 0.0) + new_value,
                    2,
                )

            adjustments[adjustment_key] = {
                "valueTHB": new_value,
                "priceTHB": nav,
            }

        point["portfolioVersion"] = version
        updated += 1

    with open(HISTORY, "w", encoding="utf-8") as file:
        json.dump(history, file, ensure_ascii=False, indent=2)
    print(f"Applied {version} to {updated} historical points")


if __name__ == "__main__":
    main()
