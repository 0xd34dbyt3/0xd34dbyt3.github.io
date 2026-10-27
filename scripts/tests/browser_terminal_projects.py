"""Focused browser check against a built site or the published Pages origin.

Usage: python scripts/tests/browser_terminal_projects.py http://localhost:8000
Requires the existing optional Playwright environment and Chromium.
"""
import sys

from playwright.sync_api import sync_playwright


def check(origin):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(origin.rstrip('/') + '/projects.html')
        expected = page.locator('#projectsContainer a.project-card').evaluate_all(
            '(cards) => cards.map(c => { const title = c.querySelector(".box-text"); return {title: title.dataset.value || title.textContent, url: c.href}; })')
        page.goto(origin.rstrip('/') + '/')
        page.wait_for_function('document.querySelector("#terminal-projects") !== null')
        terminal = page.locator('#terminalInput')

        def command(value):
            terminal.fill(value)
            terminal.press('Enter')

        command('projects')
        actual = page.locator('#terminalOutput a').evaluate_all(
            '(links) => links.map(a => ({title: a.textContent, url: a.href}))')
        assert actual == expected, (actual, expected)
        assert all('admin-acceptance' not in p['url'] for p in actual)
        if actual:
            with page.expect_navigation():
                page.locator('#terminalOutput a').first.click()
            assert page.locator('#pageTitle').evaluate('(el) => el.dataset.value || el.textContent') == actual[0]['title']
            page.go_back()

        command('clear')
        assert page.locator('#terminalOutput').inner_text() == ''
        command('help')
        assert 'AVAILABLE COMMANDS:' in page.locator('#terminalOutput').inner_text()
        command('whoami')
        assert 'Identity:' in page.locator('#terminalOutput').inner_text()
        command('email')
        assert 'Contact Email:' in page.locator('#terminalOutput').inner_text()
        command('social')
        assert 'OFFICIAL PROFILES:' in page.locator('#terminalOutput').inner_text()
        command('unknown-command')
        assert 'Command not found:' in page.locator('#terminalOutput').inner_text()

        # Change only this browser's DOM to exercise empty and hostile title data.
        page.evaluate('document.querySelector("#terminal-projects").textContent = "[]"')
        command('clear')
        command('projects')
        assert 'No published projects are available.' in page.locator('#terminalOutput').inner_text()
        hostile = '<img src=x onerror="window.terminalXss = true"> & Proje'
        page.evaluate('(title) => { document.querySelector("#terminal-projects").textContent = JSON.stringify([{title, url: "/projects.html"}]); }', hostile)
        command('clear')
        command('projects')
        assert page.locator('#terminalOutput a').inner_text() == hostile
        assert page.locator('#terminalOutput img').count() == 0
        assert page.evaluate('window.terminalXss === undefined')
        browser.close()
        print('PASS terminal/projects parity, order, detail navigation, empty state, safe titles, other commands:', actual)


if __name__ == '__main__':
    check(sys.argv[1])
