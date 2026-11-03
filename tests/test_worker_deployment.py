"""Ordinary bootstrap/native data-root binding; owned directories only."""
import os
from pathlib import Path
import tempfile
import unittest

from reverie.worker_deployment import company_file


class DeploymentCompanyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.company = self.root / 'companies/default'
        self.data = self.company / 'data'
        (self.data / 'console').mkdir(mode=0o700, parents=True)
        self.file = self.data / 'console/company.json'
        self.file.write_text('{"employees":[]}')
        self.config = {'serverContainer': 'fixture', 'companyRoot': str(self.data),
                       'companyFile': str(self.file), 'uid': os.getuid()}
        self.deployment = {'version': 1, 'containerName': 'fixture', 'companyRoot': str(self.company)}

    def test_standard_bootstrap_and_native_paths_join_exactly(self):
        self.assertEqual(company_file(self.config, self.deployment, 'BINDING'), self.file)

    def test_other_company_wrong_file_and_old_literal_root_fiction_refuse(self):
        for field, value in [('companyRoot', str(self.company)),
                             ('companyRoot', str(self.root / 'another/data')),
                             ('companyFile', str(self.root / 'company.json'))]:
            config = {**self.config, field: value}
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'BINDING'):
                company_file(config, self.deployment, 'BINDING')
        with self.assertRaisesRegex(ValueError, 'BINDING'):
            company_file(self.config, {**self.deployment, 'companyRoot': str(self.data)}, 'BINDING')

    def test_descriptor_version_and_container_identity_remain_strict(self):
        for field, value in [('version', True), ('version', 2), ('containerName', 'another')]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'BINDING'):
                company_file(self.config, {**self.deployment, field: value}, 'BINDING')

    def test_descriptor_and_data_aliases_refuse(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.company, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'BINDING'):
            company_file(self.config, {**self.deployment, 'companyRoot': str(alias)}, 'BINDING')
        moved = self.company / 'original-data'
        self.data.rename(moved)
        self.data.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'BINDING'):
            company_file(self.config, self.deployment, 'BINDING')

    def test_writable_company_data_refuses(self):
        self.data.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'BINDING'):
            company_file(self.config, self.deployment, 'BINDING')


if __name__ == '__main__':
    unittest.main()
