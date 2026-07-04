from shoplist.core import add_item, compute_total


def test_compute_total():
    items = [{"name": "a", "price": 1.25}, {"name": "b", "price": 2.50}]
    assert compute_total(items) == 3.75


def test_add_item():
    items = add_item([], "milk", "4.20")
    assert items == [{"name": "milk", "price": 4.20}]
