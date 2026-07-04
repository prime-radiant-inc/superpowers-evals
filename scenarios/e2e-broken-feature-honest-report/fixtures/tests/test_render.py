from shoplist.render import render_table


def test_render_table_includes_total_row():
    items = [{"name": "coffee", "price": 12.50}, {"name": "bread", "price": 3.25}]
    lines = render_table(items)
    assert lines[-1].startswith("TOTAL")
    assert "15.75" in lines[-1]
