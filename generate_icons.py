"""
Generate PNG icons for the Chrome extension.
Run once before loading the extension:

    python generate_icons.py
"""

import struct
import zlib
from pathlib import Path


def make_png(size: int, rgb: tuple) -> bytes:
    """Create a minimal solid-colour PNG (no external deps needed)."""
    r, g, b = rgb

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))

    # Build raw scanlines (filter byte 0x00 per row)
    raw = b"".join(b"\x00" + bytes([r, g, b] * size) for _ in range(size))
    idat = chunk(b"IDAT", zlib.compress(raw, 9))
    iend = chunk(b"IEND", b"")

    return signature + ihdr + idat + iend


def main():
    # ChatGPT brand green
    COLOR = (16, 163, 127)

    icons_dir = Path(__file__).parent / "icons"
    icons_dir.mkdir(exist_ok=True)

    for size in (16, 48, 128):
        path = icons_dir / f"icon{size}.png"
        path.write_bytes(make_png(size, COLOR))
        print(f"  Created {path}")

    print("\nDone! Icons saved to ./icons/")
    print("You can now load the extension in Chrome:")
    print("  chrome://extensions  ->  Load unpacked  ->  select this folder")


if __name__ == "__main__":
    main()
