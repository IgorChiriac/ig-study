"""Ordering is the one place a silent bug just feels like a broken app."""

from __future__ import annotations

from app.ordering import assign_indices, leading_number, natural_key, order_idx


def test_leading_number_reads_common_prefixes() -> None:
    assert leading_number("7. Managing DynamoDB Data") == 7
    assert leading_number("10. Advanced") == 10
    assert leading_number("0. Course Overview") == 0
    assert leading_number("3 - Migrate Data") == 3
    assert leading_number("2) Automate") == 2


def test_leading_number_absent() -> None:
    assert leading_number("Learning Sessions") is None
    assert leading_number("Appendix") is None
    assert leading_number("") is None


def test_ten_sorts_after_nine() -> None:
    names = ["10. Advanced", "9. Basics", "1. Intro"]
    indices = assign_indices(names)
    assert sorted(names, key=lambda n: indices[n]) == ["1. Intro", "9. Basics", "10. Advanced"]


def test_unprefixed_names_land_after_numbered_ones() -> None:
    names = [
        "0. Course Overview",
        "1. Designing Databases",
        "8. Securing DynamoDB",
        "Learning Sessions",
    ]
    indices = assign_indices(names)
    assert indices["0. Course Overview"] == 0
    assert indices["8. Securing DynamoDB"] == 8
    assert indices["Learning Sessions"] == 9


def test_several_unprefixed_names_are_stable_and_alphabetical() -> None:
    indices = assign_indices(["Zebra", "1. One", "Appendix"])
    assert indices["1. One"] == 1
    assert indices["Appendix"] == 2
    assert indices["Zebra"] == 3


def test_adding_a_numbered_module_does_not_renumber_its_siblings() -> None:
    before = assign_indices(["1. Intro", "3. Later"])
    after = assign_indices(["1. Intro", "2. Middle", "3. Later"])
    assert before["1. Intro"] == after["1. Intro"]
    assert before["3. Later"] == after["3. Later"]


def test_order_idx_keeps_modules_apart() -> None:
    assert order_idx(0, 5) < order_idx(1, 0)
    assert order_idx(1, 9) < order_idx(1, 10)


def test_order_idx_clamps_rather_than_colliding() -> None:
    assert order_idx(1, 5000) < order_idx(2, 0)


def test_natural_key_orders_prefixed_before_unprefixed() -> None:
    names = ["Learning Sessions", "10. Ten", "2. Two"]
    assert sorted(names, key=natural_key) == ["2. Two", "10. Ten", "Learning Sessions"]
