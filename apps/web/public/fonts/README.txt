GeistPixel-Circle.woff2 is expected here and is NOT in this repository.

It is the *fallback* display face only. The primary display font,
BubbledotICG-FinePos, is loaded from OnlineWebFonts in the document head, so
the headline and stat glyphs render correctly without this file — the stack is:

    "BubbledotICG-FinePos", "Geist Pixel Circle", monospace

Drop the .woff2 in beside this note and it becomes the second step of that
stack automatically; the @font-face rule in styles.css already points at it.
No code change is needed.

It was left out rather than substituted because shipping a different font under
this name would make the stack silently untrue.
