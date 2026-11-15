"""The network policy of isolated benchmark runs, as a mitmproxy addon.

The agent container sits on an internal Docker network whose only way out is
this proxy. Model APIs are tunnelled without decryption. Every other request
is decrypted and refused when its URL names one of the task's original
projects: the benchmark repositories themselves, and the upstream project a
task was taken from (its repository, packages, mirrors and web pages). The
rest of the web stays open for research. Every request is logged, refused or
not, so a run can be audited afterwards for sources the rules missed.

A rule is a phrase such as "python decouple" or "bradtraversy/vanillawebprojects".
A URL matches when, after percent-decoding and lowercasing, some run of
adjacent words in it (runs of letters and digits) spells the phrase's words
joined, whatever separates them: "python decouple" matches python-decouple,
python_decouple and pythondecouple, but not decoupled. A version suffix of
digits is allowed ("jinja" matches jinja2).
"""
import json
import os
import re
import time
from urllib.parse import unquote_plus

WORD = re.compile(r'[a-z0-9]+')
# The most URL words one phrase can span.
MAX_WINDOW = 6


def words(text: str) -> list:
    return WORD.findall(unquote_plus(unquote_plus(text)).lower())


def match(url: str, phrases: list) -> str | None:
    """The first phrase the URL names, or None."""
    found = words(url)
    for phrase in phrases:
        joined = ''.join(words(phrase))
        if not joined:
            continue
        for i in range(len(found)):
            run = ''
            for w in found[i:i + MAX_WINDOW]:
                run += w
                if run == joined or (run.startswith(joined) and run[len(joined):].isdigit()):
                    return phrase
                if not joined.startswith(run):
                    break
    return None


class Policy:
    def __init__(self, rules_path: str, log_path: str):
        with open(rules_path, encoding='utf-8') as f:
            rules = json.load(f)
        self.phrases = [p for p in rules['blocked']]
        self.log = open(log_path, 'a', encoding='utf-8', buffering=1)

    def write(self, entry: dict) -> None:
        self.log.write(json.dumps({'t': round(time.time(), 3), **entry}) + '\n')

    def http_connect(self, flow) -> None:
        # Tunnels the proxy passes through undecrypted (model APIs) are seen only here.
        self.write({'kind': 'connect', 'host': flow.request.host, 'port': flow.request.port})

    def request(self, flow) -> None:
        url = flow.request.pretty_url
        phrase = match(url, self.phrases)
        if phrase is None:
            return
        from mitmproxy import http
        flow.response = http.Response.make(
            403,
            f'Refused by the lab network policy: this URL names "{phrase}", an original source of the benchmark task.\n',
            {'content-type': 'text/plain; charset=utf-8'},
        )
        flow.metadata['lab_blocked'] = phrase
        self.write({'kind': 'request', 'method': flow.request.method, 'url': url, 'blocked': phrase})

    def response(self, flow) -> None:
        if 'lab_blocked' not in flow.metadata:
            self.write({'kind': 'request', 'method': flow.request.method, 'url': flow.request.pretty_url, 'status': flow.response.status_code})

    def error(self, flow) -> None:
        if flow.request is not None:
            self.write({'kind': 'request', 'method': flow.request.method, 'url': flow.request.pretty_url, 'error': str(flow.error)})


# mitmdump loads this file with the rules and log paths in the environment; tests import match() only.
addons = [Policy(os.environ['LAB_PROXY_RULES'], os.environ['LAB_PROXY_LOG'])] if 'LAB_PROXY_RULES' in os.environ else []
