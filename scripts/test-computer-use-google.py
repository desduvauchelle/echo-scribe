#!/usr/bin/env python3
"""Regression checks for the real-path acceptance oracle (no network or UI)."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("google_demo", Path(__file__).with_name("computer-use-google.py"))
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def result_state(url="https://www.google.com/search?q=Word"):
    return {"window": "Word - Google Search", "nodes": [
        {"role": "AXWebArea", "url": url},
        {"role": "AXLink", "title": "Microsoft Word", "url": "https://www.microsoft.com/microsoft-365/word"},
    ]}


class GoogleResultTests(unittest.TestCase):
    def test_requires_rendered_result_not_only_navigation(self):
        state = result_state()
        self.assertTrue(demo.is_google_results(state, "Word"))
        state["nodes"].pop()
        self.assertFalse(demo.is_google_results(state, "Word"))

    def test_rejects_wrong_query_or_impostor_host(self):
        self.assertFalse(demo.is_google_results(result_state("https://www.google.com/search?q=Wrong"), "Word"))
        self.assertFalse(demo.is_google_results(result_state("https://google.com.example.org/search?q=Word"), "Word"))

    def test_consent_or_captcha_is_not_success(self):
        for message in ("Our systems have detected unusual traffic", "Before you continue to Google"):
            state = result_state()
            state["nodes"].append({"role": "AXStaticText", "value": message})
            self.assertFalse(demo.is_google_results(state, "Word"))

    def test_google_account_link_is_not_a_search_result(self):
        state = result_state()
        state["nodes"][1]["url"] = "https://accounts.google.com/login"
        self.assertFalse(demo.is_google_results(state, "Word"))


if __name__ == "__main__":
    unittest.main()
