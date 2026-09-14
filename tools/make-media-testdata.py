#!/usr/bin/env python3
"""Regenerates the @vision/media decoder test corpus (roadmap V021).

The committed fixtures under packages/media/src/testdata are produced by an
INDEPENDENT encoder (Pillow) on purpose: a hand-written decoder validated only
against a hand-written encoder can share a mutual misreading of the format and
still pass. Ground-truth pixels are emitted alongside each image so the decoder
is compared against Pillow's output rather than against itself.

This script is a one-time developer tool, not part of `npm run check` or CI:
the fixtures it writes are committed. It needs Python 3 with Pillow.

Usage:  python3 tools/make-media-testdata.py
"""

import json
import zlib
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "packages" / "media" / "src" / "testdata"


def gradient(width: int, height: int) -> Image.Image:
    """A deterministic pattern with movement in all three channels.

    Flat colour would hide chroma-subsampling and IDCT bugs, and pure noise
    would make lossy comparison meaningless. This has real gradients plus a
    hard edge, which is where subsampling errors actually show up.
    """
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            red = (x * 255) // max(width - 1, 1)
            green = (y * 255) // max(height - 1, 1)
            blue = 200 if (x + y) % 7 < 3 else 40
            pixels[x, y] = (red, green, blue)
    return image


def write_truth(name: str, image: Image.Image) -> None:
    rgb = image.convert("RGB")
    width, height = rgb.size
    flat: list[int] = []
    for y in range(height):
        for x in range(width):
            flat.extend(rgb.getpixel((x, y)))
    (OUT / f"{name}.json").write_text(
        json.dumps({"width": width, "height": height, "channels": 3, "pixels": flat}),
        encoding="utf-8",
    )


def save_jpeg(name: str, image: Image.Image, **kwargs) -> None:
    path = OUT / f"{name}.jpg"
    image.save(path, format="JPEG", **kwargs)
    # Ground truth is what Pillow reads back from the ENCODED file, not the
    # pre-encode source: JPEG is lossy, so the source pixels are not what any
    # correct decoder should produce.
    with Image.open(path) as reread:
        write_truth(name, reread)


def save_png(name: str, image: Image.Image, **kwargs) -> None:
    path = OUT / f"{name}.png"
    image.save(path, format="PNG", **kwargs)
    with Image.open(path) as reread:
        write_truth(name, reread)


def write_paeth_fixture() -> None:
    """Builds a PNG that forces the Paeth predictor on every scanline.

    Pillow chooses its own row filters, and for small smooth images it does not
    pick Paeth (type 4) at all — so a corpus built only from `Image.save` leaves
    the trickiest predictor in the decoder completely unexercised. A mutation
    that flipped Paeth's `<=` tie-breaking to `<` survived the whole suite,
    which is what prompted this fixture.

    The residual bytes are deterministic pseudorandom, which matters: over 3072
    filtered bytes the reconstruction reliably hits the cases where the three
    candidate distances tie, and the spec's "prefer left, then above" ordering
    becomes observable. Pillow then decodes the file to supply ground truth.
    """
    width, height = 32, 32
    stride = width * 3

    # Deterministic LCG rather than `random`, so the fixture never drifts.
    state = 0x2545F491
    residuals = bytearray()
    for _ in range(height):
        residuals.append(4)  # filter type: Paeth
        for _ in range(stride):
            state = (state * 1103515245 + 12345) & 0x7FFFFFFF
            residuals.append((state >> 16) & 0xFF)

    ihdr = (
        width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + bytes([8, 2, 0, 0, 0])  # 8-bit, truecolour, no interlace
    )

    def png_chunk(type_bytes: bytes, data: bytes) -> bytes:
        return (
            len(data).to_bytes(4, "big")
            + type_bytes
            + data
            + zlib.crc32(type_bytes + data).to_bytes(4, "big")
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(bytes(residuals), 9))
        + png_chunk(b"IEND", b"")
    )
    path = OUT / "png-paeth-32x32.png"
    path.write_bytes(png)
    with Image.open(path) as reread:
        write_truth("png-paeth-32x32", reread)


