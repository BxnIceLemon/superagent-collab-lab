"""Run with: python3 -m unittest discover -s lab/isolation/proxy"""
import unittest

from policy import match

DECOUPLE = ['NL2RepoBench', 'multimodal-art-projection/NL2RepoBench', 'decouple', 'Python-Decouple']


class MatchTest(unittest.TestCase):
    def test_blocks_the_original_project_wherever_it_is_named(self):
        for url in [
            'https://github.com/HBNetwork/python-decouple',
            'https://raw.githubusercontent.com/HBNetwork/python-decouple/master/decouple.py',
            'https://codeload.github.com/HBNetwork/python-decouple/tar.gz/refs/heads/master',
            'https://pypi.org/simple/python-decouple/',
            'https://files.pythonhosted.org/packages/ab/cd/python_decouple-3.8-py3-none-any.whl',
            'https://cdn.jsdelivr.net/gh/HBNetwork/python-decouple/decouple.py',
            'https://html.duckduckgo.com/html/?q=python+decouple+source',
            'https://www.google.com/search?q=python%20decouple',
            'https://github.com/multimodal-art-projection/NL2RepoBench/tree/main/test_files',
            'https://huggingface.co/datasets/someone/nl2repobench',
        ]:
            self.assertIsNotNone(match(url, DECOUPLE), url)

    def test_leaves_other_sources_open(self):
        for url in [
            'https://docs.python.org/3/library/configparser.html',
            'https://pypi.org/simple/pytest/',
            'https://github.com/theskumar/python-dotenv',
            'https://example.com/decoupled-architecture',
        ]:
            self.assertIsNone(match(url, DECOUPLE), url)

    def test_version_suffix_and_joined_words(self):
        self.assertEqual(match('https://pypi.org/simple/jinja2/', ['jinja']), 'jinja')
        self.assertEqual(match('https://github.com/x/moreitertools', ['More-Itertools']), 'More-Itertools')
        self.assertEqual(match('https://pypi.org/project/more-itertools/', ['moreitertools']), 'moreitertools')
        self.assertEqual(match('https://github.com/bradtraversy/vanillawebprojects/blob/master/x', ['bradtraversy/vanillawebprojects']),
                         'bradtraversy/vanillawebprojects')


if __name__ == '__main__':
    unittest.main()
