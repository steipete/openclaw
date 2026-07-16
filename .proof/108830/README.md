# OpenClaw Android grapheme-initial proof

Sanitized deterministic Android screenshot-fixture proof for [openclaw/openclaw#108830](https://github.com/openclaw/openclaw/pull/108830).

- Base: `1f3b4e86ca672485725ef8717841df528e9944d3`
- Candidate: `9bcebd2535b948f3f2ea8539f10a7f6294255d09`
- Device: API 36 Android emulator, 1080 x 2424 capture
- Inputs: fixture-only display data set to `👩🏽‍💻 Dev` and `🧭 Profile` on both builds
- Base result: initial badges contain the replacement glyph because a UTF-16 surrogate was split
- Candidate result: full grapheme clusters render in both overview and profile badges

The proof-only fixture input patch was not committed to the product branch. Both builds use the same inputs; only the PR implementation differs.
