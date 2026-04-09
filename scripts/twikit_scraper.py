#!/usr/bin/env python3
"""
twscrape + RSS bridge for Wildtrade Alpha Intel.
Fetches recent tweets from KOL handles and outputs JSON to stdout.

Usage: python3 twikit_scraper.py handle1 handle2 ...

Credentials are read from env vars:
  TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL (optional)

Account state is cached at ~/.wildtrade_twscrape.db
"""

try:
    from twscrape import API, gather
except ImportError:
    import json, sys
    print(json.dumps({"error": "twscrape not installed", "hint": "pip3 install twscrape"}), flush=True)
    sys.exit(1)

import asyncio
import json
import os
import sys
import traceback
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

DB_PATH = os.path.expanduser('~/.wildtrade_twscrape.db')
NITTER_INSTANCES = [
    'https://nitter.poast.org',
    'https://nitter.privacydev.net',
    'https://nitter.space',
    'https://nitter.1d4.us',
    'https://nitter.kavin.rocks',
    'https://nitter.unixfox.eu',
    'https://nitter.net',
]
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def parse_rss_date(raw: str) -> int:
    try:
        dt = parsedate_to_datetime(raw)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def extract_tweet_id(link: str) -> str:
    if '/status/' not in link:
        return ''
    tail = link.split('/status/', 1)[1]
    tail = tail.split('?', 1)[0].split('#', 1)[0]
    return tail.strip('/')


def fetch_nitter_rss(handle: str) -> tuple[list[dict], str | None]:
    last_error: str | None = None
    quoted = urllib.parse.quote(handle)

    for base in NITTER_INSTANCES:
        url = f"{base.rstrip('/')}/{quoted}/rss"
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml_bytes = resp.read()

            root = ET.fromstring(xml_bytes)
            items = root.findall('./channel/item')
            tweets: list[dict] = []

            for item in items[:20]:
                title = (item.findtext('title') or '').strip()
                if not title:
                    continue

                prefix = f'{handle}: '
                if title.lower().startswith(prefix.lower()):
                    title = title[len(prefix):]

                link = (item.findtext('link') or '').strip()
                guid = (item.findtext('guid') or '').strip()
                tweet_id = extract_tweet_id(link) or extract_tweet_id(guid)
                if not tweet_id:
                    continue

                timestamp = parse_rss_date((item.findtext('pubDate') or '').strip())

                tweets.append({
                    'handle': handle,
                    'id': tweet_id,
                    'text': title,
                    'timestamp': timestamp,
                })

            if tweets:
                return tweets, None

            last_error = f'No RSS items from {base}'
        except Exception as e:
            last_error = f'{base}: {str(e)}'

    return [], last_error


