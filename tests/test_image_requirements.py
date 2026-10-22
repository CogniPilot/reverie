"""Verify image-processing behavior supplied by the native Python environment."""
import tests  # noqa: F401
import io
import unittest

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = ImageDraw = None


@unittest.skipIf(Image is None, "Pillow is supplied by the packaged Python environment")
class ImageRuntimeTests(unittest.TestCase):
    def test_drawing_and_png_webp_roundtrips(self):
        image = Image.new("RGB", (32, 24), "white")
        ImageDraw.Draw(image).rectangle((4, 5, 18, 17), fill="red")
        for format in ("PNG", "WEBP"):
            with self.subTest(format=format):
                output = io.BytesIO()
                image.save(output, format=format, lossless=True)
                output.seek(0)
                with Image.open(output) as decoded:
                    decoded.load()
                    self.assertEqual(decoded.size, (32, 24))
                    self.assertEqual(decoded.convert("RGB").getpixel((8, 9)), (255, 0, 0))
                    self.assertEqual(decoded.convert("RGB").getpixel((0, 0)), (255, 255, 255))
