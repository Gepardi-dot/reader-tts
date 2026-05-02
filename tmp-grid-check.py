"""Compare backend Python grid chunker against a JS-style mirror to verify byte-for-byte alignment."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from server.app import _chunk_text_for_presynth

# Mirror of the JS algorithm written in pure Python (no Python-only shortcuts)
def js_mirror(text: str, grid_size: int = 420):
    min_size = max(1, int(grid_size * 0.5))
    max_size = int(grid_size * 1.4)
    grid = []
    pos = 0
    while pos < len(text):
        end = min(pos + grid_size, len(text))
        if end < len(text):
            search_start = pos + min_size
            search_end = min(pos + max_size, len(text))
            boundary = -1
            for i in range(search_end - 1, search_start - 1, -1):
                ch = text[i]
                if ch in ".!?":
                    nxt = text[i + 1] if i + 1 < len(text) else " "
                    if nxt.isspace():
                        boundary = i + 2
                        break
            if 0 < boundary <= len(text):
                end = boundary
            elif not text[end].isspace():
                ws_idx = text.rfind(" ", 0, end)  # JS lastIndexOf(' ', end) — searches whole string ≤ end
                if ws_idx > pos:
                    end = ws_idx + 1
        if text[pos:end].strip():
            grid.append((pos, end))
        pos = max(end, pos + 1)
    return grid

# Use a varied real-world text snippet
TEXT = (
    "This is the first sentence. This is the second sentence! "
    "Is this a third? "
    "And here we have a paragraph that runs on for quite a while without any short sentence "
    "breaks at all so the chunker has to handle the case where it can't find a sentence "
    "boundary inside the lookahead window and has to fall back to a word boundary or even a "
    "hard cut in the middle of a long stretch of prose like this one which keeps going. "
    "Short. Words. Here. " * 30
    + "Final sentence to wrap up the test text and verify the tail behavior is correct."
) * 3

py = [(c["start"], c["end"]) for c in _chunk_text_for_presynth(TEXT, 420)]
js = js_mirror(TEXT, 420)

print(f"Text length: {len(TEXT)}")
print(f"Py chunks: {len(py)}, JS-mirror chunks: {len(js)}")
match = py == js
print(f"Identical: {match}")
if not match:
    for i, (p, j) in enumerate(zip(py, js)):
        if p != j:
            print(f"  diff at {i}: py={p} js={j}")
            print(f"    py text: {TEXT[p[0]:p[1]]!r}")
            print(f"    js text: {TEXT[j[0]:j[1]]!r}")
            break
    if len(py) != len(js):
        print(f"  length differs: py={len(py)} js={len(js)}")

# Quality check: count how many chunks end on a sentence boundary
import re
sentence_end = sum(1 for s, e in py if e == len(TEXT) or re.match(r"[.!?]\s", TEXT[e-2:e]))
print(f"Chunks ending at sentence boundary: {sentence_end} / {len(py)}")

# Show first few chunks
for i, (s, e) in enumerate(py[:6]):
    print(f"  [{i}] {s}..{e} ({e-s} chars): ...{TEXT[max(s, e-40):e]!r}")
