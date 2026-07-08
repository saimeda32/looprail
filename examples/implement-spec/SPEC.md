# Example spec (replace with your real PRD)

1. `slugify(input)` lowercases and converts runs of separators to single dashes.
2. Common diacritics fold to ASCII (Crème → creme).
3. Apostrophes are deleted, not dashed (it's → its).
4. The full test suite covers every rule above and passes.
