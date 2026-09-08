# Read-only platform contracts

- Microsoft DeleteFileW: readonly files fail with ERROR_ACCESS_DENIED; the readonly attribute must be removed before deletion. Open/share failures are separate and are not converted into successful cleanup: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew (remarks60–71, read2026-09-08).
- Python3.13 shutil: onexc receives the failing function, path and exception; exceptions raised by the callback propagate. Its Windows readonly example clears the bit and retries, without swallowing a later error: https://docs.python.org/3.13/library/shutil.html#rmtree-example (read2026-09-08).
- Python3.13 os.chmod: Windows supports the readonly flag through S_IWRITE/S_IREAD; this operation does not grant ACL access: https://docs.python.org/3.13/library/os.html#os.chmod (read2026-09-08).
- Frozen raw source line locators: Git-for-Windows object-file.c705–732 creates0444 loose object temporaries. CPython3.12.3 shutil.py618 onward,3.13.0 line608 onward, and3.14.0 line669 onward all forward unlink failures to onexc. Exact raw-byte hashes and versioned URLs are in SOURCE-PINS.json; web-rendered line offsets were not reused as raw file positions.

These are personally read source/documentation contracts, not results from executing Windows or a deletion probe. The correction deliberately handles a narrower case than the broad Python example: only Windows error5 at os.unlink, a verified owned readonly single-link regular non-reparse leaf, unchanged identity, and one retry.
