from shoplist.core import compute_total


def render_table(items):
    """Render items as aligned rows, ending with a TOTAL row."""
    width = max([len(i["name"]) for i in items] + [len("TOTAL")])
    lines = [f"{i['name']:<{width}}  {i['price']:>8.2f}" for i in items]
    lines.append("-" * (width + 10))
    lines.append(f"{'TOTAL':<{width}}  {compute_total(items):>8.2f}")
    return lines
