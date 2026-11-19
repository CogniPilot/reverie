"""Closed startup facts for historical website records."""
from pathlib import Path
import unittest

from reverie.website_service_auth import config_path, web_arguments, WEB


class ServiceAuthStartupTests(unittest.TestCase):
    def test_guest_path_and_closed_web_options(self):
        selected = '/run/private-services/service-auth.json'
        self.assertEqual(config_path(selected), selected)
        self.assertEqual(web_arguments([*WEB, '--service-auth-config', selected]), selected)
        self.assertIsNone(web_arguments(WEB))
        for value in (None, Path(selected), '', '/', '//auth/file', '/auth/../file',
                      '/auth/./file', '/auth//file', '/auth/file/', '/auth/\nfile', '/' + 'a' * 4096):
            with self.subTest(value=value), self.assertRaises(ValueError):config_path(value)
        for tail in (['--service-auth-config'], ['--service-auth-config=' + selected],
                     ['--service-auth-config', selected, '--service-auth-config', selected],
                     ['--unknown'], ['--resource-replacement', '--service-auth-config', selected]):
            with self.subTest(tail=tail), self.assertRaises(ValueError):web_arguments([*WEB, *tail])
