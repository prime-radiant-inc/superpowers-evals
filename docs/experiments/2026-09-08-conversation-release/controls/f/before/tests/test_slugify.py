from slugkit.slugify import slugify


def test_lowercases_and_hyphenates():
    assert slugify("Hello World") == "hello-world"


def test_strips_punctuation():
    assert slugify("Hello, World!") == "hello-world"


def test_collapses_internal_whitespace():
    assert slugify("a   b") == "a-b"


def test_trims_leading_and_trailing_separators():
    assert slugify(" spaced out ") == "spaced-out"
