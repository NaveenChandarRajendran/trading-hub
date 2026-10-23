from sig_oi import trending_view, votes


def rows(*strengths):
    return [{"time": f"10:{i:02d}", "strengthPct": s, "callChg": 100, "putChg": 50, "netPcr": 0.5} for i, s in enumerate(strengths)]


def test_trending_view_uses_the_rule_threshold_on_the_last_three_rows():
    assert trending_view(rows(-80, -102, -69, 10))["verdict"] == "Bearish"
    assert trending_view(rows(60, 55, 51))["verdict"] == "Bullish"
    assert trending_view(rows(-80, -40, -90))["verdict"] == "Neutral"
    assert trending_view(rows(-80, -90))["verdict"] == "Neutral"  # fewer than 3 rows yet
    assert trending_view([]) is None


def test_votes_counts_the_most_common_verdict():
    b, n = {"verdict": "Bearish"}, {"verdict": "Bullish"}
    assert votes(b, b, b) == "3 of 3 Bearish"
    assert votes(b, n, b) == "2 of 3 Bearish"
    assert votes(b, None, b) == "2 of 2 Bearish"
    assert votes(None, None, None) is None