# --- Audio containers -----------------------------------------------------
# Hand-built rather than encoded: no ffmpeg is available here, and the decoder
# under test only validates container STRUCTURE (codec identity and duration),
# never audio samples. A minimal well-formed container is therefore exactly the
# right fixture, and hand-building it means the expected duration is known
# rather than inferred.

_OGG_CRC_POLY = 0x04C11DB7


def _ogg_crc(page: bytes) -> int:
    """Ogg's CRC-32: same polynomial as zlib, but unreflected with no final XOR."""
    crc = 0
    for byte in page:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ _OGG_CRC_POLY) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def _ogg_page(payload: bytes, *, header_type: int, granule: int, sequence: int, serial: int = 0x5643_4E31) -> bytes:
    segments = []
    remaining = len(payload)
    while remaining >= 255:
        segments.append(255)
        remaining -= 255
    segments.append(remaining)

    page = bytearray()
    page += b"OggS"
    page += bytes([0, header_type])
    page += granule.to_bytes(8, "little")
    page += serial.to_bytes(4, "little")
    page += sequence.to_bytes(4, "little")
    page += b"\x00\x00\x00\x00"  # checksum placeholder
    page += bytes([len(segments)])
    page += bytes(segments)
    page += payload
    page[22:26] = _ogg_crc(bytes(page)).to_bytes(4, "little")
    return bytes(page)


def _vint(value: int) -> bytes:
    """EBML size encoding: leading-one marker gives the width."""
    for width in range(1, 9):
        limit = (1 << (7 * width)) - 1
        if value < limit:
            raw = value | (1 << (7 * width))
            return raw.to_bytes(width, "big")
    raise ValueError("value too large for an EBML vint")


def _elem(element_id: bytes, content: bytes) -> bytes:
    return element_id + _vint(len(content)) + content


