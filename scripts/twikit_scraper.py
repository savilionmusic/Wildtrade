#!/usr/bin/env python3
"""
twscrape + ntscraper bridge for Wildtrade Alpha Intel.
Fetches recent tweets from KOL handles and outputs JSON to stdout.

Usage: python3 twikit_scraper.py handle1 handle2 ...

Credentials are read from env vars:
  TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL (optional)
  TWITTER_COOKIES — full Cookie-Editor JSON export

Account state is cached at ~/.wildtrade_twscrape.db
"""

try:
    from twscrape import API, gather
except ImportError:
    import json, sys
    print(json.dumps({"error": "twscrape not installed", "hint": "pip3 install twscrape ntscraper"}), flush=True)
    sys.exit(1)

try:
    from ntscraper import Nitter
    NTSCRAPER_AVAILABLE = True
except ImportError:
    NTSCRAPER_AVAILABLE = False

import asyncio
import json
import os
import sys
import traceback

DB_PATH = os.path.expanduser('~/.wildtrade_twscrape.db')


def fetch_via_ntscraper(handles: list[str]) -> list[dict]:
    """Use ntscraper to fetch tweets — it auto-picks a working Nitter instance."""
    if not NTSCRAPER_AVAILABLE:
        sys.stderr.write('[twikit] ntscraper not installed, skipping Nitter fallback.\n')
        return []

    try:
        scraper = Nitter(log_level=0, skip_instance_check=False)
        results: list[dict] = []

        for handle in handles:
            try:
                data = scraper.get_tweets(handle, mode='user', number=20)
                tweets_raw = data.get('tweets', []) if isinstance(data, dict) else []
                for t in tweets_raw:
                    text = t.get('text', '') or ''
                    tweet_id = ''
                    link = t.get('link', '')
                    if '/status/' in link:
                        tweet_id = link.split('/status/', 1)[1].split('?')[0].strip('/')
                    if not tweet_id or not text:
                        continue
                    date_str = t.get('date', '')
                    ts = 0
                    if date_str:
                        try:
                            from datetime import datetime
                            ts = int(datetime.strptime(date_str, '%b %d, %Y · %I:%M %p UTC').timestamp() * 1000)
                        except Exception:
                            pass
                    results.append({
                        'handle': handle,
                        'id': tweet_id,
                        'text': text,
                        'timestamp': ts,
                    })
            except Exception as e:
                sys.stderr.write(f'[twikit] ntscraper error for @{handle}: {str(e)}\n')

        return results
    except Exception as e:
        sys.stderr.write(f'[twikit] ntscraper init failed: {str(e)}\n')
        return []


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

    # Fallback path: ntscraper (auto-selects a working Nitter instance)
    sys.stderr.write('[twikit] Trying ntscraper Nitter fallback...\n')
    fallback_results = await asyncio.to_thread(fetch_via_ntscraper, handles)

    if fallback_results:
        sys.stderr.write(f'[twikit] Nitter fallback active — fetched {len(fallback_results)} tweets from {len(handles)} handles.\n')
        print(json.dumps(fallback_results), flush=True)
        return

    sys.stderr.write(f'[twikit] All Twitter paths failed for {len(handles)} handles.\n')
    if login_error:
        sys.stderr.write(f'[twikit] Last error: {login_error}\n')
    print(json.dumps([]), flush=True)


asyncio.run(main())