async def main() -> None:
    handles = [h.lstrip('@').strip() for h in sys.argv[1:] if h.strip()]

    if not handles:
        print(json.dumps([]), flush=True)
        return

    username = os.environ.get('TWITTER_USERNAME', '').lstrip('@').strip()
    password = os.environ.get('TWITTER_PASSWORD', '').strip()
    email = os.environ.get('TWITTER_EMAIL', '').strip()
    cookies_raw = os.environ.get('TWITTER_COOKIES', '').strip()

    login_error: str | None = None

    # Primary path: cookie-based twscrape session (no login attempt needed).
    if cookies_raw:
        try:
            cookies_list = json.loads(cookies_raw)
            # Build a cookie jar dict — accept both {key,value} and {name,value} formats
            cookie_dict: dict[str, str] = {}
            if isinstance(cookies_list, list):
                for c in cookies_list:
                    name = c.get('name') or c.get('key') or ''
                    value = c.get('value', '')
                    if name and value:
                        cookie_dict[name] = value
            elif isinstance(cookies_list, dict):
                cookie_dict = cookies_list

            if 'auth_token' in cookie_dict and 'ct0' in cookie_dict:
                api = API(DB_PATH)

                # Inject cookie-based account into twscrape pool
                # twscrape add_account accepts cookies dict via cookies kwarg
                acct_username = username or 'cookie_session'
                try:
                    await api.pool.add_account(
                        acct_username,
                        password or 'unused',
                        email or f'{acct_username}@example.com',
                        password or 'unused',
                        cookies=cookie_dict,
                    )
                except Exception as add_err:
                    if 'UNIQUE constraint failed' not in str(add_err):
                        raise

                results: list[dict] = []
                for handle in handles:
                    try:
                        user = await api.user_by_login(handle)
                        if not user:
                            continue
                        tweets = await gather(api.user_tweets(user.id, limit=20))
                        for tweet in tweets:
                            text = getattr(tweet, 'rawContent', None) or ''
                            if not text:
                                continue
                            ts = 0
                            try:
                                ts = int(tweet.date.timestamp() * 1000)
                            except Exception:
                                pass
                            results.append({
                                'handle': handle,
                                'id': str(tweet.id),
                                'text': text,
                                'timestamp': ts,
                            })
                    except Exception as e:
                        sys.stderr.write(f'[twikit] Error for @{handle}: {str(e)}\n')

                if results:
                    print(json.dumps(results), flush=True)
                    return
                # If we got no results but no hard crash, fall through to RSS
            else:
                sys.stderr.write('[twikit] TWITTER_COOKIES missing auth_token or ct0 — skipping cookie auth.\n')
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f'[twikit] Cookie auth exception:\n{tb}\n')
            login_error = f'{type(e).__name__}: {str(e)}'
    if username and password:
        try:
            api = API(DB_PATH)

            # Add account if missing; ignore duplicate inserts.
            try:
                await api.pool.add_account(username, password, email or username, password)
            except Exception as add_err:
                if 'UNIQUE constraint failed' not in str(add_err):
                    raise

            accts = await api.pool.get_all()
            active = any(getattr(a, 'active', False) for a in accts)

            if not active:
                sys.stderr.write(f'[twikit] Logging in as @{username}...\n')
                await api.pool.login_all()
                accts = await api.pool.get_all()
                active = any(getattr(a, 'active', False) for a in accts)
                if not active:
                    raise RuntimeError('account not active after login attempt')
                sys.stderr.write('[twikit] Login successful.\n')

            results: list[dict] = []
            for handle in handles:
                try:
                    user = await api.user_by_login(handle)
                    if not user:
                        continue

                    tweets = await gather(api.user_tweets(user.id, limit=20))

                    for tweet in tweets:
                        text = getattr(tweet, 'rawContent', None) or ''
                        if not text:
                            continue

                        ts = 0
                        try:
                            ts = int(tweet.date.timestamp() * 1000)
                        except Exception:
                            pass

                        results.append({
                            'handle': handle,
                            'id': str(tweet.id),
                            'text': text,
                            'timestamp': ts,
                        })
                except Exception as e:
                    sys.stderr.write(f'[twikit] Error for @{handle}: {str(e)}\n')

            if results:
                print(json.dumps(results), flush=True)
                return
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f'[twikit] Login exception:\n{tb}\n')
            login_error = f'{type(e).__name__}: {str(e)}'

    # Fallback path: no-login RSS mode via Nitter mirrors.
    sys.stderr.write('[twikit] Falling back to Nitter RSS (no-login mode)...\n')
    
    async def fetch_rss(handle: str):
        tweets, err = await asyncio.to_thread(fetch_nitter_rss, handle)
        if err:
            sys.stderr.write(f'[twikit] Nitter error for @{handle}: {err}\n')
        return tweets or []

    results_list = await asyncio.gather(*(fetch_rss(h) for h in handles))
    fallback_results: list[dict] = [t for sublist in results_list for t in sublist]

    if fallback_results:
        sys.stderr.write(f'[twikit] Nitter RSS fallback active — fetched {len(fallback_results)} tweets from {len(handles)} handles.\n')
        print(json.dumps(fallback_results), flush=True)
        return

    sys.stderr.write(f'[twikit] All Nitter instances failed for {len(handles)} handles. No Twitter data available.\n')
    if login_error:
        sys.stderr.write(f'[twikit] Login error was: {login_error}\n')
    print(json.dumps([]), flush=True)


asyncio.run(main())
