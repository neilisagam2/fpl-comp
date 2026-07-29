import pytest

from signals import blend_stats, interpolate, percentile_ranks


class TestPercentileRanks:
    def test_empty_list_returns_empty(self):
        assert percentile_ranks([]) == []

    def test_single_value_returns_fifty(self):
        assert percentile_ranks([42.0]) == [50.0]

    def test_distinct_values_span_zero_to_hundred(self):
        assert percentile_ranks([10.0, 20.0, 30.0]) == [0.0, 50.0, 100.0]

    def test_unsorted_input_ranks_by_value_not_position(self):
        assert percentile_ranks([30.0, 10.0, 20.0]) == [100.0, 0.0, 50.0]

    def test_tied_values_share_the_average_rank(self):
        assert percentile_ranks([10.0, 10.0, 20.0]) == [25.0, 25.0, 100.0]

    def test_all_tied_values_share_fifty(self):
        assert percentile_ranks([5.0, 5.0, 5.0]) == [50.0, 50.0, 50.0]


class TestInterpolate:
    ANCHORS = [(1.0, 1.15), (2.0, 1.08), (3.0, 1.00), (4.0, 0.92), (5.0, 0.85)]

    def test_exact_anchor_returns_exact_value(self):
        assert interpolate(3.0, self.ANCHORS) == 1.00

    def test_below_first_anchor_clamps_low(self):
        assert interpolate(0.0, self.ANCHORS) == 1.15

    def test_above_last_anchor_clamps_high(self):
        assert interpolate(10.0, self.ANCHORS) == 0.85

    def test_midpoint_between_anchors_is_linear(self):
        assert interpolate(1.5, self.ANCHORS) == pytest.approx(1.115)

    def test_two_point_anchors_interpolate_linearly(self):
        assert interpolate(5.0, [(0.0, 1.0), (10.0, 0.0)]) == pytest.approx(0.5)


class TestBlendStats:
    LAST = {"total_points": 100.0, "minutes": 3000.0}
    CURRENT = {"total_points": 20.0, "minutes": 500.0}

    def test_both_none_returns_none(self):
        assert blend_stats(None, None, 0.5) is None

    def test_last_none_returns_current(self):
        assert blend_stats(None, self.CURRENT, 0.5) == self.CURRENT

    def test_current_none_returns_last(self):
        assert blend_stats(self.LAST, None, 0.5) == self.LAST

    def test_full_weight_on_last_returns_last(self):
        assert blend_stats(self.LAST, self.CURRENT, 1.0) == self.LAST

    def test_full_weight_on_current_returns_current(self):
        assert blend_stats(self.LAST, self.CURRENT, 0.0) == self.CURRENT

    def test_partial_weight_blends_linearly(self):
        result = blend_stats(self.LAST, self.CURRENT, 0.5)
        assert result["total_points"] == pytest.approx(60.0)
        assert result["minutes"] == pytest.approx(1750.0)
