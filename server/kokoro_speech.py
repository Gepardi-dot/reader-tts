"""Speakable text for Kokoro. Keep in step with web-next/src/shared/speech/kokoroSpeech.ts."""

from __future__ import annotations

import re

_ONES = (
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
)
_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
_ORDINALS = {
    1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
    6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
    11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth", 15: "fifteenth",
    16: "sixteenth", 17: "seventeenth", 18: "eighteenth", 19: "nineteenth", 20: "twentieth",
    30: "thirtieth", 40: "fortieth", 50: "fiftieth", 60: "sixtieth",
    70: "seventieth", 80: "eightieth", 90: "ninetieth",
}
_DECADES = {
    10: "tens", 20: "twenties", 30: "thirties", 40: "forties",
    50: "fifties", 60: "sixties", 70: "seventies", 80: "eighties", 90: "nineties",
}


def _under100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    ten, one = divmod(n, 10)
    return f"{_TENS[ten]}-{_ONES[one]}" if one else _TENS[ten]


def _under1000(n: int) -> str:
    if n < 100:
        return _under100(n)
    hundreds, rest = divmod(n, 100)
    head = f"{_ONES[hundreds]} hundred"
    return f"{head} {_under100(rest)}" if rest else head


def cardinal_words(n: int) -> str:
    whole = int(n)
    if whole < 1000:
        return _under1000(whole)
    for scale, name in ((1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")):
        if whole >= scale:
            hi, lo = divmod(whole, scale)
            head = f"{cardinal_words(hi)} {name}"
            return f"{head} {cardinal_words(lo)}" if lo else head
    return _under1000(whole)


def year_words(year: int) -> str:
    if year == 2000:
        return "two thousand"
    if 2000 <= year <= 2009:
        return f"two thousand {_under100(year - 2000)}"
    if 2010 <= year <= 2099:
        return f"twenty {_under100(year % 100)}"
    if year == 1000:
        return "one thousand"
    if year % 100 == 0 and 1100 <= year <= 1900:
        return f"{_under100(year // 100)} hundred"
    century, rest = divmod(year, 100)
    century_name = _under100(century)
    if rest == 0:
        return f"{century_name} hundred"
    if rest < 10:
        return f"{century_name} oh {_ONES[rest]}"
    return f"{century_name} {_under100(rest)}"


def _decade_words(year: int) -> str:
    if year == 2000 or 2000 <= year < 2010:
        return "two thousands"
    if 2010 <= year <= 2090:
        return f"twenty {_DECADES.get(year % 100, _under100(year % 100))}"
    rest = year % 100
    century_name = _under100(year // 100)
    if rest == 0:
        return f"{century_name} hundreds"
    return f"{century_name} {_DECADES.get(rest, _under100(rest))}"


def _ordinal_words(n: int) -> str:
    if n in _ORDINALS:
        return _ORDINALS[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        tens *= 10
        if ones and ones in _ORDINALS:
            return f"{_under100(tens)}-{_ORDINALS[ones]}"
    rest = n % 100
    if rest == 0:
        base = cardinal_words(n)
        return f"{base[:-1]}ieth" if base.endswith("y") else f"{base}th"
    return f"{cardinal_words(n - rest)} {_ordinal_words(rest)}"


def _expand_abbreviations(text: str) -> str:
    rules = (
        (r"\bMr\.", "Mister"),
        (r"\bMrs\.", "Missus"),
        (r"\bMs\.", "Miss"),
        (r"\bDr\.", "Doctor"),
        (r"\bProf\.", "Professor"),
        (r"\bJr\.", "Junior"),
        (r"\bSr\.", "Senior"),
        (r"\bvs\.", "versus"),
        (r"\betc\.", "et cetera"),
        (r"\be\.g\.", "for example"),
        (r"\bi\.e\.", "that is"),
    )
    for pattern, replacement in rules:
        flags = re.IGNORECASE if pattern in {r"\bvs\.", r"\betc\.", r"\be\.g\.", r"\bi\.e\."} else 0
        text = re.sub(pattern, replacement, text, flags=flags)
    return text


def _verbalize_numbers(text: str) -> str:
    def money(match: re.Match[str]) -> str:
        symbol = "pound" if match.group(0).startswith("£") else "dollar"
        amount = int(match.group(1).replace(",", ""))
        unit = symbol if amount == 1 else f"{symbol}s"
        frac = match.group(2)
        if not frac:
            return f"{cardinal_words(amount)} {unit}"
        cents = int(frac.ljust(2, "0")[:2])
        coin = ("penny" if cents == 1 else "pence") if symbol == "pound" else ("cent" if cents == 1 else "cents")
        return f"{cardinal_words(amount)} {unit} and {cardinal_words(cents)} {coin}"

    def percent(match: re.Match[str]) -> str:
        amount = cardinal_words(int(match.group(1).replace(",", "")))
        frac = match.group(2)
        if not frac:
            return f"{amount} percent"
        digits = " ".join(_ONES[int(digit)] for digit in frac)
        return f"{amount} point {digits} percent"

    def clock(match: re.Match[str]) -> str:
        hour = int(match.group(1))
        minute = int(match.group(2))
        hour_name = "twelve" if hour == 0 else _under100(hour)
        if minute == 0:
            return f"{hour_name} o'clock"
        if minute < 10:
            return f"{hour_name} oh {_ONES[minute]}"
        return f"{hour_name} {_under100(minute)}"

    def year_span(match: re.Match[str]) -> str:
        return f"{year_words(int(match.group(1)))} to {year_words(int(match.group(2)))}"

    def ordinal(match: re.Match[str]) -> str:
        n = int(match.group(1))
        suffix = match.group(2).lower()
        teen = 11 <= n % 100 <= 13
        expected = "th" if teen else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        if suffix != expected:
            return match.group(0)
        return _ordinal_words(n)

    text = re.sub(r"[$£](\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?", money, text)
    text = re.sub(r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?%", percent, text)
    text = re.sub(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", clock, text)
    text = re.sub(r"\b(1[0-9]{3}|20[0-9]{2})\s*[-–—]\s*(1[0-9]{3}|20[0-9]{2})\b", year_span, text)
    text = re.sub(r"\b((?:1[0-9]|20)[0-9]0)s\b", lambda m: _decade_words(int(m.group(1))), text)
    text = re.sub(r"\b(\d{1,4})(st|nd|rd|th)\b", ordinal, text, flags=re.IGNORECASE)
    text = re.sub(r"\b\d{1,3}(?:,\d{3})+\b", lambda m: cardinal_words(int(m.group(0).replace(",", ""))), text)
    text = re.sub(r"\b(1[0-9]{3}|20[0-9]{2})\b", lambda m: year_words(int(m.group(1))), text)
    text = re.sub(r"\b([2-9]\d{3}|\d{5,6})\b", lambda m: cardinal_words(int(m.group(1))), text)
    text = re.sub(
        r"\b(\d+)\.(\d+)\b",
        lambda m: f"{cardinal_words(int(m.group(1)))} point {' '.join(_ONES[int(d)] for d in m.group(2))}",
        text,
    )
    return text


_ORDINAL_SUFFIX = re.compile(r"^(?:st|nd|rd|th)(?![A-Za-z])", re.IGNORECASE)
_DECADE_SUFFIX = re.compile(r"^s(?![A-Za-z])", re.IGNORECASE)
_DECADE_DIGITS = re.compile(r"^(?:1[0-9]|20)\d0$")
_NUMBER_THEN_WORD = re.compile(r"(\d+)([ \t\n]*)(?=[A-Za-z])")
_LINE_BREAK = re.compile(r"\n+")


def _pause_after_numbers(text: str) -> str:
    """Comma pause when the next word would run straight on from a number."""

    def repl(match: re.Match[str]) -> str:
        digits = match.group(1)
        gap = match.group(2)
        rest = text[match.end() :]
        glued = gap == ""
        if glued and _ORDINAL_SUFFIX.match(rest):
            return match.group(0)
        if glued and _DECADE_SUFFIX.match(rest) and _DECADE_DIGITS.match(digits):
            return match.group(0)
        nxt = rest[0] if rest else ""
        title = (not glued) and ("A" <= nxt <= "Z")
        glued_word = glued and len(rest) >= 2 and rest[0].isalpha() and rest[1].isalpha()
        if not title and not glued_word:
            return match.group(0)
        line_break = _LINE_BREAK.search(gap)
        if line_break:
            return f"{digits},{line_break.group(0)}"
        return f"{digits}, "

    return _NUMBER_THEN_WORD.sub(repl, text)


def _shape_pauses(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    text = text.replace("·", ". ").replace("•", ". ")
    text = re.sub(r"\.{3,}|…+", " … ", text)
    text = re.sub(r"\s*[—–]\s*", " — ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"([^.!?'\"…—])\s*\n\n", r"\1.\n\n", text)
    text = text.replace("\n\n", " — ")
    text = text.replace("\n", " ")
    text = re.sub(r"([.!?])([A-Za-z])", r"\1 \2", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text.strip()


def _quiet_shouting(text: str) -> str:
    return re.sub(r"\b[A-Z]{5,}\b", lambda m: m.group(0)[0] + m.group(0)[1:].lower(), text)


def prepare_kokoro_speech(text: str) -> str:
    if not text:
        return text
    shaped = _shape_pauses(_verbalize_numbers(_pause_after_numbers(_expand_abbreviations(_quiet_shouting(text)))))
    return text if shaped == text else shaped
