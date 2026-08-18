"""The identity rule that decides whether two links are the same page."""

from app.library import url_key


def test_fragment_and_trailing_slash_do_not_make_a_new_page():
    base = "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html"
    assert url_key(base) == url_key(base + "#top")
    assert url_key(base + "/") == url_key(base)


def test_host_case_is_ignored_but_path_case_is_not():
    assert url_key("https://DOCS.aws.com/a") == url_key("https://docs.aws.com/a")
    assert url_key("https://docs.aws.com/A") != url_key("https://docs.aws.com/a")


def test_query_still_identifies_the_page():
    assert url_key("https://d.com/p?v=2") != url_key("https://d.com/p?v=3")