def write_audio_fixtures() -> None:
    import struct

    # Ogg/Opus, two seconds: OpusHead, OpusTags, then one audio page whose
    # granule position (48 kHz for Opus, always) states the length.
    opus_head = (
        b"OpusHead"
        + bytes([1, 1])
        + (312).to_bytes(2, "little")
        + (48000).to_bytes(4, "little")
        + (0).to_bytes(2, "little")
        + bytes([0])
    )
    opus_tags = b"OpusTags" + (6).to_bytes(4, "little") + b"vision" + (0).to_bytes(4, "little")
    ogg = (
        _ogg_page(opus_head, header_type=0x02, granule=0, sequence=0)
        + _ogg_page(opus_tags, header_type=0x00, granule=0, sequence=1)
        + _ogg_page(b"\xfc\xff\xfe", header_type=0x04, granule=48000 * 2, sequence=2)
    )
    (OUT / "audio-opus-2s.ogg").write_bytes(ogg)

    # Same stream with one payload byte flipped: the page CRC must catch it.
    corrupt = bytearray(ogg)
    corrupt[-1] ^= 0xFF
    (OUT / "audio-opus-bad-crc.ogg").write_bytes(bytes(corrupt))
    (OUT / "audio-opus-truncated.ogg").write_bytes(ogg[: len(ogg) // 2])

    # WebM stating a three-second duration.
    ebml = _elem(b"\x1a\x45\xdf\xa3", _elem(b"\x42\x82", b"webm"))
    info_with_duration = _elem(
        b"\x15\x49\xa9\x66",
        _elem(b"\x2a\xd7\xb1", (1_000_000).to_bytes(3, "big"))
        + _elem(b"\x44\x89", struct.pack(">d", 3000.0)),
    )
    (OUT / "audio-webm-3s.webm").write_bytes(ebml + _elem(b"\x18\x53\x80\x67", info_with_duration))

    # WebM with no Duration element: exactly what a browser MediaRecorder
    # produces, and it must probe as valid with an unknown duration.
    info_without_duration = _elem(b"\x15\x49\xa9\x66", _elem(b"\x2a\xd7\xb1", (1_000_000).to_bytes(3, "big")))
    (OUT / "audio-webm-no-duration.webm").write_bytes(
        ebml + _elem(b"\x18\x53\x80\x67", info_without_duration)
    )

    # A WebM claiming an eight-minute recording, over the accepted ceiling.
    info_too_long = _elem(
        b"\x15\x49\xa9\x66",
        _elem(b"\x2a\xd7\xb1", (1_000_000).to_bytes(3, "big"))
        + _elem(b"\x44\x89", struct.pack(">d", 480_000.0)),
    )
    (OUT / "audio-webm-too-long.webm").write_bytes(ebml + _elem(b"\x18\x53\x80\x67", info_too_long))

    # Valid EBML wrapper declaring a DocType this pipeline does not accept.
    (OUT / "audio-webm-wrong-doctype.webm").write_bytes(
        _elem(b"\x1a\x45\xdf\xa3", _elem(b"\x42\x82", b"mkv3d"))
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # --- PNG: lossless, so the decoder must match Pillow exactly -----------
    save_png("png-rgb-8x8", gradient(8, 8))
    save_png("png-rgb-17x9", gradient(17, 9))
    save_png("png-gray-8x8", gradient(8, 8).convert("L"))
    save_png("png-palette-8x8", gradient(8, 8).convert("P", palette=Image.ADAPTIVE, colors=16))

    # Perceptual-hash corpus: the same scene at two resolutions must hash
    # CLOSE, and an inverted scene must hash FAR. Without both directions a
    # perceptual hash test proves nothing — a constant would pass the first.
    #
    # The 32x32 is a RESAMPLE of the 64x64, not the procedural pattern redrawn
    # at a smaller size. gradient()'s (x+y)%7 stripe has a period fixed in
    # pixels, so redrawing it at half scale doubles the stripe frequency
    # relative to the frame and is legitimately a different texture — a
    # perceptual hash is supposed to notice that, so using it as the
    # "same scene" pair would be testing the fixture, not the hash.
    scene = gradient(64, 64)
    save_png("png-scene-64x64", scene)
    scene_small = scene.resize((32, 32), Image.BOX)
    save_png("png-scene-32x32", scene_small)
    inverted = scene_small.copy()
    inverted_pixels = inverted.load()
    for y in range(32):
        for x in range(32):
            r, g, b = inverted_pixels[x, y]
            inverted_pixels[x, y] = (255 - r, 255 - g, 255 - b)
    save_png("png-scene-inverted-32x32", inverted)

    # Brightness/contrast variants: the perceptual hash claims to discard
    # overall brightness (it drops the DC term) and to be indifferent to
    # contrast (it thresholds on the median). Both claims need a fixture.
    #
    # These derive from a DARKENED base so neither transform clamps. That
    # matters: clamping at 255 would alter the AC coefficients too, so a
    # "brightness only" fixture that clips is not actually brightness-only and
    # the test built on it would be unsound.
    save_png("png-tone-base-32x32", scene_small.point(lambda value: int(value * 0.7)))
    save_png("png-tone-brighter-32x32", scene_small.point(lambda value: int(value * 0.7) + 50))
    save_png(
        "png-tone-flatter-32x32",
        scene_small.point(lambda value: 64 + int((int(value * 0.7) - 64) * 0.5)),
    )

    # 16-bit greyscale: the decoder reduces to 8 bits by taking each sample's
    # HIGH byte, which is the standard PNG reduction.
    #
    # Pillow is NOT the ground truth for this one. Its I;16 -> RGB conversion
    # treats the sample as an integer and CLIPS to 0-255 rather than scaling, so
    # a 16-bit value of 8447 becomes 255 instead of 32. Truth is therefore
    # computed here from the known high bytes; the transform is a one-line
    # specification, so hand-computing it is unambiguous.
    sixteen_bit = Image.new("I;16", (8, 8))
    sixteen_bit_pixels = sixteen_bit.load()
    high_bytes: list[int] = []
    for y in range(8):
        for x in range(8):
            # Distinct high and low bytes, so reading the wrong one is visible.
            high, low = x * 32, 255 - y * 8
            sixteen_bit_pixels[x, y] = (high << 8) | low
            high_bytes.extend([high, high, high])
    sixteen_bit.save(OUT / "png-gray16-8x8.png", format="PNG")
    (OUT / "png-gray16-8x8.json").write_text(
        json.dumps({"width": 8, "height": 8, "channels": 3, "pixels": high_bytes}),
        encoding="utf-8",
    )

    write_paeth_fixture()

    rgba = gradient(8, 8).convert("RGBA")
    alpha = rgba.load()
    for y in range(8):
        for x in range(8):
            r, g, b, _ = alpha[x, y]
            alpha[x, y] = (r, g, b, (x * 255) // 7)
    save_png("png-rgba-8x8", rgba)

    # Interlaced PNG is deliberately unsupported and must fail closed. Pillow
    # silently ignores its own `interlace` save option, so the IHDR flag is set
    # by hand and the chunk CRC recomputed. The IDAT is therefore NOT Adam7 —
    # which is fine and deliberate: the decoder refuses on the header flag
    # before it ever inflates, and that refusal is what this fixture tests.
    interlaced = bytearray((OUT / "png-rgb-8x8.png").read_bytes())
    interlaced[28] = 1
    interlaced[29:33] = zlib.crc32(bytes(interlaced[12:29])).to_bytes(4, "big")
    (OUT / "png-interlaced-8x8.png").write_bytes(bytes(interlaced))

    # --- JPEG: lossy, compared within tolerance ----------------------------
    # subsampling 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0
    save_jpeg("jpeg-444-16x16", gradient(16, 16), quality=95, subsampling=0)
    save_jpeg("jpeg-422-16x16", gradient(16, 16), quality=90, subsampling=1)
    save_jpeg("jpeg-420-16x16", gradient(16, 16), quality=90, subsampling=2)
    # Odd dimensions exercise MCU padding: 17x9 at 4:2:0 pads to 24x16.
    save_jpeg("jpeg-420-17x9", gradient(17, 9), quality=90, subsampling=2)
    save_jpeg("jpeg-gray-16x16", gradient(16, 16).convert("L"), quality=90)
    # Restart intervals emit RSTn markers the entropy decoder must resynchronise on.
    save_jpeg("jpeg-restart-32x32", gradient(32, 32), quality=90, subsampling=2, restart_marker_blocks=2)
    # Progressive is deliberately unsupported and must fail closed.
    gradient(16, 16).save(OUT / "jpeg-progressive-16x16.jpg", format="JPEG", progressive=True)

    # EXIF: capture timestamp, orientation and GPS presence (V021 metadata).
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90 CW
    exif[0x010F] = "VisionTest"  # Make
    exif[0x0110] = "FixtureCam"  # Model
    exif[0x8769] = {
        0x9003: "2026:09:09 14:30:05",  # DateTimeOriginal
        0x9291: "42",  # SubsecTimeOriginal
    }
    exif[0x8825] = {
        0x0001: "N",
        0x0002: (16.0, 51.0, 0.0),  # Sangli-ish, synthetic
        0x0003: "E",
        0x0004: (74.0, 34.0, 0.0),
    }
    path = OUT / "jpeg-exif-16x16.jpg"
    gradient(16, 16).save(path, format="JPEG", quality=90, subsampling=2, exif=exif)
    with Image.open(path) as reread:
        write_truth("jpeg-exif-16x16", reread)

    # --- Malformed inputs: every one must be refused, not guessed at -------
    jpeg_bytes = (OUT / "jpeg-420-16x16.jpg").read_bytes()
    (OUT / "jpeg-truncated.jpg").write_bytes(jpeg_bytes[: len(jpeg_bytes) // 2])
    png_bytes = (OUT / "png-rgb-8x8.png").read_bytes()
    (OUT / "png-truncated.png").write_bytes(png_bytes[: len(png_bytes) // 2])
    # Valid PNG header and IHDR, corrupted IDAT CRC.
    corrupt = bytearray(png_bytes)
    corrupt[-6] ^= 0xFF
    (OUT / "png-bad-crc.png").write_bytes(bytes(corrupt))

    write_audio_fixtures()

    written = sorted(p.name for p in OUT.iterdir())
    print(f"wrote {len(written)} files to {OUT}")
    for name in written:
        print(f"  {name}")


if __name__ == "__main__":
    main()
